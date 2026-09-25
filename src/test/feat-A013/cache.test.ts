import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_VERSION,
  CACHE_ENABLED_SETTING_KEY,
  CacheManager,
  EMBEDDING_BYTES,
  ENTRY_STRUCTURE_BYTES,
  SANGO_QUERY_EMBED_TOOL,
  type CacheEntry,
  type CacheEntryMirror,
  type CacheLogPayload,
  type CacheLogStore,
} from "../../cache.js";
import { NOVEL_NO_HIT_ANSWER, type ChatData } from "../../citation.js";
import type { ToolCallResult } from "../../types.js";

/** 内存 fake LogStore（老陈落库实现前，按接口文档 §2.4 方法名对齐；记录调用供断言） */
class FakeCacheLogStore implements CacheLogStore {
  cacheLogs: Array<{ traceId: string; payload: CacheLogPayload }> = [];
  mirrors: CacheEntryMirror[] = [];
  updates: Array<{ id: number; patch: { hitCount?: number; lastAccessAt?: number } }> = [];
  deletes: number[] = [];
  clearCount = 0;
  settings = new Map<string, string>();

  appendCacheLog(traceId: string, payload: CacheLogPayload): void {
    this.cacheLogs.push({ traceId, payload });
  }
  insertCacheEntry(payload: CacheEntryMirror): void {
    this.mirrors.push(payload);
  }
  updateCacheEntry(id: number, patch: { hitCount?: number; lastAccessAt?: number }): void {
    this.updates.push({ id, patch });
  }
  deleteCacheEntry(id: number): void {
    this.deletes.push(id);
    const index = this.mirrors.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.mirrors.splice(index, 1);
    }
  }
  clearCacheEntries(): void {
    this.clearCount += 1;
    this.mirrors = [];
  }
  getCacheSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }
  setCacheSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }
}

/** 出参编码（§1.7.1 成功形状） */
function encodeEmbedding(vec: Float32Array): string {
  return JSON.stringify({
    dim: 1024,
    encoding: "base64-float32-le",
    data: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64"),
  });
}

/** 单位向量（cosine 精确 1.0 / 0，摆脱浮点扰动） */
function unitVector(axis: number): Float32Array {
  const vec = new Float32Array(1024);
  vec[axis] = 1;
  return vec;
}

/** 与 unitVector(axis) 余弦 ≈ cosTarget 的归一化向量（分区边界测试用） */
function vecWithCosine(axis: number, cosTarget: number): Float32Array {
  const vec = new Float32Array(1024);
  vec[axis] = cosTarget;
  vec[axis + 1] = Math.sqrt(1 - cosTarget * cosTarget);
  return vec;
}

type EmbedFailMode = "ok" | "isError" | "throw" | "badPayload";

/** 内部工具 mock：按 query → 向量映射返回（无映射视为失败） */
class FakeEmbedClient {
  calls: Array<{ name: string; query: string }> = [];
  failMode: EmbedFailMode = "ok";
  vectors = new Map<string, Float32Array>();

  async callInternal(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.calls.push({ name, query: String(args.query ?? "") });
    if (this.failMode === "throw") {
      throw new Error("embed service down");
    }
    if (this.failMode === "isError") {
      return { content: [], isError: true } as ToolCallResult;
    }
    if (this.failMode === "badPayload") {
      return { content: [{ type: "text", text: "not-a-json" }] };
    }
    const vec = this.vectors.get(String(args.query ?? ""));
    if (!vec) {
      return { content: [], isError: true } as ToolCallResult;
    }
    return { content: [{ type: "text", text: encodeEmbedding(vec) }] };
  }
}

interface ManagerFixture {
  manager: CacheManager;
  logStore: FakeCacheLogStore;
  embed: FakeEmbedClient;
}

function makeManager(
  overrides: Partial<ConstructorParameters<typeof CacheManager>[0]> = {}
): ManagerFixture {
  const logStore = new FakeCacheLogStore();
  const embed = new FakeEmbedClient();
  const manager = new CacheManager({
    transport: embed,
    logStore,
    enabled: true,
    hitLine: 0.92,
    maxEntries: 500,
    ...overrides,
  });
  return { manager, logStore, embed };
}

const ANSWER: ChatData = {
  answer: "斩华雄者系关羽。",
  citations: [
    { text: "云长提刀出阵，斩华雄于帐前！", chapter: 5, title: "发矫诏诸镇应曹公　破关兵三英战吕布" },
  ],
};

/** 经 lookup + record 走真实写缓存链路入池（池空 → miss-low → 写） */
async function writeEntry(
  manager: CacheManager,
  query: string,
  traceId: string,
  data: ChatData = ANSWER
): Promise<void> {
  const lookup = await manager.lookup(query, traceId);
  assert.equal(lookup?.hit, false, "入池前应为未命中");
  manager.record(query, traceId, lookup, data);
}

function logRow(logStore: FakeCacheLogStore, traceId: string): CacheLogPayload {
  const row = logStore.cacheLogs.find((item) => item.traceId === traceId);
  assert.ok(row, `traceId=${traceId} 应有 cache_logs 行`);
  return row.payload;
}

