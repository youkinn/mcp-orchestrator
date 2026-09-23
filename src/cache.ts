// feat-A013：三国演义问答语义缓存（编排侧判定 / LRU / 落库）
// 契约：接口文档 mcp-orchestrator/api/feat-A013-query-cache.md §1（缓存层契约）与 §2.4（落库点总览）。
// 本文件只做编排侧判定与 LRU 逻辑：embedding 经 transport.callInternal('sango_query_embed') 获取（§1.2 步骤 1、
// §1.7.2「三不原则」由 transport 保证）；cache_logs / cache_entries 镜像全部经 LogStore 公开方法同步直写（§2.4）。
import { NOVEL_NO_HIT_ANSWER, type ChatData } from "./citation.js";
import type { ToolCallResult } from "./types.js";

/** 语义判定内部工具名（接口文档 §1.7.1）：mcp-server 本期新增的轻量工具，模型不可见 */
export const SANGO_QUERY_EMBED_TOOL = "sango_query_embed";

/** 答案产物版本（§1.6）：语料 / 提示词 / 路由相关版本变更时递增，
 * lookup 发现条目 versionTag ≠ 本常量 → 全量清除一次 + console.warn，防命中旧答案 */
export const CACHE_VERSION = "A013-2026-09-23-1";

/** 相似度分区下沿（§1.3）：0.80 本期固定写死、不对外配置（调整另立课题） */
export const LOW_SIMILARITY_LINE = 0.8;

/** 默认命中线（§1.3）：CACHE_HIT_LINE env 默认值，启动配置项，运行时不可改 */
export const DEFAULT_HIT_LINE = 0.92;

/** 默认缓存上限（§1.5）：CACHE_MAX_ENTRIES env 默认值（保守起步，实测后上调至 ≤ 1000） */
export const DEFAULT_MAX_ENTRIES = 500;

/** embedding 维度与字节口径（§1.1 / §3.5）：1024 维 × 4B = 4096 */
export const EMBEDDING_DIM = 1024;
export const EMBEDDING_BYTES = EMBEDDING_DIM * 4;

/** 概览近似口径结构常数（§3.6）：每条约 256 B（进程 heap 无法逐条归属，后台标注「近似」） */
export const ENTRY_STRUCTURE_BYTES = 256;

/** 4 位小数口径（§1.2 / §3.9，A009 展示口径同款）：全精度计算，落库 / 回传按此取整 */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** cosine 全精度计算（§1.2 步骤 2）；向量为 L2 归一化（mcp-server 保证），零向量退化为 0 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 焦点类（§1.2.1）：词表为文档常量，实现照抄 */
type FocusClass = "chapter" | "process";

const FOCUS_CLASSES: ReadonlyArray<{ cls: FocusClass; words: readonly string[] }> = [
  {
    cls: "chapter",
    words: [
      "是哪一回",
      "第几回",
      "哪一回",
      "哪一回目",
      "第多少回",
      "多少回",
      "回目",
      "第几章",
      "哪章",
      "下一回",
      "上一回",
      "这一回",
      "那一回",
    ],
  },
  {
    cls: "process",
    words: [
      "是怎么回事",
      "经过",
      "过程",
      "为什么",
      "为何",
      "怎么样",
      "怎样",
      "怎么",
      "如何",
      "缘由",
      "原因",
      "结局",
      "下场",
      "然后",
      "后来",
    ],
  },
];

/** 按词条长度降序匹配、命中即停（§1.2.1）；一个 query 可命中多类 */
const FOCUS_WORDS_BY_CLASS: ReadonlyArray<{ cls: FocusClass; words: readonly string[] }> =
  FOCUS_CLASSES.map(({ cls, words }) => ({
    cls,
    words: [...words].sort((a, b) => b.length - a.length),
  }));

/** 提取某个 query 命中的焦点类集合（可为空） */
function extractFocusClasses(query: string): Set<FocusClass> {
  const found = new Set<FocusClass>();
  for (const { cls, words } of FOCUS_WORDS_BY_CLASS) {
    for (const word of words) {
      if (query.includes(word)) {
        found.add(cls);
        break; // 命中即停
      }
    }
  }
  return found;
}

/** 焦点一致性轻校验（§1.2.1 拒判条件）：F(A) 非空且 F(B) 非空且 F(A) ∩ F(B) == ∅ → 拒判
 * 单边无焦点 → 放行（靠相似度阈值判定） */