test("lookup：原句二次提问命中（cosine=1.0）——hitCount+1、lastAccessAt 刷新、镜像更新、cache_logs 落 hit=1 行", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("义释严颜是怎么回事", unitVector(0));
  embed.vectors.set("严颜是怎么被义释的", unitVector(1));
  await writeEntry(manager, "义释严颜是怎么回事", "t1");
  await writeEntry(manager, "严颜是怎么被义释的", "t2");

  const result = await manager.lookup("义释严颜是怎么回事", "t3");
  assert.equal(result?.hit, true, "原句二次提问应命中");
  assert.equal(result?.reason, "hit");
  assert.equal(result?.similarity, 1, "cosine=1.0 恒命中");
  assert.equal(result?.tieHits, 1);
  assert.equal(result?.nearestQuery, "义释严颜是怎么回事");
  assert.deepEqual(result?.data, ANSWER, "应返回与首次一致的答案对象");
  // 命中计数接入点：hitCount+1、lastAccessAt 刷新并落镜像更新
  const listed = manager.listEntries({ sortBy: "hitCount", order: "desc", pageSize: 100 });
  const hitEntry = listed.list.find((item) => item.queryText === "义释严颜是怎么回事");
  assert.equal(hitEntry?.hitCount, 1);
  const update = logStore.updates.find((item) => item.id === hitEntry?.id);
  assert.ok(update, "命中应落 updateCacheEntry 镜像更新");
  assert.equal(update?.patch.hitCount, 1);
  assert.ok(typeof update?.patch.lastAccessAt === "number");
  // LRU：命中条目移队首（最近使用端）
  assert.equal(listed.list[0].queryText, "义释严颜是怎么回事");
  // cache_logs：命中行 hit=1、similarity 4 位小数
  const row = logRow(logStore, "t3");
  assert.equal(row.hit, true);
  assert.equal(row.similarity, 1);
  assert.equal(row.tieHits, 1);
  assert.equal(row.hitLine, 0.92);
  assert.equal(row.userQuery, "义释严颜是怎么回事");
  assert.equal(row.nearestQuery, "义释严颜是怎么回事");
});

test("lookup：等价问法命中，返回答案深拷贝（改动返回值不污染池内条目）", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("义释严颜是怎么回事", unitVector(0));
  embed.vectors.set("严颜是怎么被义释的", unitVector(0));
  await writeEntry(manager, "义释严颜是怎么回事", "t1");

  const first = await manager.lookup("严颜是怎么被义释的", "t2");
  assert.equal(first?.hit, true, "等价问法（embedding 相同 + 焦点一致 {process}）应命中");
  assert.equal(first?.similarity, 1);
  const second = await manager.lookup("严颜是怎么被义释的", "t3");
  assert.equal(second?.hit, true);
  assert.notEqual(second?.data, first?.data, "每次命中都应返回新的深拷贝");
  // 改动返回的 citations 不影响池内条目
  const before = manager.listEntries({ pageSize: 100 }).list[0].hitCount;
  (first?.data as ChatData).citations.push({ text: "污染：不应出现在后续命中", chapter: 99 });
  const third = await manager.lookup("严颜是怎么被义释的", "t4");
  assert.equal(third?.hit, true);
  assert.equal(third?.data?.citations.length, 1, "命中返回的深拷贝被改不影响池内条目");
  assert.equal(manager.listEntries({ pageSize: 100 }).list[0].hitCount, before + 1, "三次命中共计数 3");
});test("lookup：问点不同（chapter vs process 焦点不相交）→ miss-focus 不命中", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("严颜被义释是哪一回", unitVector(0));
  embed.vectors.set("义释严颜的经过", unitVector(0));
  await writeEntry(manager, "严颜被义释是哪一回", "t1");

  const result = await manager.lookup("义释严颜的经过", "t2");
  assert.equal(result?.hit, false, "相似但问点不同（回目 vs 经过）应拒判不命中");
  assert.equal(result?.reason, "miss-focus");
  assert.equal(result?.similarity, 1, "相似度照记（≥ 命中线）");
  assert.equal(result?.nearestQuery, "严颜被义释是哪一回");
  assert.equal(result?.tieHits, 1);
  const row = logRow(logStore, "t2");
  assert.equal(row.hit, false);
  assert.equal(row.similarity, 1);
  assert.equal(row.tieHits, 1, "焦点拒判行 tieHits=1");
  assert.equal(row.nearestQuery, "严颜被义释是哪一回");
});

test("lookup：同问点换词（chapter vs chapter 焦点一致）→ 放行命中", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("严颜被义释是哪一回", unitVector(0));
  embed.vectors.set("严颜被义释发生在第几回", unitVector(0));
  await writeEntry(manager, "严颜被义释是哪一回", "t1");

  const result = await manager.lookup("严颜被义释发生在第几回", "t2");
  assert.equal(result?.hit, true, "同为 chapter 问点（是哪一回 vs 第几回）应放行命中");
  assert.equal(result?.similarity, 1);
});

test("lookup：单边无焦点 → 放行（靠相似度阈值判定）", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("严颜被义释", unitVector(0));
  embed.vectors.set("义释严颜的经过", unitVector(0));
  await writeEntry(manager, "严颜被义释", "t1");

  const result = await manager.lookup("义释严颜的经过", "t2");
  assert.equal(result?.hit, true, "单边无焦点（F(A) 空）应放行，相似度 1.0 ≥ 命中线 → 命中");
});

/** 直接向池内写入条目（歧义 / 命中线以上并列场景需要精确控制嵌入向量，绕过写缓存链路） */
function seedEntryDirect(
  manager: CacheManager,
  id: number,
  queryText: string,
  axis: number
): void {
  (manager as unknown as { entries: CacheEntry[] }).entries.push({
    id,
    queryText,
    embedding: unitVector(axis),
    answerObject: ANSWER,
    answerBytes: 1,
    hitCount: 0,
    lastAccessAt: Date.now(),
    createdAt: Date.now(),
    versionTag: CACHE_VERSION,
  });
}

test("lookup：歧义防御——≥ 命中线候选 2 条 → miss-tie（nearestQuery = 候选第一条扫描序）", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("基准Q6问", unitVector(0));
  seedEntryDirect(manager, 1, "基准Q6甲", 0);
  seedEntryDirect(manager, 2, "基准Q6乙", 0);

  const result = await manager.lookup("基准Q6问", "t3");
  assert.equal(result?.hit, false, "两条候选同时 ≥ 命中线 → 歧义不命中");
  assert.equal(result?.reason, "miss-tie");
  assert.equal(result?.similarity, 1);
  assert.equal(result?.nearestQuery, "基准Q6甲", "候选第一条 = 扫描序（数组序，非命中序）");
  assert.equal(result?.tieHits, 2);
  const row = logRow(logStore, "t3");
  assert.equal(row.hit, false);
  assert.equal(row.tieHits, 2);
});

test("lookup：池空 → miss-low 低相似档（similarity/nearestQuery/tieHits 均 null），首条写入 id=1 且带当前版本", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("义释严颜是怎么回事", unitVector(0));
  const result = await manager.lookup("义释严颜是怎么回事", "t1");
  assert.equal(result?.hit, false);
  assert.equal(result?.reason, "miss-low");
  assert.equal(result?.similarity, null, "池空 similarity=null");
  assert.equal(result?.nearestQuery, null, "池空 nearestQuery=null");
  assert.equal(result?.tieHits, null, "池空 tieHits=null");
  const row = logRow(logStore, "t1");
  assert.equal(row.similarity, null);
  assert.equal(row.nearestQuery, null);
  assert.equal(row.tieHits, null);
  assert.equal(row.hitLine, 0.92);
  assert.equal(row.hit, false);
  // record：池空低相似 → 写缓存（首个条目 id=1、versionTag=CACHE_VERSION、queryText 已 trim）
  manager.record("  义释严颜是怎么回事  ", "t1", result, ANSWER);
  const status = manager.getStatus();
  assert.equal(status.entryCount, 1);
  assert.equal(logStore.mirrors.length, 1);
  assert.equal(logStore.mirrors[0].id, 1);
  assert.equal(logStore.mirrors[0].queryText, "义释严颜是怎么回事");
  assert.equal(logStore.mirrors[0].versionTag, CACHE_VERSION);
  assert.equal(
    logStore.mirrors[0].answerBytes,
    Buffer.byteLength(JSON.stringify(ANSWER), "utf8"),
    "answer_bytes 口径：Buffer.byteLength(JSON.stringify(答案对象))"
  );
  assert.equal(
    logStore.mirrors[0].embeddingB64,
    Buffer.from(unitVector(0).buffer).toString("base64"),
    "镜像 embedding base64 与入池向量一致"
  );
});

test("lookup：分区边界——0.92 命中 / 0.80 灰色区（不写）/ 0.799 低相似（写）", async () => {
  // 0.92：唯一候选 ≥ 命中线 → 命中
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("基准问题D", unitVector(2));
    embed.vectors.set("基准问题D换说法", vecWithCosine(2, 0.92));
    await writeEntry(manager, "基准问题D", "td1");
    const hit = await manager.lookup("基准问题D换说法", "td2");
    assert.equal(hit?.hit, true, "相似度 0.92 = 命中线下沿 → 命中");
    assert.equal(hit?.similarity, 0.92);
  }
  // 0.80：灰色区 [0.80, 0.92) → miss-gray 不写
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("基准问题E", unitVector(3));
    embed.vectors.set("基准问题E换说法", vecWithCosine(3, 0.8));
    await writeEntry(manager, "基准问题E", "te1");
    const gray = await manager.lookup("基准问题E换说法", "te2");
    assert.equal(gray?.hit, false);
    assert.equal(gray?.reason, "miss-gray", "0.80 ≤ sim < 0.92 → 灰色区不命中");
    assert.equal(gray?.similarity, 0.8);
    assert.equal(gray?.tieHits, 0);
    manager.record("基准问题E换说法", "te2", gray, ANSWER);
    assert.equal(manager.getStatus().entryCount, 1, "灰色区不写缓存");
  }
  // 0.799：低相似 < 0.80 → miss-low 写缓存
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("基准问题F", unitVector(4));
    embed.vectors.set("基准问题F换说法", vecWithCosine(4, 0.799));
    await writeEntry(manager, "基准问题F", "tf1");
    const low = await manager.lookup("基准问题F换说法", "tf2");
    assert.equal(low?.hit, false);
    assert.equal(low?.reason, "miss-low", "sim < 0.80 → 低相似");
    assert.equal(low?.similarity, 0.799);
    manager.record("基准问题F换说法", "tf2", low, ANSWER);
    assert.equal(manager.getStatus().entryCount, 2, "低相似未命中 + 非拒答 → 写缓存");
  }
});

test("lookup：开关关闭 → 旁路（不调 embed、不落 cache_logs、record 不写）且关闭即清空；开启后池空同问重新判定", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("谁斩了华雄", unitVector(5));
  await writeEntry(manager, "谁斩了华雄", "t1");

  const status = manager.setEnabled(false);
  assert.equal(status.enabled, false);
  assert.equal(manager.getStatus().entryCount, 0, "关闭 = 停用 + 清空（负责人 2026-09-25 拍板）：池子已清空");
  assert.equal(logStore.mirrors.length, 0, "关闭即清空镜像");
  const lookup = await manager.lookup("谁斩了华雄", "t2");
  assert.equal(lookup, null, "关闭后不查缓存");
  assert.equal(embed.calls.length, 1, "关闭后不应调用 embed");
  assert.equal(logStore.cacheLogs.length, 1, "关闭后不再落 cache_logs");
  manager.record("谁斩了华雄", "t2", lookup, ANSWER);
  assert.equal(manager.getStatus().entryCount, 0, "关闭后 record 不写");
  assert.equal(logStore.mirrors.length, 0, "关闭后 record 不写镜像");

  const reopened = manager.setEnabled(true);
  assert.equal(reopened.enabled, true);
  // 新口径（负责人 2026-09-25 拍板）：关闭即清空，重开从空池重新积累——同问不再命中（验收 8 不再成立）
  const miss = await manager.lookup("谁斩了华雄", "t3");
  assert.equal(miss?.hit, false, "开启后池子已空：同一问题重新判定（不命中）");
  assert.equal(miss?.reason, "miss-low");
  assert.equal(embed.calls.length, 2, "空池 lookup 仍先取 embedding 再判空（§1.2 步骤 1）");
  assert.equal(manager.getStatus().entryCount, 0, "仅判定未 record 不入池");
});