function focusClassesDisjoint(a: string, b: string): boolean {
  const fa = extractFocusClasses(a);
  const fb = extractFocusClasses(b);
  if (fa.size === 0 || fb.size === 0) {
    return false;
  }
  for (const cls of fa) {
    if (fb.has(cls)) {
      return false;
    }
  }
  return true;
}

/** 深拷贝（命中返回 / 写入池内不共享引用，防调用方改动污染池子） */
function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** answerBytes 口径（§1.1 / §2.1）：Buffer.byteLength(JSON.stringify(答案对象), 'utf8') */
function answerBytesOf(data: ChatData): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}

/** embedding（Float32Array 1024）base64（little-endian，与 mcp-server 出参 §1.7.1 同口径） */
function embeddingToBase64(embedding: Float32Array): string {
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength
  ).toString("base64");
}

/** 解析 sango_query_embed 成功出参（§1.7.1）：{ dim: 1024, encoding: "base64-float32-le", data: "<base64>" }；
 * 出参非法 / 编码不符 / 长度不足 → 返回 null（降级旁路，等同 embed 失败） */
function decodeEmbedding(text: string): Float32Array | null {
  try {
    const parsed = JSON.parse(text) as {
      dim?: number;
      encoding?: string;
      data?: string;
    };
    if (
      parsed?.dim !== EMBEDDING_DIM ||
      parsed?.encoding !== "base64-float32-le" ||
      typeof parsed?.data !== "string"
    ) {
      return null;
    }
    const buf = Buffer.from(parsed.data, "base64");
    if (buf.byteLength < EMBEDDING_BYTES) {
      return null;
    }
    const vec = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      vec[i] = buf.readFloatLE(i * 4); // little-endian 显式按字节序解码，不依赖平台字节序
    }
    return vec;
  } catch {
    return null;
  }
}