test("lookup：embed 降级（isError / 抛异常 / 出参非法）→ 等同开关关闭，console.warn 一次，不落 cache_logs", async () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warns.push(String(message));
  };
  try {
    for (const mode of ["isError", "throw", "badPayload"] as EmbedFailMode[]) {
      warns.length = 0; // 每次迭代独立计数
      const { manager, logStore, embed } = makeManager();
      embed.failMode = mode;
      embed.vectors.set("谁斩了华雄", unitVector(6));
      const lookup = await manager.lookup("谁斩了华雄", "g1");
      assert.equal(lookup, null, `${mode}：lookup 应返回 null（旁路）`);
      assert.equal(embed.calls.length, 1);
      assert.equal(embed.calls[0].name, SANGO_QUERY_EMBED_TOOL, "应调 sango_query_embed 内部工具");
      assert.equal(logStore.cacheLogs.length, 0, `${mode}：不落 cache_logs`);
      assert.equal(manager.getStatus().entryCount, 0, `${mode}：不写缓存`);
      const modeWarns = warns.filter((item) => item.includes("sango_query_embed") || item.includes("出参非法"));
      assert.equal(modeWarns.length, 1, `${mode}：console.warn 恰一次`);
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("lookup：返回值与 cache_logs payload 统一携带 lookupMs（≥0 有限毫秒）；旁路不落库不受影响", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("谁斩了华雄", unitVector(5));

  // 池空 → miss-low：结果与 payload 同步携带 lookupMs（mock logStore 捕获）
  const miss = await manager.lookup("谁斩了华雄", "lm1");
  assert.equal(miss?.hit, false, "池空应返回未命中结果");
  assert.ok(miss, "未命中应返回结果对象（非旁路）");
  assert.ok(
    Number.isFinite(miss.lookupMs) && miss.lookupMs >= 0,
    "未命中结果应携带 lookupMs（≥0 的有限毫秒数）"
  );
  const missRow = logRow(logStore, "lm1");
  assert.equal(missRow.lookupMs, miss.lookupMs, "未命中 payload 应收到与结果一致的 lookupMs");

  // 入池后二次请求 → 命中：命中路径同样携带 lookupMs
  manager.record("谁斩了华雄", "lm1", miss, ANSWER);
  const hit = await manager.lookup("谁斩了华雄", "lm2");
  assert.equal(hit?.hit, true, "二次请求应命中");
  assert.ok(hit, "命中应返回结果对象（非旁路）");
  assert.ok(
    Number.isFinite(hit.lookupMs) && hit.lookupMs >= 0,
    "命中结果应携带 lookupMs（≥0 的有限毫秒数）"
  );
  const hitRow = logRow(logStore, "lm2");
  assert.equal(hitRow.lookupMs, hit.lookupMs, "命中 payload 应收到与结果一致的 lookupMs");

  // 旁路（enabled=false → return null）：不落库、不影响已落行
  manager.setEnabled(false);
  const bypass = await manager.lookup("谁斩了华雄", "lm3");
  assert.equal(bypass, null, "开关关闭应旁路返回 null");
  assert.equal(logStore.cacheLogs.length, 2, "旁路不新增 cache_logs 行");
  assert.equal(logRow(logStore, "lm1").lookupMs, miss.lookupMs, "旁路不污染已落行");
});

test("lookup：版本失效——条目 versionTag ≠ CACHE_VERSION → 全量清除一次 + console.warn，本次按池空 miss-low 判定", async () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warns.push(String(message));
  };
  try {
    const { manager, logStore, embed } = makeManager();
    embed.vectors.set("旧版条目", unitVector(7));
    // 模拟存量旧版本条目（版本失效口径：语料 / 提示词 / 路由版本变更后防命中旧答案）
    (manager as unknown as { entries: CacheEntry[] }).entries.push({
      id: 88,
      queryText: "旧版条目",
      embedding: unitVector(7),
      answerObject: ANSWER,
      answerBytes: 1,
      hitCount: 0,
      lastAccessAt: Date.now(),
      createdAt: Date.now(),
      versionTag: "OLD-VERSION",
    });
    const result = await manager.lookup("旧版条目", "tv1");
    assert.equal(result?.hit, false, "版本失效后按池空判定");
    assert.equal(result?.reason, "miss-low");
    assert.equal(result?.similarity, null);
    assert.equal(logStore.clearCount >= 1, true, "应触发一次全量清除（内存 + 镜像）");
    assert.equal(manager.getStatus().entryCount, 0, "内存池已清空");
    assert.ok(
      warns.some((item) => item.includes("版本过期")),
      "应输出版本失效 console.warn"
    );
  } finally {
    console.warn = originalWarn;
  }
});test("record：拒答类（演义中未涉及 + citations 空）不写；同文案带引用可写", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("池空问题甲", unitVector(8));
  embed.vectors.set("池空问题乙", unitVector(9));
  const lookupA = await manager.lookup("池空问题甲", "r1");
  manager.record("池空问题甲", "r1", lookupA, { answer: NOVEL_NO_HIT_ANSWER, citations: [] });
  assert.equal(manager.getStatus().entryCount, 0, "拒答类（演义中未涉及 + citations 空）不写");

  const lookupB = await manager.lookup("池空问题乙", "r2");
  manager.record("池空问题乙", "r2", lookupB, {
    answer: NOVEL_NO_HIT_ANSWER,
    citations: [{ text: "有引用片段", chapter: 5 }],
  });
  assert.equal(manager.getStatus().entryCount, 1, "同文案但带引用 → 非拒答类，可写");
});

test("record：灰色区 / 歧义 / 焦点拒判 / 命中 一律不写缓存", async () => {
  // 灰色区
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("灰Q", unitVector(10));
    embed.vectors.set("灰Q换", vecWithCosine(10, 0.85));
    await writeEntry(manager, "灰Q", "w1");
    const gray = await manager.lookup("灰Q换", "w2");
    assert.equal(gray?.reason, "miss-gray");
    manager.record("灰Q换", "w2", gray, ANSWER);
    assert.equal(manager.getStatus().entryCount, 1, "灰色区不写");
  }
  // 歧义
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("歧Q问", unitVector(11));
    seedEntryDirect(manager, 100, "歧Q甲", 11);
    seedEntryDirect(manager, 101, "歧Q乙", 11);
    const tie = await manager.lookup("歧Q问", "w5");
    assert.equal(tie?.reason, "miss-tie");
    manager.record("歧Q问", "w5", tie, ANSWER);
    assert.equal(manager.getStatus().entryCount, 2, "歧义不写（防污染池子与歧义判定）");
  }
  // 焦点拒判
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("严颜被义释是哪一回", unitVector(12));
    embed.vectors.set("义释严颜的经过", unitVector(12));
    await writeEntry(manager, "严颜被义释是哪一回", "w6");
    const focus = await manager.lookup("义释严颜的经过", "w7");
    assert.equal(focus?.reason, "miss-focus");
    manager.record("义释严颜的经过", "w7", focus, ANSWER);
    assert.equal(manager.getStatus().entryCount, 1, "焦点拒判不写");
  }
  // 命中（条目已在池中，lookup 已计数）
  {
    const { manager, embed } = makeManager();
    embed.vectors.set("命Q", unitVector(13));
    await writeEntry(manager, "命Q", "w8");
    const hit = await manager.lookup("命Q", "w9");
    assert.equal(hit?.hit, true);
    manager.record("命Q", "w9", hit, ANSWER);
    assert.equal(manager.getStatus().entryCount, 1, "reason=hit 不重复写");
  }
});

test("LRU：小容量写入超上限从队尾逐出（内存删 + 镜像 DELETE）；命中提升后淘汰最久未用", async () => {
  // listEntries 按 lastAccessAt 展示，命中 / 写入需有可区分的时间戳（间隔 10ms）
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const { manager, logStore, embed } = makeManager({ maxEntries: 2 });
  embed.vectors.set("LRU甲", unitVector(20));
  embed.vectors.set("LRU乙", unitVector(21));
  embed.vectors.set("LRU丙", unitVector(22));
  await writeEntry(manager, "LRU甲", "l1");
  await tick();
  await writeEntry(manager, "LRU乙", "l2");
  assert.deepEqual(
    manager.listEntries({ pageSize: 100 }).list.map((item) => item.queryText),
    ["LRU乙", "LRU甲"],
    "队首 = 最近写入"
  );
  // 命中 LRU甲 → 移队首
  await tick();
  const hitA = await manager.lookup("LRU甲", "l3");
  assert.equal(hitA?.hit, true);
  assert.deepEqual(
    manager.listEntries({ pageSize: 100 }).list.map((item) => item.queryText),
    ["LRU甲", "LRU乙"],
    "命中条目移队首"
  );
  // 写入 LRU丙 → 超上限 2，从队尾（最久未用 = LRU乙）逐出
  await tick();
  await writeEntry(manager, "LRU丙", "l4");
  assert.deepEqual(
    manager.listEntries({ pageSize: 100 }).list.map((item) => item.queryText),
    ["LRU丙", "LRU甲"],
    "写入后队首 LRU丙，最久未用的 LRU乙 被逐出"
  );
  const evicted = logStore.mirrors.find((item) => item.queryText === "LRU乙");
  assert.ok(!evicted, "被逐出条目（LRU乙）已从镜像删除");
  assert.ok(logStore.deletes.includes(2), "逐出落镜像 DELETE（LRU乙 id=2）");
  assert.equal(logStore.mirrors.length, 2, "镜像与内存同事务淘汰");
  assert.equal(manager.getStatus().entryCount, 2);
});

test("管理操作：setEnabled 返回新状态（关闭 = 停用 + 清空，幂等）、deleteEntry 仅删该 id、clearAll 返回清除数且镜像全清", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("管Q甲", unitVector(30));
  embed.vectors.set("管Q乙", unitVector(31));

  // 空池切开关：状态形状正确；重复关闭幂等
  assert.deepEqual(manager.setEnabled(false), { enabled: false, hitLine: 0.92, maxEntries: 500, entryCount: 0 });
  assert.equal(manager.setEnabled(false).enabled, false, "重复关闭幂等、不报错");
  assert.equal(manager.setEnabled(true).enabled, true, "重开状态正确");

  await writeEntry(manager, "管Q甲", "m1");
  await writeEntry(manager, "管Q乙", "m2");
  assert.equal(manager.getStatus().entryCount, 2, "开启状态可正常入池");

  // 关闭 = 停用 + 清空（负责人 2026-09-25 拍板）：内存池与镜像清空，重开从空池重新积累
  const status = manager.setEnabled(false);
  assert.deepEqual(status, { enabled: false, hitLine: 0.92, maxEntries: 500, entryCount: 0 });
  assert.equal(logStore.mirrors.length, 0, "关闭即清空镜像");
  assert.equal(manager.listEntries({ pageSize: 100 }).total, 0, "关闭后 listEntries 为空");
  const enabledAgain = manager.setEnabled(true);
  assert.equal(enabledAgain.enabled, true);

  // 重开后再写条目，验证 deleteEntry / clearAll（原语义不变）
  await writeEntry(manager, "管Q甲", "m3");
  await writeEntry(manager, "管Q乙", "m4");
  const idA = manager.listEntries({ pageSize: 100 }).list.find((item) => item.queryText === "管Q甲")?.id as number;
  assert.equal(manager.deleteEntry(idA), true, "删除存在的 id 返回 true");
  assert.equal(manager.deleteEntry(9999), false, "删除不存在的 id 返回 false");
  assert.equal(logStore.mirrors.length, 1, "镜像同步删该 id");
  assert.equal(manager.listEntries({ pageSize: 100 }).total, 1, "其余条目不受影响");

  const target = manager.listEntries({ pageSize: 100 }).list[0];
  assert.equal(target.queryText, "管Q乙");
  // 删除的 id 不影响再次命中其余条目
  const hit = await manager.lookup("管Q乙", "m5");
  assert.equal(hit?.hit, true, "单条删除仅该条目失效");

  const cleared = manager.clearAll();
  assert.equal(cleared.cleared, 1, "cleared = 清除前条目数");
  assert.equal(manager.getStatus().entryCount, 0, "内存池清空");
  assert.equal(logStore.mirrors.length, 0, "镜像全清");
  assert.equal(logStore.clearCount >= 2, true, "构造启动清镜像 + 主动全量清除");
});