/** 环境变量读取：CACHE_ENABLED 初始开关（默认开）；解析失败按默认（与配置项口径一致） */
function readEnvEnabled(): boolean {
  const raw = process.env.CACHE_ENABLED;
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  const value = raw.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/** 环境变量读取：命中线 / 上限；非法值回退默认（命中线为启动配置项，运行时不可改） */
function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
/** LogStore 公开方法契约（接口文档 §2.4）：cache_logs 落一行 + cache_entries 镜像，同步直写、旁路静默。
 * 方法名照 §2.4；payload 形状由本文件定义（老陈按 §2.1 / §2.2 列对齐实现）。 */
export interface CacheLogPayload {
  userQuery: string;
  nearestQuery: string | null;
  similarity: number | null;
  hitLine: number;
  hit: boolean;
  tieHits: number | null;
}

/** cache_entries 镜像行（§2.1 列一一对应）；id 与内存 LRU 条目同值 */
export interface CacheEntryMirror {
  id: number;
  queryText: string;
  embeddingB64: string;
  answerJson: string;
  answerBytes: number;
  hitCount: number;
  lastAccessAt: number;
  createdAt: number;
  versionTag: string;
}

export interface CacheLogStore {
  appendCacheLog(traceId: string, payload: CacheLogPayload): void;
  insertCacheEntry(payload: CacheEntryMirror): void;
  updateCacheEntry(
    id: number,
    patch: { hitCount?: number; lastAccessAt?: number }
  ): void;
  deleteCacheEntry(id: number): void;
  clearCacheEntries(): void;
}

/** embedding 获取通道（§1.7.2 总台装配）：MCPTransport.callInternal，
 * 不落 tool_call_logs、不注入 traceId、不包装 ToolExecutionError；失败以 isError 形态返回 */
export interface CacheEmbeddingClient {
  callInternal(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult>;
}

/** 进程内 LRU 条目（§1.1 字段契约） */
export interface CacheEntry {
  id: number;
  queryText: string;
  embedding: Float32Array;
  answerObject: ChatData;
  answerBytes: number;
  hitCount: number;
  lastAccessAt: number;
  createdAt: number;
  versionTag: string;
}

/** 未命中 reason 枚举（§3.10）：低相似 / 灰色区 / 歧义 / 焦点拒判 */
export type CacheMissReason = "miss-low" | "miss-gray" | "miss-tie" | "miss-focus";

/** lookup 判定结果（命中携带答案深拷贝；未命中供 record 内部判定写缓存） */
export type CacheLookupResult =
  | {
      hit: true;
      reason: "hit";
      similarity: number;
      nearestQuery: string;
      tieHits: number;
      data: ChatData;
      embedding: Float32Array;
      userQuery: string;
    }
  | {
      hit: false;
      reason: CacheMissReason;
      similarity: number | null;
      nearestQuery: string | null;
      tieHits: number | null;
      embedding: Float32Array;
      userQuery: string;
    };

export interface CacheStatus {
  enabled: boolean;
  hitLine: number;
  maxEntries: number;
  entryCount: number;
}

export interface ListEntriesQuery {
  pageNo?: number;
  pageSize?: number;
  sortBy?: "lastAccessAt" | "hitCount";
  order?: "asc" | "desc";
}

export interface CacheEntryListItem {
  id: number;
  queryText: string;
  answerBytes: number;
  embeddingBytes: number;
  hitCount: number;
  lastAccessAt: number;
  createdAt: number;
}

export interface ListEntriesResult {
  list: CacheEntryListItem[];
  total: number;
}

export interface CacheOverview {
  enabled: boolean;
  hitLine: number;
  maxEntries: number;
  entryCount: number;
  answerBytesTotal: number;
  embeddingBytesTotal: number;
  approximateBytes: number;
  avgAnswerBytes: number;
}

export interface CacheManagerOptions {
  /** 内部工具调用通道（总台装配传 MCPTransport；测试注入 mock） */
  transport: CacheEmbeddingClient;
  /** LogStore（老陈按 §2.4 落库点实现后传入 getLogStore()；测试注入内存 fake） */
  logStore: CacheLogStore;
  /** 开关初始值：缺省读 CACHE_ENABLED env（默认开） */
  enabled?: boolean;
  /** 命中线：缺省读 CACHE_HIT_LINE env（默认 0.92）；启动配置项，运行时不可改 */
  hitLine?: number;
  /** 上限：缺省读 CACHE_MAX_ENTRIES env（默认 500） */
  maxEntries?: number;
}
/**
 * 三国演义问答语义缓存（feat-A013 编排侧）：
 * - 池子 = 进程内 LRU（队首 = 最近使用端），新写入与命中条目均放队首，淘汰从队尾逐出（§1.1 / §1.5）。
 * - lookup：sango-novel 域请求的路由判定完成后调用；命中返回答案深拷贝（0 次 LLM + 0 次检索），
 *   未命中落 cache_logs 供图表 / 命中解释供数（§2.4：判定完成即落，LLM 之前）。
 * - record：agent 拿到最终 ChatData 后调用一次，内部判定写缓存（§1.4 唯一入池口）。
 * - 对外统一接口（getStatus / setEnabled / clearAll / deleteEntry / listEntries / getOverview）供老陈
 *   createCacheApi 使用，勿改形状（接口文档 §三）。
 */
export class CacheManager {
  /** 命中线（§1.3）：启动配置项，运行时不可改 */
  readonly hitLine: number;
  /** 上限（§1.5） */
  readonly maxEntries: number;

  private logStore: CacheLogStore;
  private embedClient: CacheEmbeddingClient;
  private enabled: boolean;
  /** LRU 池（队首 = 最近使用端） */
  private entries: CacheEntry[] = [];
  /** 自增主键：与 cache_entries.id 同值（全量清除后重置，单条删除不回退） */
  private nextId = 1;

  constructor(options: CacheManagerOptions) {
    this.embedClient = options.transport;
    this.logStore = options.logStore;
    this.enabled = options.enabled ?? readEnvEnabled();
    this.hitLine = options.hitLine ?? readEnvNumber("CACHE_HIT_LINE", DEFAULT_HIT_LINE);
    this.maxEntries =
      options.maxEntries ??
      Math.max(1, Math.floor(readEnvNumber("CACHE_MAX_ENTRIES", DEFAULT_MAX_ENTRIES)));
    // 启动清镜像（§1.1 / §2.3）：防残留镜像展示陈旧数据，不做持久化恢复
    try {
      this.logStore.clearCacheEntries();
    } catch {
      // 旁路静默：镜像清失败不影响主流程（重启后残留仅展示层问题，清单已按内存为准）
    }
  }

  /** 状态（§3.1 形状） */
  getStatus(): CacheStatus {
    return {
      enabled: this.enabled,
      hitLine: this.hitLine,
      maxEntries: this.maxEntries,
      entryCount: this.entries.length,
    };
  }

  /** 开关（§1.6 / §3.2）：进程内状态立即生效；不做持久化，重启回 CACHE_ENABLED 初始值 */
  setEnabled(enabled: boolean): CacheStatus {
    this.enabled = enabled;
    return this.getStatus();
  }

  /** 全量清除（§1.6 / §3.3）：内存清空 + 镜像清空；cache_logs 不动（历史数据是图表 / 误判率数据源） */
  clearAll(): { cleared: number } {
    const cleared = this.entries.length;
    this.entries = [];
    this.nextId = 1;
    try {
      this.logStore.clearCacheEntries();
    } catch {
      // 旁路静默
    }
    return { cleared };
  }

  /** 单条删除（§1.6 / §3.4）：仅该 id 失效，其余条目命中不受影响 */
  deleteEntry(id: number): boolean {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return false;
    }
    this.entries.splice(index, 1);
    try {
      this.logStore.deleteCacheEntry(id);
    } catch {
      // 旁路静默
    }
    return true;
  }

  /** 条目明细（§3.5）：分页 + 排序；载荷纪律 = 不含 embedding 与答案全文 */
  listEntries(query: ListEntriesQuery = {}): ListEntriesResult {
    const sortBy = query.sortBy ?? "lastAccessAt";
    const order = query.order ?? "desc";
    const pageNo = Math.max(1, Math.floor(query.pageNo ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize ?? 20)));
    const sorted = [...this.entries].sort((a, b) => {
      const av = sortBy === "hitCount" ? a.hitCount : a.lastAccessAt;
      const bv = sortBy === "hitCount" ? b.hitCount : b.lastAccessAt;
      const diff = av - bv;
      if (diff !== 0) {
        return order === "asc" ? diff : -diff;
      }
      return order === "asc" ? a.id - b.id : b.id - a.id;
    });
    const start = (pageNo - 1) * pageSize;
    const list = sorted.slice(start, start + pageSize).map((entry) => ({
      id: entry.id,
      queryText: entry.queryText,
      answerBytes: entry.answerBytes,
      embeddingBytes: EMBEDDING_BYTES,
      hitCount: entry.hitCount,
      lastAccessAt: entry.lastAccessAt,
      createdAt: entry.createdAt,
    }));
    return { list, total: sorted.length };
  }

  /** 概览（§3.6 口径可复算） */
  getOverview(): CacheOverview {
    const entryCount = this.entries.length;
    const answerBytesTotal = this.entries.reduce(
      (sum, entry) => sum + entry.answerBytes,
      0
    );
    const embeddingBytesTotal = entryCount * EMBEDDING_BYTES;
    const approximateBytes =
      answerBytesTotal + embeddingBytesTotal + entryCount * ENTRY_STRUCTURE_BYTES;
    const avgAnswerBytes = entryCount === 0 ? 0 : Math.round(answerBytesTotal / entryCount);
    return {
      enabled: this.enabled,
      hitLine: this.hitLine,
      maxEntries: this.maxEntries,
      entryCount,
      answerBytesTotal,
      embeddingBytesTotal,
      approximateBytes,
      avgAnswerBytes,
    };
  }

  /**
   * 命中判定（§1.2）：开关 → embedding（唯一异步点）→ LRU 全扫（cosine 全精度、落库 4 位小数）。
   * 返回 null = 旁路（开关关闭 / embedding 降级），不查不写不落 cache_logs；
   * 命中 / 未命中一律落一行 cache_logs（traceId 为空时跳过，失败旁路静默）。
   */
  async lookup(query: string, traceId: string): Promise<CacheLookupResult | null> {
    // 步骤 0：开关检查
    if (!this.enabled) {
      return null;
    }
    const userQuery = query.trim();
    // 步骤 1：embedding 获取（唯一 await 点）；失败 → 降级旁路，等同开关关闭
    const embedding = await this.fetchEmbedding(userQuery);
    if (!embedding) {
      return null;
    }
    // 步骤 2：同步判定段（无 await；与后台清除 / 删除 / 开关的执行序见 §1.8）
    return this.judge(userQuery, embedding, traceId);
  }

  /**
   * 写缓存（§1.4 唯一入池口）：agent 在最终 ChatData 就绪后调用一次，内部判定。
   * 低相似未命中（含池空）且非拒答类 → 写；命中 / 灰色区 / 歧义 / 焦点拒判 → 不写。
   * lookup 旁路（null）或开关已关 → 不写。
   */
  record(
    query: string,
    traceId: string,
    lookup: CacheLookupResult | null,
    data: ChatData
  ): void {
    if (!lookup || lookup.hit || !this.enabled) {
      return;
    }
    if (
      lookup.reason === "miss-tie" ||
      lookup.reason === "miss-focus" ||
      lookup.reason === "miss-gray"
    ) {
      return;
    }
    // 拒答类：演义中未涉及 + citations 空 → 不写（防错误拒答固化）
    if (
      data.answer === NOVEL_NO_HIT_ANSWER &&
      (!data.citations || data.citations.length === 0)
    ) {
      return;
    }
    const now = Date.now();
    const entry: CacheEntry = {
      id: this.nextId,
      queryText: lookup.userQuery || query.trim(),
      embedding: lookup.embedding,
      answerObject: deepClone(data),
      answerBytes: answerBytesOf(data),
      hitCount: 0,
      lastAccessAt: now,
      createdAt: now,
      versionTag: CACHE_VERSION,
    };
    this.nextId += 1;
    this.entries.unshift(entry);
    try {
      this.logStore.insertCacheEntry({
        id: entry.id,
        queryText: entry.queryText,
        embeddingB64: embeddingToBase64(entry.embedding),
        answerJson: JSON.stringify(entry.answerObject),
        answerBytes: entry.answerBytes,
        hitCount: entry.hitCount,
        lastAccessAt: entry.lastAccessAt,
        createdAt: entry.createdAt,
        versionTag: entry.versionTag,
      });
    } catch {
      // 旁路静默：镜像失败不影响内存池（启动清镜像兜底对账）
    }
    this.evictIfNeeded();
  }

  /** §1.2 步骤 1：embedding 获取；失败 → console.warn 一次 + 返回 null（降级旁路） */
  private async fetchEmbedding(query: string): Promise<Float32Array | null> {
    let result: ToolCallResult;
    try {
      result = await this.embedClient.callInternal(SANGO_QUERY_EMBED_TOOL, {
        query,
      });
    } catch (error) {
      console.warn(
        `[cache] sango_query_embed 调用失败，缓存判定降级旁路（本次请求不查不写不落）：${String(error)}`
      );
      return null;
    }
    const isError = (result as { isError?: boolean }).isError === true;
    if (isError) {
      console.warn("[cache] sango_query_embed 返回失败，缓存判定降级旁路（本次请求不查不写不落）");
      return null;
    }
    const text = result.content.find(
      (item) =>
        item.type === "text" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0
    )?.text;
    const embedding = text ? decodeEmbedding(text) : null;
    if (!embedding) {
      console.warn(
        "[cache] sango_query_embed 出参非法（dim/encoding/data 不符），缓存判定降级旁路（本次请求不查不写不落）"
      );
      return null;
    }
    return embedding;
  }

  /** §1.2 步骤 2：内存 LRU 同步判定 + §2.4 cache_logs 落一行（判定完成即落，LLM 之前） */
  private judge(
    userQuery: string,
    embedding: Float32Array,
    traceId: string
  ): CacheLookupResult {
    // §1.6 版本失效：条目 versionTag ≠ CACHE_VERSION → 全量清除一次 + warn，本次按池空判定
    const staleIndex = this.entries.findIndex(
      (entry) => entry.versionTag !== CACHE_VERSION
    );
    if (staleIndex >= 0) {
      console.warn(
        "[cache] 检测到缓存条目版本过期（CACHE_VERSION 已变更），已全量清除缓存（防命中旧答案）"
      );
      this.clearAll();
    }
    // 池空 → 未命中（低相似档）：similarity / nearestQuery / tieHits 均为 null
    if (this.entries.length === 0) {
      const result: CacheLookupResult = {
        hit: false,
        reason: "miss-low",
        similarity: null,
        nearestQuery: null,
        tieHits: null,
        embedding,
        userQuery,
      };
      this.appendCacheLog(traceId, result);
      return result;
    }
    // 全扫：cosine 全精度计算，比较 / 落库按 4 位小数（cache_logs.similarity 即分区派生依据，见 §3.7）
    let bestSim = -Infinity;
    let bestEntry: CacheEntry | null = null;
    const candidates: Array<{ sim: number; entry: CacheEntry }> = [];
    for (const entry of this.entries) {
      const sim = round4(cosine(embedding, entry.embedding));
      if (sim >= this.hitLine) {
        candidates.push({ sim, entry });
      }
      if (sim > bestSim) {
        bestSim = sim;
        bestEntry = entry;
      }
    }
    // b1：≥ 命中线候选 ≥ 2 → 歧义不命中（nearestQuery = 候选第一条扫描序）
    if (candidates.length >= 2) {
      const result: CacheLookupResult = {
        hit: false,
        reason: "miss-tie",
        similarity: bestSim,
        nearestQuery: candidates[0].entry.queryText,
        tieHits: candidates.length,
        embedding,
        userQuery,
      };
      this.appendCacheLog(traceId, result);
      return result;
    }
    // b2：唯一候选 → 焦点一致性轻校验（§1.2.1）
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (focusClassesDisjoint(userQuery, candidate.entry.queryText)) {
        const result: CacheLookupResult = {
          hit: false,
          reason: "miss-focus",
          similarity: candidate.sim,
          nearestQuery: candidate.entry.queryText,
          tieHits: 1,
          embedding,
          userQuery,
        };
        this.appendCacheLog(traceId, result);
        return result;
      }
      // 命中：hitCount+1、lastAccessAt 刷新、移队首（内存 + 镜像同一次调用内完成，§1.6 / §1.8）
      const now = Date.now();
      candidate.entry.hitCount += 1;
      candidate.entry.lastAccessAt = now;
      this.moveToHead(candidate.entry);
      try {
        this.logStore.updateCacheEntry(candidate.entry.id, {
          hitCount: candidate.entry.hitCount,
          lastAccessAt: candidate.entry.lastAccessAt,
        });
      } catch {
        // 旁路静默
      }
      const result: CacheLookupResult = {
        hit: true,
        reason: "hit",
        similarity: candidate.sim,
        nearestQuery: candidate.entry.queryText,
        tieHits: 1,
        data: deepClone(candidate.entry.answerObject),
        embedding,
        userQuery,
      };
      this.appendCacheLog(traceId, result);
      return result;
    }
    // 无候选 ≥ 命中线：按最高相似度分区（低相似 < 0.80 / 灰色区 [0.80, hitLine)）→ 未命中
    const reason: CacheMissReason = bestSim < LOW_SIMILARITY_LINE ? "miss-low" : "miss-gray";
    const result: CacheLookupResult = {
      hit: false,
      reason,
      similarity: bestSim,
      nearestQuery: bestEntry?.queryText ?? null,
      tieHits: 0,
      embedding,
      userQuery,
    };
    this.appendCacheLog(traceId, result);
    return result;
  }

  /** §2.4：cache_logs 落一行（命中 / 未命中一律一行；旁路静默；traceId 为空跳过——生产链路恒有 trace 上下文） */
  private appendCacheLog(traceId: string, result: CacheLookupResult): void {
    if (!traceId) {
      return;
    }
    try {
      this.logStore.appendCacheLog(traceId, {
        userQuery: result.userQuery,
        nearestQuery: result.nearestQuery,
        similarity: result.similarity,
        hitLine: this.hitLine,
        hit: result.hit,
        tieHits: result.tieHits,
      });
    } catch {
      // 旁路静默：判定不受日志失败影响
    }
  }

  /** §1.5：命中 / 写入后超上限从队尾逐出（内存删 + 镜像 DELETE 同一次调用内完成） */
  private evictIfNeeded(): void {
    while (this.entries.length > this.maxEntries) {
      const tail = this.entries.pop();
      if (!tail) {
        break;
      }
      try {
        this.logStore.deleteCacheEntry(tail.id);
      } catch {
        // 旁路静默
      }
    }
  }

  /** §1.1：命中 / 写入条目放队首（队首 = 最近使用端） */
  private moveToHead(entry: CacheEntry): void {
    const index = this.entries.indexOf(entry);
    if (index > 0) {
      this.entries.splice(index, 1);
      this.entries.unshift(entry);
    }
  }
}