test("listEntries：分页 / 排序（lastAccessAt / hitCount，asc / desc），载荷不含 embedding 与答案全文", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("列Q甲", unitVector(40));
  embed.vectors.set("列Q乙", unitVector(41));
  embed.vectors.set("列Q丙", unitVector(42));
  await writeEntry(manager, "列Q甲", "n1");
  await writeEntry(manager, "列Q乙", "n2");
  await writeEntry(manager, "列Q丙", "n3");
  const hit = await manager.lookup("列Q丙", "n4");
  assert.equal(hit?.hit, true);
  await manager.lookup("列Q丙", "n5");

  // lastAccessAt desc（默认）：最近访问（列Q丙）在前
  const descLast = manager.listEntries({ pageNo: 1, pageSize: 20, sortBy: "lastAccessAt", order: "desc" });
  assert.equal(descLast.total, 3);
  assert.equal(descLast.list[0].queryText, "列Q丙");
  // hitCount desc：列Q丙 命中 2 次居首；asc 居尾
  const byHitCount = manager.listEntries({ sortBy: "hitCount", order: "desc" });
  assert.equal(byHitCount.list[0].queryText, "列Q丙");
  assert.equal(byHitCount.list[0].hitCount, 2);
  const byHitCountAsc = manager.listEntries({ sortBy: "hitCount", order: "asc" });
  assert.equal(byHitCountAsc.list[0].hitCount, 0);
  // 分页
  const page1 = manager.listEntries({ pageNo: 1, pageSize: 2 });
  assert.equal(page1.list.length, 2);
  const page2 = manager.listEntries({ pageNo: 2, pageSize: 2 });
  assert.equal(page2.list.length, 1);
  // 载荷纪律：无 embedding / 答案全文，embeddingBytes 恒 4096
  const item = descLast.list[0];
  assert.deepEqual(Object.keys(item).sort(), [
    "answerBytes",
    "createdAt",
    "embeddingBytes",
    "hitCount",
    "id",
    "lastAccessAt",
    "queryText",
  ]);
  assert.equal(item.embeddingBytes, EMBEDDING_BYTES);
});

test("getOverview：口径可复算（answerBytesTotal / embeddingBytesTotal / approximateBytes / avgAnswerBytes）", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("概Q甲", unitVector(50));
  embed.vectors.set("概Q乙", unitVector(51));
  await writeEntry(manager, "概Q甲", "o1", ANSWER);
  await writeEntry(manager, "概Q乙", "o2", {
    answer: "长一点的答案文本，用于验证字节合计与平均值。",
    citations: [{ text: "引用片段一", chapter: 1 }, { text: "引用片段二", chapter: 2 }],
  });

  const overview = manager.getOverview();
  assert.equal(overview.enabled, true);
  assert.equal(overview.hitLine, 0.92);
  assert.equal(overview.maxEntries, 500);
  assert.equal(overview.entryCount, 2);
  const list = manager.listEntries({ pageSize: 100 }).list;
  const answerBytesTotal = list.reduce((sum, item) => sum + item.answerBytes, 0);
  assert.equal(overview.answerBytesTotal, answerBytesTotal, "answerBytesTotal == Σ list[].answerBytes");
  assert.equal(overview.embeddingBytesTotal, 2 * EMBEDDING_BYTES, "embeddingBytesTotal = entryCount × 4096");
  assert.equal(
    overview.approximateBytes,
    answerBytesTotal + 2 * EMBEDDING_BYTES + 2 * ENTRY_STRUCTURE_BYTES,
    "approximateBytes = 答案字节 + embedding 字节 + 条目数 × 256"
  );
  assert.equal(overview.avgAnswerBytes, Math.round(answerBytesTotal / 2));
  // 池空口径：avgAnswerBytes = 0
  manager.clearAll();
  const empty = manager.getOverview();
  assert.equal(empty.entryCount, 0);
  assert.equal(empty.answerBytesTotal, 0);
  assert.equal(empty.avgAnswerBytes, 0);
});

test("env 默认值：CACHE_ENABLED / CACHE_HIT_LINE / CACHE_MAX_ENTRIES 启动读取，非法值回退默认", () => {
  // 本测试构造不传 overrides，验证 env 读取（makeManager 会显式覆盖三项，不适用）
  const makeRawManager = () => {
    const logStore = new FakeCacheLogStore();
    const embed = new FakeEmbedClient();
    return { manager: new CacheManager({ transport: embed, logStore }), logStore, embed };
  };
  const previous: Record<string, string | undefined> = {};
  const keys = ["CACHE_ENABLED", "CACHE_HIT_LINE", "CACHE_MAX_ENTRIES"];
  for (const key of keys) {
    previous[key] = process.env[key];
  }
  try {
    process.env.CACHE_ENABLED = "false";
    process.env.CACHE_HIT_LINE = "0.9";
    process.env.CACHE_MAX_ENTRIES = "2";
    const fixture = makeRawManager();
    assert.equal(fixture.manager.getStatus().enabled, false, "CACHE_ENABLED=false 启动关闭");
    assert.equal(fixture.manager.getStatus().hitLine, 0.9, "CACHE_HIT_LINE=0.9 启动生效");
    assert.equal(fixture.manager.getStatus().maxEntries, 2, "CACHE_MAX_ENTRIES=2 启动生效");
    // hitLine 初始值读 env（§1.3：运行时可用 setHitLine 调整）；maxEntries 仍为启动固定值
    assert.equal((fixture.manager as unknown as { hitLine: number }).hitLine, 0.9);
    // 非法值回退默认
    process.env.CACHE_HIT_LINE = "abc";
    process.env.CACHE_MAX_ENTRIES = "abc";
    const fallback = makeRawManager();
    assert.equal(fallback.manager.getStatus().hitLine, 0.92);
    assert.equal(fallback.manager.getStatus().maxEntries, 500);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test("开关持久化：setEnabled(false) 写 cache_settings；同一存储重建恢复上次开关状态（env 未显式设置）", () => {
  const keys = ["CACHE_ENABLED", "CACHE_HIT_LINE", "CACHE_MAX_ENTRIES"];
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
  }
  try {
    for (const key of keys) {
      delete process.env[key];
    }
    const fixture = makeManager({ enabled: undefined });
    fixture.manager.setEnabled(false);
    assert.equal(
      fixture.logStore.getCacheSetting(CACHE_ENABLED_SETTING_KEY),
      "false",
      "setEnabled(false) 后持久化读到 'false'"
    );
    const restored = new CacheManager({
      transport: new FakeEmbedClient(),
      logStore: fixture.logStore,
    });
    assert.equal(restored.getStatus().enabled, false, "同一持久化存储重建后恢复上次开关 false");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
});

test("开关构造恢复：cache_settings 持久化 'false' → 无显式 env 时新 manager enabled=false", () => {
  const previous = process.env.CACHE_ENABLED;
  try {
    delete process.env.CACHE_ENABLED;
    const logStore = new FakeCacheLogStore();
    logStore.setCacheSetting(CACHE_ENABLED_SETTING_KEY, "false");
    const manager = new CacheManager({ transport: new FakeEmbedClient(), logStore });
    assert.equal(manager.getStatus().enabled, false, "持久化 'false' 构造恢复生效");
  } finally {
    if (previous === undefined) {
      delete process.env.CACHE_ENABLED;
    } else {
      process.env.CACHE_ENABLED = previous;
    }
  }
});

test("开关口径：关闭 = 停用 + 清空——entryCount 归零、listEntries 空、镜像清空；重开仍为空；重复 false 幂等", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("清Q甲", unitVector(50));
  embed.vectors.set("清Q乙", unitVector(51));
  await writeEntry(manager, "清Q甲", "c1");
  await writeEntry(manager, "清Q乙", "c2");
  assert.equal(manager.getStatus().entryCount, 2, "前置：池内有 2 条");
  assert.equal(logStore.mirrors.length, 2, "前置：镜像 2 条");

  assert.equal(manager.setEnabled(false).enabled, false);
  assert.equal(manager.getStatus().entryCount, 0, "关闭即清空内存池");
  assert.equal(manager.listEntries({ pageSize: 100 }).total, 0, "关闭后 listEntries 为空");
  assert.equal(manager.listEntries({ pageSize: 100 }).list.length, 0, "关闭后条目明细为空");
  assert.equal(logStore.mirrors.length, 0, "关闭即清空 cache_entries 镜像（cache_logs 保留）");
  assert.equal(logStore.cacheLogs.length, 2, "cache_logs 历史保留（清空不动审计数据）");

  assert.equal(manager.setEnabled(false).enabled, false, "重复关闭幂等、不报错");
  assert.equal(manager.getStatus().entryCount, 0, "重复关闭后仍为空");
  assert.equal(manager.setEnabled(true).enabled, true, "重开状态正确");
  assert.equal(manager.getStatus().entryCount, 0, "重开从空池重新积累（验收 8『开启后恢复命中』不再成立）");
  assert.equal(manager.listEntries({ pageSize: 100 }).total, 0, "重开后 listEntries 仍为空");
  assert.equal(logStore.mirrors.length, 0, "重开后镜像为空");
});

test("setHitLine：运行时调整命中线立即生效；越界拒绝（返回 NaN 且值不变）", async () => {
  const { manager, embed } = makeManager(); // 初始 hitLine = 0.92
  embed.vectors.set("严颜是怎么被义释的", unitVector(0));
  embed.vectors.set("严颜为什么被义释", vecWithCosine(0, 0.85)); // 与池条目余弦 0.85
  await writeEntry(manager, "严颜是怎么被义释的", "t1");

  const before = await manager.lookup("严颜为什么被义释", "t2");
  assert.equal(before?.hit, false, "sim=0.85 < 0.92 → 灰色区未命中");
  assert.equal(before?.reason, "miss-gray");

  assert.equal(manager.setHitLine(0.8), 0.8);
  const after = await manager.lookup("严颜为什么被义释", "t3");
  assert.equal(after?.hit, true, "命中线降至 0.80 后 sim=0.85 应命中");
  assert.equal(after?.similarity, 0.85);
  assert.equal(manager.getStatus().hitLine, 0.8, "调整立即反映于状态");

  // 越界拒绝：返回 NaN 且命中线不变
  assert.equal(manager.setHitLine(1.5), NaN);
  assert.equal(manager.setHitLine(0), NaN);
  assert.equal(manager.setHitLine(-0.1), NaN);
  assert.equal(manager.setHitLine(Number.NaN), NaN);
  assert.equal(manager.getStatus().hitLine, 0.8, "越界后值不变");
  const stillGray = await manager.lookup("严颜为什么被义释", "t4");
  assert.equal(stillGray?.hit, true, "拒绝的非法值不打断已生效的命中线");
});

test("setMaxEntries：调大生效并返回新值；调小立即从队尾逐出至新上限（内存删 + 镜像 DELETE）；非法返回 NaN 且不变", async () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const { manager, logStore, embed } = makeManager({ maxEntries: 2 });
  embed.vectors.set("上限甲", unitVector(40));
  embed.vectors.set("上限乙", unitVector(41));
  embed.vectors.set("上限丙", unitVector(42));
  await writeEntry(manager, "上限甲", "c1");
  await tick();
  await writeEntry(manager, "上限乙", "c2");
  assert.equal(manager.getStatus().entryCount, 2);

  // 调大：立即生效并返回新值，第三条约 3 不再驱逐
  assert.equal(manager.setMaxEntries(3), 3);
  assert.equal(manager.getStatus().maxEntries, 3);
  await tick();
  await writeEntry(manager, "上限丙", "c3");
  assert.equal(manager.getStatus().entryCount, 3, "调大后第三条约 3 不驱逐");

  // 调小：从队尾（最久未用端）立即逐出至新上限，镜像同步 DELETE
  assert.equal(manager.setMaxEntries(2), 2);
  assert.equal(manager.getStatus().maxEntries, 2);
  assert.equal(manager.getStatus().entryCount, 2, "调小立即驱逐尾部条目至新上限");
  assert.deepEqual(
    manager.listEntries({ pageSize: 100 }).list.map((item) => item.queryText),
    ["上限丙", "上限乙"],
    "驱逐最久未用端（上限甲）"
  );
  assert.ok(!logStore.mirrors.find((item) => item.queryText === "上限甲"), "被逐出条目（上限甲）已从镜像删除");
  assert.ok(logStore.deletes.includes(1), "逐出落镜像 DELETE（上限甲 id=1）");
  assert.equal(logStore.mirrors.length, 2, "镜像与内存同事务淘汰");

  // 非法：<1 / 非整数 / 非有限 → NaN 且上限与条目数不变
  assert.equal(manager.setMaxEntries(0), NaN);
  assert.equal(manager.setMaxEntries(-5), NaN);
  assert.equal(manager.setMaxEntries(1.5), NaN);
  assert.equal(manager.setMaxEntries(Number.NaN), NaN);
  assert.equal(manager.setMaxEntries(Number.POSITIVE_INFINITY), NaN);
  assert.equal(manager.getStatus().maxEntries, 2, "非法后上限不变");
  assert.equal(manager.getStatus().entryCount, 2, "非法后条目不变");
});

test("lookup：人名字号归一化换说法命中（云长→关羽）；落库仍存原始文本", async () => {
  const { manager, logStore, embed } = makeManager();
  embed.vectors.set("关羽过五关斩六将", unitVector(0));
  await writeEntry(manager, "关羽过五关斩六将", "t1");

  // 未归一化时「云长过五关斩六将」无 embedding 映射（降级旁路 null）；归一化后与池中条目同文本 → cosine=1.0 恒命中
  const result = await manager.lookup("云长过五关斩六将", "t2");
  assert.equal(result?.hit, true, "云长→关羽 换说法应命中");
  assert.equal(result?.similarity, 1);
  assert.equal(result?.reason, "hit");
  assert.equal(result?.nearestQuery, "关羽过五关斩六将");
  // 原词保持：cache_logs.user_query 与条目 queryText 仍为原始文本
  const row = logRow(logStore, "t2");
  assert.equal(row.userQuery, "云长过五关斩六将");
  assert.equal(row.nearestQuery, "关羽过五关斩六将");
  assert.equal(row.hitLine, 0.92);
});

test("lookup：人名字号归一化长词优先（关云长 / 诸葛孔明）", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("关羽温酒斩华雄", unitVector(0));
  embed.vectors.set("诸葛亮三气周瑜", unitVector(1));
  await writeEntry(manager, "关羽温酒斩华雄", "t1");
  await writeEntry(manager, "诸葛亮三气周瑜", "t2");

  const r1 = await manager.lookup("关云长温酒斩华雄", "t3");
  assert.equal(r1?.hit, true, "关云长→关羽（长词优先，不拆成「关关羽」）");
  const r2 = await manager.lookup("诸葛孔明三气公瑾", "t4");
  assert.equal(r2?.hit, true, "诸葛孔明→诸葛亮、公瑾→周瑜");
});

test("lookup：人名字号归一化不放大不相关文本相似度", async () => {
  const { manager, embed } = makeManager();
  embed.vectors.set("关羽过五关斩六将", unitVector(0));
  embed.vectors.set("华容道关羽释曹操", unitVector(1));
  embed.vectors.set("诸葛亮施计借东风", unitVector(2)); // 归一化后（孔明→诸葛亮）才有映射；未归一化会查不到向量
  await writeEntry(manager, "关羽过五关斩六将", "t1");
  await writeEntry(manager, "华容道关羽释曹操", "t2");

  const result = await manager.lookup("孔明施计借东风", "t3");
  assert.equal(result?.hit, false, "归一化后（诸葛亮施计借东风）与池内仍不相关 → 不命中");
  assert.equal(result?.reason, "miss-low");
  assert.equal(result?.similarity, 0);
});
