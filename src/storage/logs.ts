// feat-A007 链路日志存储层：data/logs.db（better-sqlite3）。
// 表结构 / 字段 / 幂等 / 写缓冲 / 保留 / 截断口径以 api/feat-A007-log-tracking.md 为准。
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_DB_PATH = 'data/logs.db';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_CONTENT_LENGTH = 8000;
const LIST_SUMMARY_LENGTH = 200;
const TRUNCATE_MARKER = '…（已截断）';
const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFERED_OPS = 50;
const DAY_MS = 24 * 3600 * 1000;
/** hour 粒度区间超过 7 天自动降级 day（接口文档口径） */
const HOUR_GRANULARITY_MAX_RANGE_MS = 7 * DAY_MS;
const SHANGHAI_TZ = 'Asia/Shanghai';
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

// ===== feat-A013：三国演义问答缓存（query→answer 语义缓存）存储层 =====
// 契约：api/feat-A013-query-cache.md §2（两张新表全列照抄）、§2.4（落库点）、§3.7（分布桶）、§3.5（embeddingBytes）。

/** 相似度分区下沿：低相似 < 0.80 / 灰色区 [0.80, hit_line)。本期固定写死、不对外配置（接口文档核心口径）。 */
export const CACHE_LOW_SIM_LINE = 0.8;
/** 分布图表桶宽与桶数（§3.7：桶宽 0.02 = 50 桶，0.80 / 0.92 恰为桶边界，着色不跨桶）。 */
export const CACHE_DISTRIBUTION_BUCKET_WIDTH = 0.02;
export const CACHE_DISTRIBUTION_BUCKET_COUNT = 50;
/** embeddingBytes 常量口径：1024 维 × 4B（§3.5）。 */
export const CACHE_EMBEDDING_BYTES = 1024 * 4;

/** 主表骨架初值：请求进入即落库（status=failed + 中断标注），回填后覆盖 */
const SKELETON_STATUS = 'failed';
const SKELETON_ERROR_MESSAGE = '请求中断未完成回填';
const SKELETON_RESPONSE_CODE = 500;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS request_logs (
  trace_id             TEXT PRIMARY KEY,
  log_type             TEXT NOT NULL,
  user_input           TEXT,
  domain               TEXT,
  status               TEXT NOT NULL,
  response_code        INTEGER NOT NULL,
  error_message        TEXT NOT NULL DEFAULT '',
  client_sent_at       INTEGER,
  server_received_at   INTEGER NOT NULL,
  handle_started_at    INTEGER,
  server_responded_at  INTEGER,
  client_received_at   INTEGER,
  answer               TEXT,
  citations            TEXT,
  route_source         TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_logs_received ON request_logs(server_received_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
CREATE TABLE IF NOT EXISTS llm_call_logs (
  trace_id           TEXT NOT NULL REFERENCES request_logs(trace_id) ON DELETE CASCADE,
  seq                INTEGER NOT NULL,
  stage              TEXT NOT NULL,
  model              TEXT NOT NULL,
  request_at         INTEGER NOT NULL,
  response_at        INTEGER,
  request_summary    TEXT,
  response_summary   TEXT,
  tool_calls         TEXT,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  cached_tokens      INTEGER,
  reasoning_tokens   INTEGER,
  attempt            INTEGER,
  input_breakdown    TEXT,
  max_tokens         INTEGER,
  finish_reason      TEXT,
  status             TEXT NOT NULL,
  error_message      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (trace_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_call_logs (
  trace_id         TEXT NOT NULL REFERENCES request_logs(trace_id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  mcp_server       TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  args_summary     TEXT,
  call_sent_at     INTEGER NOT NULL,
  call_returned_at INTEGER,
  result_summary   TEXT,
  status           TEXT NOT NULL,
  error_message    TEXT NOT NULL DEFAULT '',
  caller           TEXT,
  stage            TEXT,
  PRIMARY KEY (trace_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_retrieval_logs (
  trace_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  diagnostics TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (trace_id, seq),
  FOREIGN KEY (trace_id, seq) REFERENCES tool_call_logs(trace_id, seq) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_retrieval_logs_created ON tool_retrieval_logs(created_at);
CREATE TABLE IF NOT EXISTS cache_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  query_text     TEXT NOT NULL,
  embedding_b64  TEXT NOT NULL,
  answer_json    TEXT NOT NULL,
  answer_bytes   INTEGER NOT NULL,
  hit_count      INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  version_tag    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_entries_last_access ON cache_entries(last_access_at);
CREATE TABLE IF NOT EXISTS cache_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id      TEXT NOT NULL UNIQUE REFERENCES request_logs(trace_id) ON DELETE CASCADE,
  user_query    TEXT NOT NULL,
  nearest_query TEXT,
  similarity    REAL,
  hit_line      REAL NOT NULL,
  hit           INTEGER NOT NULL,
  tie_hits      INTEGER,
  marked        INTEGER NOT NULL DEFAULT 0,
  marked_by     TEXT,
  marked_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_logs_created ON cache_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_cache_logs_hit_created ON cache_logs(hit, created_at);
`;

/** feat-A012：输入分段 token 估算（本地启发式，见接口文档 §2.3）；history/tools 为保留字段当前恒 0 */
export interface InputBreakdown {
  system: number;
  user: number;
  injected: number;
  history: number;
  tools: number;
}

/** feat-A012：请求路由来源（request_logs.route_source）：
 * label = L1 前端标签；keyword = L2 关键词；vector = L3 向量；classify = 分类轮 1/2；free = 分类轮 99 兜底。
 * 历史行 / 未完成路由判定为 null。 */
export type RouteSource = "label" | "keyword" | "vector" | "classify" | "free";

export interface LlmCallPayload {
  /** 同 trace 内调用序号；缺省由存储层自增（从 1 起） */
  seq?: number | null;
  stage: string;
  model: string;
  requestAt: number;
  responseAt?: number | null;
  requestSummary?: string | null;
  responseSummary?: string | null;
  toolCalls?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** feat-A011：本次调用缓存命中 token 数；provider 未返回（或缺省调用方不传）为 null，与 promptTokens 同口径 */
  cachedTokens?: number | null;
  /** feat-A012：思考 token 数（provider 原值）；provider 未返回（或缺省调用方不传）为 null */
  reasoningTokens?: number | null;
  /** feat-A012：重试标识 1=首次 / 2=变参重试；服务端调用点显式传，历史行 / 未显式传值为 null（前端不推断） */
  attempt?: number | null;
  /** feat-A012：输入分段 token 估算对象；缺省不传 → null（历史行） */
  inputBreakdown?: InputBreakdown | null;
  /** feat-A012：本次调用输出上限（取调用点 params.max_tokens 原值）；历史行 / 缺省为 null */
  maxTokens?: number | null;
  finishReason?: string | null;
  status: 'success' | 'failed';
  errorMessage?: string;
}

/** bug-00019：工具调用发起方（model=模型自主调用；server=服务端预调）；历史行 / 未显式传值为 null */
export type ToolCallCaller = "model" | "server";

/** bug-00019：工具调用发起阶段（值域单一来源——调用点拼错阶段名即编译失败）：
 * l3 = L3 预检 / L3 命中后的题库预调；fastpath = L1 标签 / L2 关键词锁域后的域内快路径预调；
 * classify = 分类轮判定后的预调；generation = 生成轮模型自主调用（feat-A011 删除 tool-use 循环后无产生者，保留口径）；
 * admin = 后台 / 管理接口直调（非对话链路）。历史行 / 未显式传值为 null。 */
export type ToolCallStage = "l3" | "fastpath" | "classify" | "generation" | "admin";

export interface ToolCallPayload {
  seq?: number | null;
  mcpServer: string;
  toolName: string;
  argsSummary?: string | null;
  callSentAt: number;
  callReturnedAt?: number | null;
  resultSummary?: string | null;
  status: 'success' | 'failed';
  errorMessage?: string;
  /** bug-00019：调用方（model=模型自主调用 / server=服务端预调）；缺省不传 → null，不做推断 */
  caller?: ToolCallCaller | null;
  /** bug-00019：发起阶段（ToolCallStage 值域）；缺省不传 → null */
  stage?: ToolCallStage | null;
}

export interface ListQuery {
  pageNo?: number;
  pageSize?: number;
  logType?: string;
  domain?: string;
  traceId?: string;
  startAt?: number;
  endAt?: number;
  status?: string;
  responseCode?: number;
  keyword?: string;
}

export interface LogListItem {
  traceId: string;
  logType: string;
  userInput: string;
  domain: string | null;
  status: 'success' | 'failed';
  responseCode: number;
  errorMessage: string;
  serverReceivedAt: number;
  durations: {
    frontend: number | null;
    queueWait: number | null;
    server: number | null;
    llm: number | null;
    tool: number | null;
    total: number | null;
  };
  tokens: { input: number | null; output: number | null } | null;
  /** feat-A012：路由来源（列表行角标数据源）；历史行 / 未完成判定为 null */
  routeSource: RouteSource | null;
  /** feat-A012：该 trace 是否存在 attempt=2 调用（重试角标数据源）；历史行 false */
  hasRetry: boolean;
}

export interface LogDetailLog {
  traceId: string;
  logType: string;
  userInput: string | null;
  domain: string | null;
  /** feat-A012：请求路由来源；历史行 / 未完成路由判定为 null */
  routeSource: RouteSource | null;
  status: 'success' | 'failed';
  responseCode: number;
  errorMessage: string;
  clientSentAt: number | null;
  serverReceivedAt: number;
  handleStartedAt: number | null;
  serverRespondedAt: number | null;
  clientReceivedAt: number | null;
  answer: string | null;
  citations: string | null;
  createdAt: number;
}

export interface LlmCallLog {
  seq: number;
  stage: string;
  model: string;
  requestAt: number;
  responseAt: number | null;
  requestSummary: string | null;
  responseSummary: string | null;
  toolCalls: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  /** feat-A012：思考 token 数（provider 原值）；历史行 / provider 未返回为 null */
  reasoningTokens: number | null;
  /** feat-A012：重试标识 1=首次 / 2=变参重试；历史行为 null（前端不推断） */
  attempt: number | null;
  /** feat-A012：输入分段 token 估算（§2.3 折算规则）；历史行为 null */
  inputBreakdown: InputBreakdown | null;
  /** feat-A012：本次调用输出上限（调用点参数原值）；历史行为 null */
  maxTokens: number | null;
  finishReason: string | null;
  status: 'success' | 'failed';
  errorMessage: string;
}

export interface ToolCallLog {
  seq: number;
  mcpServer: string;
  toolName: string;
  argsSummary: string | null;
  callSentAt: number;
  callReturnedAt: number | null;
  resultSummary: string | null;
  status: 'success' | 'failed';
  errorMessage: string;
  /** bug-00019：调用方（model / server）；无值（历史行 / 未显式传值）为 null */
  caller: ToolCallCaller | null;
  /** bug-00019：发起阶段（ToolCallStage 值域）；无值为 null */
  stage: ToolCallStage | null;
  /** feat-A009：解析后的检索诊断对象；无诊断 / 旁路丢失 / 解析失败为 null */
  diagnostics: Record<string, unknown> | null;
}

export interface LogDetail {
  log: LogDetailLog;
  llmCalls: LlmCallLog[];
  toolCalls: ToolCallLog[];
}

export interface TokenBucket {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  /** feat-A012：桶内缓存命中 token 合计（历史 null 计 0） */
  cachedTokens: number;
}

export interface TokenStatsResult {
  granularity: 'day' | 'hour';
  timezone: string;
  startAt: number;
  endAt: number;
  buckets: TokenBucket[];
}

/** feat-A013：cache_logs 判定审计行入参（appendCacheLog；hit 布尔入参，落库转 1/0）。 */
export interface CacheLogPayload {
  /** 用户输入原文（trim 后） */
  userQuery: string;
  /** 最相近缓存条目原文（命中 = 命中条目；未命中 = 差点命中谁；池空 = null） */
  nearestQuery: string | null;
  /** 最高相似度（4 位小数由调用方按契约折算）；池空 = null */
  similarity: number | null;
  /** 本次请求生效命中线（历史行复算解释不随配置漂移） */
  hitLine: number;
  /** true = 命中 / false = 未命中 */
  hit: boolean;
  /** ≥ 命中线的候选条数：唯一候选=1；无候选=0；池空=null */
  tieHits: number | null;
}

/** feat-A013：cache_logs 行（查询返回；hit / marked 布尔化）。 */
export interface CacheLogRecord {
  id: number;
  traceId: string;
  userQuery: string;
  nearestQuery: string | null;
  similarity: number | null;
  hitLine: number;
  hit: boolean;
  tieHits: number | null;
  marked: boolean;
  markedBy: string | null;
  markedAt: number | null;
  createdAt: number;
}

/** feat-A013：灰色区 query 对明细行（§3.8 清单项）。 */
export interface GrayZoneLogItem {
  cacheLogId: number;
  traceId: string;
  createdAt: number;
  userQuery: string;
  nearestQuery: string | null;
  similarity: number | null;
  hitLine: number;
  marked: boolean;
}

/** feat-A013：相似度分布桶明细行（§3.11 下钻清单项；cacheLogId 对齐灰色区命名）。 */
export interface SimilarityRowsItem {
  cacheLogId: number;
  traceId: string;
  createdAt: number;
  userQuery: string;
  nearestQuery: string | null;
  similarity: number | null;
  hit: boolean;
  tieHits: number | null;
  hitLine: number;
  marked: boolean;
}

/** feat-A013：缓存条目命中记录行（§3.12 弹框展示：某请求命中了该条目）。 */
export interface CacheEntryHitItem {
  traceId: string;
  userQuery: string;
  similarity: number | null;
  createdAt: number;
  marked: boolean;
}

/** feat-A013：相似度分布桶明细过滤（§3.11 参数；bucketIndex 口径同 §3.7）。 */
export interface CacheLogBucketFilter {
  startAt: number;
  endAt: number;
  /** 0~49（§3.7 bucketIndex(sim) 同源） */
  bucketIndex: number;
  pageNo?: number;
  pageSize?: number;
}

/** feat-A013：灰色区清单过滤（§3.8 参数）。 */
export interface CacheLogsFilter {
  startAt: number;
  endAt: number;
  /** all（默认）/ marked / unmarked */
  marked?: 'all' | 'marked' | 'unmarked';
  /** 灰色区区间过滤（可选、可单传）：similarity ≥ min（含）；叠加在灰色区口径之上 */
  similarityMin?: number;
  /** 灰色区区间过滤（可选、可单传）：similarity ≤ max（含）；叠加在灰色区口径之上 */
  similarityMax?: number;
  pageNo?: number;
  pageSize?: number;
}

/** feat-A013：三色分布桶（§3.7：第 0~48 桶 [i×0.02, (i+1)×0.02)，第 49 桶 [0.98, 1.00] 含 1.0）。 */
export interface CacheDistributionBucket {
  lower: number;
  upper: number;
  count: number;
}

export interface CacheDistributionTotals {
  lowSimilar: number;
  grayZone: number;
  highConfidence: number;
  totalCount: number;
}

export interface CacheDistributionResult {
  buckets: CacheDistributionBucket[];
  totals: CacheDistributionTotals;
}

export interface CacheMisjudgeStats {
  hitTotal: number;
  markedMisjudge: number;
  /** 4 位小数；hitTotal=0 → null（页面显示「—」） */
  misjudgeRate: number | null;
}

/** feat-A013：cache_entries 写入入参（answerJson 由调用方序列化，answerBytes 与 §1.1 口径一致）。 */
export interface CacheEntryPayload {
  queryText: string;
  embeddingB64: string;
  answerJson: string;
  answerBytes: number;
  hitCount: number;
  lastAccessAt: number;
  createdAt: number;
  versionTag: string;
}

/** feat-A013：cache_entries 局部更新（命中计数 / 最后访问刷新；缺省字段保持不变）。 */
export interface CacheEntryUpdate {
  hitCount?: number;
  lastAccessAt?: number;
}

/** feat-A013：条目明细行（§3.5 载荷纪律：不含 embedding 与答案全文；embeddingBytes 为常量）。 */
export interface CacheEntryListItem {
  id: number;
  queryText: string;
  answerBytes: number;
  embeddingBytes: number;
  hitCount: number;
  lastAccessAt: number;
  createdAt: number;
}

export interface CacheEntryListOptions {
  pageNo: number;
  pageSize: number;
  sortBy: 'lastAccessAt' | 'hitCount';
  order: 'asc' | 'desc';
}

/**
 * feat-A013：cache_logs 命中解释 reason 派生（§2.2 区间归类 / §3.10 枚举，纯函数、单一实现点）：
 * hit → hit；sim=null 或 < 0.80 → miss-low；0.80 ≤ sim < hit_line → miss-gray；
 * sim ≥ hit_line 且 tie_hits ≥ 2 → miss-tie（歧义）；否则 miss-focus（焦点拒判）。
 */
export function deriveCacheReason(
  record: Pick<CacheLogRecord, 'hit' | 'similarity' | 'hitLine' | 'tieHits'>
): 'hit' | 'miss-low' | 'miss-gray' | 'miss-tie' | 'miss-focus' {
  if (record.hit) {
    return 'hit';
  }
  const similarity = record.similarity;
  if (similarity === null || similarity < CACHE_LOW_SIM_LINE) {
    return 'miss-low';
  }
  if (similarity < record.hitLine) {
    return 'miss-gray';
  }
  return record.tieHits !== null && record.tieHits >= 2 ? 'miss-tie' : 'miss-focus';
}

export interface LogStoreOptions {
  /** 数据库文件路径；默认 <cwd>/data/logs.db（目录不存在自动建） */
  dbPath?: string;
  /** 保留天数；默认读 LOG_RETENTION_DAYS，再缺省 30 */
  retentionDays?: number;
}

export interface LogStore {
  ensureSkeleton(
    logType: string,
    traceId: string,
    userInput: string | null,
    domain: string | null,
    receivedAt: number,
    clientSentAt?: number | null
  ): void;
  markHandled(traceId: string, handleStartedAt: number): void;
  markResponded(
    traceId: string,
    serverRespondedAt: number,
    status: 'success' | 'failed',
    responseCode: number,
    errorMessage: string,
    answer: string | null,
    citations: string | null
  ): void;
  appendLlmCall(traceId: string, payload: LlmCallPayload): void;
  /** 返回本次工具明细行号（tool_call_logs.seq，1 起）；写入失败 / no-op 降级为 null */
  appendToolCall(traceId: string, payload: ToolCallPayload): number | null;
  /** feat-A009：写入检索诊断（trace_id+seq 复合主键；诊断 JSON ≤64KB 已由 sango 截断）；失败静默 */
  appendRetrievalLog(traceId: string, seq: number, diagnostics: unknown): void;
  /** feat-A012：路由判定完成后回填 request_logs.route_source；旁路静默（失败不影响主流程） */
  reportRouteSource(traceId: string, routeSource: RouteSource): void;
  reportFrontendEnd(traceId: string, clientReceivedAt: number): void;
  queryList(query: ListQuery): { list: LogListItem[]; total: number };
  queryDetail(traceId: string): LogDetail | null;
  queryTokenStats(query: {
    startAt: number;
    endAt: number;
    granularity: 'day' | 'hour';
  }): TokenStatsResult;
  // ===== feat-A013：缓存存储（cache_logs / cache_entries；均同步直写，不经 A007 写缓冲） =====
  /** 判定审计落库：命中 / 未命中一律一行（旁路静默；trace_id 唯一，重复调用 OR IGNORE 跳过） */
  appendCacheLog(traceId: string, payload: CacheLogPayload): void;
  queryCacheLogByTrace(traceId: string): CacheLogRecord | null;
  /** 灰色区 query 对清单（§3.8 数据源：hit=0 AND 0.80 ≤ similarity < hit_line） */
  queryCacheLogs(filter: CacheLogsFilter): { list: GrayZoneLogItem[]; total: number };
  queryCacheDistribution(startAt: number, endAt: number): CacheDistributionResult;
  /** 相似度分布桶明细（§3.11 数据源：按 bucketIndex 过滤 cache_logs，供柱形下钻） */
  querySimilarityRows(filter: CacheLogBucketFilter): { list: SimilarityRowsItem[]; total: number };
  queryMisjudgeStats(startAt: number, endAt: number): CacheMisjudgeStats;
  /** 缓存条目命中记录（§3.12：cache_logs hit=1 且 nearest_query = 条目 query_text；条目不存在 → null 供 404） */
  queryEntryHits(
    entryId: number,
    pageNo: number,
    pageSize: number
  ): { list: CacheEntryHitItem[]; total: number } | null;
  /** 误判标记 / 取消：返回行是否存在（已标记重复标记幂等；不存在 → false 供 404） */
  updateCacheLogMark(id: number, marked: boolean, markedBy: string | null): boolean;
  /** 镜像写入：返回新条目自增 id（写入失败静默降级 null） */
  insertCacheEntry(payload: CacheEntryPayload): number | null;
  updateCacheEntry(id: number, update: CacheEntryUpdate): boolean;
  deleteCacheEntry(id: number): boolean;
  listCacheEntries(options: CacheEntryListOptions): { list: CacheEntryListItem[]; total: number };
  /** 全量清除：返回删除行数（§3.3 cleared = 清除前条目数） */
  clearCacheEntries(): number;
  countCacheEntries(): number;
  /** 立即把写缓冲批量落盘（测试 / 优雅退出用；生产由 1s 或 50 条自动触发） */
  flush(): void;
  /** 立即执行一次过期数据清理（每日定时器之外，供测试） */
  runRetentionCleanup(): void;
  close(): void;
}

/**
 * 字符串层截断：超长截取前 max 个字符，末尾追加「…（已截断）」（标记不计入上限）。
 * 非字符串（null / undefined）原样返回。
 */
export function truncate(
  value: string | null | undefined,
  max = MAX_CONTENT_LENGTH
): string | null | undefined {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, max) + TRUNCATE_MARKER;
}

interface RequestLogRow {
  trace_id: string;
  log_type: string;
  user_input: string | null;
  domain: string | null;
  status: string;
  response_code: number;
  error_message: string;
  client_sent_at: number | null;
  server_received_at: number;
  handle_started_at: number | null;
  server_responded_at: number | null;
  client_received_at: number | null;
  answer: string | null;
  citations: string | null;
  route_source: string | null;
  created_at: number;
}

interface LlmLogRow {
  seq: number;
  stage: string;
  model: string;
  request_at: number;
  response_at: number | null;
  request_summary: string | null;
  response_summary: string | null;
  tool_calls: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  attempt: number | null;
  input_breakdown: string | null;
  max_tokens: number | null;
  finish_reason: string | null;
  status: string;
  error_message: string;
}

interface ToolLogRow {
  seq: number;
  mcp_server: string;
  tool_name: string;
  args_summary: string | null;
  call_sent_at: number;
  call_returned_at: number | null;
  result_summary: string | null;
  status: string;
  error_message: string;
  caller: string | null;
  stage: string | null;
}

/** feat-A013：cache_logs DB 行（snake_case，映射见 mapCacheLogRow）。 */
interface CacheLogRow {
  id: number;
  trace_id: string;
  user_query: string;
  nearest_query: string | null;
  similarity: number | null;
  hit_line: number;
  hit: number;
  tie_hits: number | null;
  marked: number;
  marked_by: string | null;
  marked_at: number | null;
  created_at: number;
}

/** feat-A013：cache_entries 列表查询 DB 行（不含 embedding / 答案全文，载荷纪律 §3.5）。 */
interface CacheEntryListRow {
  id: number;
  query_text: string;
  answer_bytes: number;
  hit_count: number;
  last_access_at: number;
  created_at: number;
}

/** feat-A013：cache_logs DB 行 → 布尔化记录对象（hit / marked 1/0 → boolean）。 */
function mapCacheLogRow(row: CacheLogRow): CacheLogRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    userQuery: row.user_query,
    nearestQuery: row.nearest_query,
    similarity: row.similarity,
    hitLine: row.hit_line,
    hit: row.hit === 1,
    tieHits: row.tie_hits,
    marked: row.marked === 1,
    markedBy: row.marked_by,
    markedAt: row.marked_at,
    createdAt: row.created_at,
  };
}

interface ListRow extends RequestLogRow {
  llm_count: number;
  llm_duration: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_duration: number | null;
  /** feat-A012：该 trace 内最大 attempt（NULL 计 0）；=2 即存在重试 */
  max_attempt: number | null;
}

/** feat-A012：input_breakdown 列（JSON 串）解析为对象；缺失 / 非法 / 解析失败 → null（不炸前端） */
function parseInputBreakdown(raw: string | null): InputBreakdown | null {
  if (raw === null || raw === '') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InputBreakdown>;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.system === 'number' &&
      typeof parsed.user === 'number' &&
      typeof parsed.injected === 'number' &&
      typeof parsed.history === 'number' &&
      typeof parsed.tools === 'number'
    ) {
      return parsed as InputBreakdown;
    }
  } catch {
    // 旁路：解析失败按 null 处理
  }
  return null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function resolveRetentionDays(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const raw = process.env.LOG_RETENTION_DAYS;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/** Asia/Shanghai 本地时间分量（无夏令时，固定 UTC+8，日界 / 小时界在 JS 侧计算） */
const shanghaiPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHANGHAI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function shanghaiParts(ms: number): { year: string; month: string; day: string; hour: string } {
  const parts: Record<string, string> = {};
  for (const part of shanghaiPartsFormatter.formatToParts(ms)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
  };
}

/** 某时刻所在桶的起始时刻（epoch ms）：day = Asia/Shanghai 当日 00:00，hour = 整点 */
function bucketStartMs(ms: number, granularity: 'day' | 'hour'): number {
  const parts = shanghaiParts(ms);
  const hour = granularity === 'hour' ? Number(parts.hour) : 0;
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour) - SHANGHAI_OFFSET_MS;
}

function bucketLabel(ms: number, granularity: 'day' | 'hour'): string {
  const parts = shanghaiParts(ms);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return granularity === 'day' ? date : `${date}T${parts.hour}:00`;
}

function effectiveGranularity(
  granularity: 'day' | 'hour',
  startAt: number,
  endAt: number
): 'day' | 'hour' {
  if (granularity === 'hour' && endAt - startAt > HOUR_GRANULARITY_MAX_RANGE_MS) {
    return 'day';
  }
  return granularity;
}

/** 初始化失败（目录/文件不可写等）时的静默降级：写入 no-op、查询返回空，绝不影响调用方 */
function createNoopStore(): LogStore {
  const noopWrite = (): void => undefined;
  return {
    ensureSkeleton: noopWrite,
    markHandled: noopWrite,
    markResponded: noopWrite,
    appendLlmCall: noopWrite,
    appendToolCall: () => null,
    appendRetrievalLog: noopWrite,
    reportRouteSource: noopWrite,
    reportFrontendEnd: noopWrite,
    appendCacheLog: noopWrite,
    queryCacheLogByTrace: () => null,
    queryCacheLogs: () => ({ list: [], total: 0 }),
    queryCacheDistribution: () => ({
      buckets: [],
      totals: { lowSimilar: 0, grayZone: 0, highConfidence: 0, totalCount: 0 },
    }),
    querySimilarityRows: () => ({ list: [], total: 0 }),
    queryMisjudgeStats: () => ({ hitTotal: 0, markedMisjudge: 0, misjudgeRate: null }),
    queryEntryHits: () => null,
    updateCacheLogMark: () => false,
    insertCacheEntry: () => null,
    updateCacheEntry: () => false,
    deleteCacheEntry: () => false,
    listCacheEntries: () => ({ list: [], total: 0 }),
    clearCacheEntries: () => 0,
    countCacheEntries: () => 0,
    flush: noopWrite,
    runRetentionCleanup: noopWrite,
    close: noopWrite,
    queryList: () => ({ list: [], total: 0 }),
    queryDetail: () => null,
    queryTokenStats: (query) => ({
      granularity: effectiveGranularity(query.granularity, query.startAt, query.endAt),
      timezone: SHANGHAI_TZ,
      startAt: query.startAt,
      endAt: query.endAt,
      buckets: [],
    }),
  };
}

/**
 * 创建日志存储：打开 data/logs.db（目录不存在自动建）、建三表 + 索引，
 * 埋点写入先入内存队列（1 秒或 50 条一刷，单事务批量落盘），查询直接查库。
 * 任何写入 / 初始化失败只 console.error 告警，绝不影响调用方。
 */
export function createLogStore(options: LogStoreOptions = {}): LogStore {
  const dbPath = options.dbPath ?? resolve(DEFAULT_DB_PATH);
  const retentionDays = resolveRetentionDays(options.retentionDays);

  let db: Database.Database;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    // feat-A013 启动清镜像：每次启动 DELETE FROM cache_entries（防镜像残留展示陈旧数据，§1.1 / §2.3；
    // 幂等，残留即清）。cache_logs 是历史审计数据源，清除缓存不动它（§1.6 全量清除口径）。
    db.exec(`DELETE FROM cache_entries`);
    // feat-A011 旧库迁移：既有 llm_call_logs 缺 cached_tokens 列，补列（SQLite 缺省 NULL）；
    // 新库建表已含该列，重复执行（duplicate column）忽略，幂等。
    try {
      db.exec(`ALTER TABLE llm_call_logs ADD COLUMN cached_tokens INTEGER`);
    } catch {
      // 旁路：duplicate column 等忽略（新库 / 已迁移库）
    }
    // feat-A012 旧库迁移：llm_call_logs 增 reasoning_tokens / attempt / input_breakdown / max_tokens，
    // request_logs 增 route_source；历史行保持 NULL 不回填。新库建表已含各列，重复执行忽略，幂等。
    for (const column of ["reasoning_tokens", "attempt", "max_tokens"]) {
      try {
        db.exec(`ALTER TABLE llm_call_logs ADD COLUMN ${column} INTEGER`);
      } catch {
        // 旁路：duplicate column 等忽略
      }
    }
    try {
      db.exec(`ALTER TABLE llm_call_logs ADD COLUMN input_breakdown TEXT`);
    } catch {
      // 旁路：duplicate column 等忽略
    }
    try {
      db.exec(`ALTER TABLE request_logs ADD COLUMN route_source TEXT`);
    } catch {
      // 旁路：duplicate column 等忽略
    }
    // bug-00019 旧库迁移：既有 tool_call_logs 缺 caller（调用方）/ stage（发起阶段）两列，补列；
    // 历史行保持 NULL 不回填（无法事后推断发起方）。新库建表已含两列，重复执行忽略，幂等。
    for (const column of ["caller", "stage"]) {
      try {
        db.exec(`ALTER TABLE tool_call_logs ADD COLUMN ${column} TEXT`);
      } catch {
        // 旁路：duplicate column 等忽略（新库 / 已迁移库）
      }
    }
  } catch (error) {
    console.error('Failed to initialize log store (logging disabled):', error);
    return createNoopStore();
  }

  const insertSkeleton = db.prepare(`
    INSERT OR IGNORE INTO request_logs
      (trace_id, log_type, user_input, domain, status, response_code, error_message,
       client_sent_at, server_received_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const markHandledStmt = db.prepare(
    `UPDATE request_logs SET handle_started_at = ? WHERE trace_id = ?`
  );
  const markRespondedStmt = db.prepare(`
    UPDATE request_logs
    SET server_responded_at = ?, status = ?, response_code = ?, error_message = ?,
        answer = ?, citations = ?
    WHERE trace_id = ?
  `);
  const reportFrontendEndStmt = db.prepare(
    `UPDATE request_logs SET client_received_at = ? WHERE trace_id = ?`
  );
  const updateRouteSourceStmt = db.prepare(
    `UPDATE request_logs SET route_source = ? WHERE trace_id = ?`
  );
  const insertLlmCallStmt = db.prepare(`
    INSERT INTO llm_call_logs
      (trace_id, seq, stage, model, request_at, response_at, request_summary,
       response_summary, tool_calls, prompt_tokens, completion_tokens, cached_tokens,
       reasoning_tokens, attempt, input_breakdown, max_tokens,
       finish_reason, status, error_message)
    VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM llm_call_logs WHERE trace_id = ?),
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLlmCallWithSeqStmt = db.prepare(`
    INSERT OR IGNORE INTO llm_call_logs
      (trace_id, seq, stage, model, request_at, response_at, request_summary,
       response_summary, tool_calls, prompt_tokens, completion_tokens, cached_tokens,
       reasoning_tokens, attempt, input_breakdown, max_tokens,
       finish_reason, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolCallWithSeqStmt = db.prepare(`
    INSERT OR IGNORE INTO tool_call_logs
      (trace_id, seq, mcp_server, tool_name, args_summary, call_sent_at,
       call_returned_at, result_summary, status, error_message, caller, stage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMaxToolSeqStmt = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS m FROM tool_call_logs WHERE trace_id = ?`
  );
  const insertRetrievalLogStmt = db.prepare(`
    INSERT OR IGNORE INTO tool_retrieval_logs (trace_id, seq, diagnostics, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const deleteExpiredStmt = db.prepare(
    `DELETE FROM request_logs WHERE created_at < ?`
  );
  // ===== feat-A013：缓存存储准备语句（全部同步直写，不经 pendingOps 写缓冲） =====
  const insertCacheLogStmt = db.prepare(`
    INSERT OR IGNORE INTO cache_logs
      (trace_id, user_query, nearest_query, similarity, hit_line, hit, tie_hits,
       marked, marked_by, marked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)
  `);
  const queryCacheLogByTraceStmt = db.prepare(
    `SELECT * FROM cache_logs WHERE trace_id = ?`
  );
  /** feat-A013：cache_logs 父行（request_logs 骨架）存在性探针；缺失时先 flush 写缓冲再直写（见 appendCacheLog） */
  const cacheLogParentExistsStmt = db.prepare(
    `SELECT 1 FROM request_logs WHERE trace_id = ?`
  );
  const queryCacheLogExistsStmt = db.prepare(`SELECT id FROM cache_logs WHERE id = ?`);
  const updateCacheLogMarkStmt = db.prepare(
    `UPDATE cache_logs SET marked = ?, marked_by = ?, marked_at = ? WHERE id = ?`
  );
  const insertCacheEntryStmt = db.prepare(`
    INSERT INTO cache_entries
      (query_text, embedding_b64, answer_json, answer_bytes, hit_count, last_access_at, created_at, version_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateCacheEntryStmt = db.prepare(`
    UPDATE cache_entries
    SET hit_count = COALESCE(?, hit_count), last_access_at = COALESCE(?, last_access_at)
    WHERE id = ?
  `);
  const deleteCacheEntryStmt = db.prepare(`DELETE FROM cache_entries WHERE id = ?`);
  const getCacheEntryQueryTextStmt = db.prepare(
    `SELECT query_text FROM cache_entries WHERE id = ?`
  );
  const clearCacheEntriesStmt = db.prepare(`DELETE FROM cache_entries`);
  const countCacheEntriesStmt = db.prepare(
    `SELECT COUNT(*) AS total FROM cache_entries`
  );
  const pendingOps: Array<() => void> = [];

  /** feat-A009：各 trace 已分配待落盘的工具明细 seq（DB 未追平前的缓冲计数，防同秒连续调用撞号） */
  const pendingToolSeq = new Map<string, number>();

  const flush = (): void => {
    if (pendingOps.length === 0) {
      return;
    }
    const ops = pendingOps.splice(0);
    try {
      db.transaction(() => {
        for (const op of ops) {
          op();
        }
      })();
    } catch (error) {
      console.error('Failed to flush log writes:', error);
    }
  };

  const enqueue = (op: () => void): void => {
    pendingOps.push(op);
    if (pendingOps.length >= MAX_BUFFERED_OPS) {
      flush();
    }
  };

  const runRetentionCleanup = (): void => {
    try {
      deleteExpiredStmt.run(Date.now() - retentionDays * DAY_MS);
    } catch (error) {
      console.error('Failed to cleanup expired logs:', error);
    }
  };

  const flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  const cleanupTimer = setInterval(runRetentionCleanup, DAY_MS);
  cleanupTimer.unref();
  runRetentionCleanup();

  const queryListColumnsSql = `
    SELECT
      r.trace_id, r.log_type, r.user_input, r.domain, r.status, r.response_code, r.error_message,
      r.client_sent_at, r.server_received_at, r.handle_started_at, r.server_responded_at,
      r.client_received_at, r.created_at, r.route_source,
      (SELECT COUNT(*) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS llm_count,
      (SELECT SUM(l.response_at - l.request_at) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS llm_duration,
      (SELECT SUM(l.prompt_tokens) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS input_tokens,
      (SELECT SUM(l.completion_tokens) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS output_tokens,
      (SELECT SUM(t.call_returned_at - t.call_sent_at) FROM tool_call_logs t WHERE t.trace_id = r.trace_id) AS tool_duration,
      (SELECT MAX(l.attempt) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS max_attempt
    FROM request_logs r
  `;
  const queryDetailStmt = db.prepare(`SELECT * FROM request_logs WHERE trace_id = ?`);
  const queryLlmCallsStmt = db.prepare(
    `SELECT * FROM llm_call_logs WHERE trace_id = ? ORDER BY seq ASC`
  );
  const queryToolCallsStmt = db.prepare(
    `SELECT * FROM tool_call_logs WHERE trace_id = ? ORDER BY seq ASC`
  );
  const queryRetrievalStmt = db.prepare(
    `SELECT diagnostics FROM tool_retrieval_logs WHERE trace_id = ? AND seq = ?`
  );
  const queryTokenRowsStmt = db.prepare(
    `SELECT request_at, prompt_tokens, completion_tokens, cached_tokens
     FROM llm_call_logs WHERE request_at >= ? AND request_at <= ?`
  );

  const store: LogStore = {
    ensureSkeleton(
      logType,
      traceId,
      userInput,
      domain,
      receivedAt,
      clientSentAt = null
    ): void {
      enqueue(() => {
        insertSkeleton.run(
          traceId,
          logType,
          userInput ?? null,
          domain ?? null,
          SKELETON_STATUS,
          SKELETON_RESPONSE_CODE,
          SKELETON_ERROR_MESSAGE,
          clientSentAt ?? null,
          receivedAt,
          receivedAt
        );
      });
    },

    markHandled(traceId, handleStartedAt): void {
      enqueue(() => markHandledStmt.run(handleStartedAt, traceId));
    },

    markResponded(
      traceId,
      serverRespondedAt,
      status,
      responseCode,
      errorMessage,
      answer,
      citations
    ): void {
      enqueue(() => {
        markRespondedStmt.run(
          serverRespondedAt,
          status,
          responseCode,
          errorMessage ?? '',
          truncate(answer) ?? null,
          truncate(citations) ?? null,
          traceId
        );
      });
    },

    appendLlmCall(traceId, payload): void {
      enqueue(() => {
        const base = [
          payload.stage,
          payload.model,
          payload.requestAt,
          payload.responseAt ?? null,
          truncate(payload.requestSummary ?? null) ?? null,
          truncate(payload.responseSummary ?? null) ?? null,
          truncate(payload.toolCalls ?? null) ?? null,
          payload.promptTokens ?? null,
          payload.completionTokens ?? null,
          payload.cachedTokens ?? null,
          payload.reasoningTokens ?? null,
          payload.attempt ?? null,
          payload.inputBreakdown ? JSON.stringify(payload.inputBreakdown) : null,
          payload.maxTokens ?? null,
          payload.finishReason ?? null,
          payload.status,
          payload.errorMessage ?? '',
        ];
        if (payload.seq != null) {
          insertLlmCallWithSeqStmt.run(traceId, payload.seq, ...base);
        } else {
          insertLlmCallStmt.run(traceId, traceId, ...base);
        }
      });
    },

    appendToolCall(traceId, payload): number | null {
      // feat-A009：同步预计算 seq 并回传给调用方（transport 透传 agent 供回填落库）。
      // 正确性：同 trace 内工具调用串行（await 边界），但写入走 1s 缓冲——未落盘前 DB MAX 不前进，
      // 故需合并「已落库 MAX」与「待落盘缓冲中已分配的 seq」再 +1；跨 trace 互不影响。
      // 旁路：DB 不可读（连接已关闭等）时本次不分配、不入队，返回 null，绝不影响调用方。
      let seq: number | null;
      if (payload.seq != null) {
        seq = payload.seq;
      } else {
        try {
          const flushed =
            (selectMaxToolSeqStmt.get(traceId) as { m: number | null } | undefined)?.m ?? 0;
          seq = Math.max(flushed, pendingToolSeq.get(traceId) ?? 0) + 1;
        } catch (error) {
          console.error('Failed to read tool call seq:', error);
          return null;
        }
      }
      pendingToolSeq.set(traceId, seq);
      enqueue(() => {
        const base = [
          payload.mcpServer,
          payload.toolName,
          truncate(payload.argsSummary ?? null) ?? null,
          payload.callSentAt,
          payload.callReturnedAt ?? null,
          truncate(payload.resultSummary ?? null) ?? null,
          payload.status,
          payload.errorMessage ?? '',
          payload.caller ?? null,
          payload.stage ?? null,
        ];
        insertToolCallWithSeqStmt.run(traceId, seq, ...base);
      });
      // 缓冲 seq 表防膨胀：DB 已追平则清理该 trace 的待分配记录（低频 prune，不阻塞写入）
      if (pendingToolSeq.size > 5000) {
        for (const [trace, seqValue] of pendingToolSeq) {
          try {
            const flushed =
              (selectMaxToolSeqStmt.get(trace) as { m: number | null } | undefined)?.m ?? 0;
            if (seqValue <= flushed) {
              pendingToolSeq.delete(trace);
            }
          } catch {
            // 旁路：prune 失败忽略
          }
        }
      }
      return seq;
    },

    appendRetrievalLog(traceId, seq, diagnostics): void {
      let text: string;
      try {
        text = JSON.stringify(diagnostics);
      } catch (error) {
        console.error('Failed to serialize retrieval diagnostics:', error);
        return;
      }
      if (typeof text !== 'string') {
        return;
      }
      enqueue(() => {
        // INSERT OR IGNORE：幂等 + FK 行缺失（tool_call_logs 未落 / seq 对不上）时静默跳过，不影响其他写入（旁路）
        // 旁路（硬约束 4）：INSERT OR IGNORE 不忽略 FK 约束，seq 无对应 tool_call 行会抛错——
        // 单条 try/catch 静默跳过，绝不影响同事务其它写入与主流程（落库失败告警即可，不重试）
        try {
          insertRetrievalLogStmt.run(traceId, seq, text, Date.now());
        } catch (error) {
          console.error('Failed to write retrieval diagnostics (bypass):', error);
        }
      });
    },

    /** feat-A012：路由判定完成后回填路由来源；旁路静默（骨架行必然存在，失败不影响主流程） */
    reportRouteSource(traceId, routeSource): void {
      enqueue(() => {
        try {
          updateRouteSourceStmt.run(routeSource, traceId);
        } catch (error) {
          console.error('Failed to update route_source (bypass):', error);
        }
      });
    },

    reportFrontendEnd(traceId, clientReceivedAt): void {
      enqueue(() => reportFrontendEndStmt.run(clientReceivedAt, traceId));
    },

    queryList(query): { list: LogListItem[]; total: number } {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (query.logType !== undefined) {
        where.push('r.log_type = ?');
        params.push(query.logType);
      }
      if (query.domain !== undefined) {
        where.push('r.domain = ?');
        params.push(query.domain);
      }
      if (query.traceId !== undefined) {
        where.push('r.trace_id = ?');
        params.push(query.traceId);
      }
      if (query.startAt !== undefined) {
        where.push('r.server_received_at >= ?');
        params.push(query.startAt);
      }
      if (query.endAt !== undefined) {
        where.push('r.server_received_at <= ?');
        params.push(query.endAt);
      }
      if (query.status !== undefined) {
        where.push('r.status = ?');
        params.push(query.status);
      }
      if (query.responseCode !== undefined) {
        where.push('r.response_code = ?');
        params.push(query.responseCode);
      }
      if (query.keyword !== undefined && query.keyword !== '') {
        where.push("r.user_input LIKE '%' || ? || '%'");
        params.push(query.keyword);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM request_logs r ${whereSql}`)
        .get(...params) as { total: number };
      const total = countRow.total;

      const pageNo = Math.max(1, query.pageNo ?? 1);
      const pageSizeRaw = query.pageSize ?? 20;
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
      const rows = db
        .prepare(
          `${queryListColumnsSql} ${whereSql} ORDER BY r.server_received_at DESC LIMIT ? OFFSET ?`
        )
        .all(...params, pageSize, (pageNo - 1) * pageSize) as ListRow[];

      return {
        total,
        list: rows.map((row) => {
          const durations: LogListItem['durations'] = {
            frontend:
              isNumber(row.client_sent_at) &&
              isNumber(row.server_received_at) &&
              isNumber(row.server_responded_at) &&
              isNumber(row.client_received_at)
                ? row.server_received_at -
                  row.client_sent_at +
                  (row.client_received_at - row.server_responded_at)
                : null,
            queueWait:
              isNumber(row.handle_started_at) && isNumber(row.server_received_at)
                ? row.handle_started_at - row.server_received_at
                : null,
            server:
              isNumber(row.server_responded_at) && isNumber(row.server_received_at)
                ? row.server_responded_at - row.server_received_at
                : null,
            llm: row.llm_duration,
            tool: row.tool_duration,
            total:
              isNumber(row.client_received_at) && isNumber(row.client_sent_at)
                ? row.client_received_at - row.client_sent_at
                : null,
          };
          return {
            traceId: row.trace_id,
            logType: row.log_type,
            userInput: truncate(row.user_input, LIST_SUMMARY_LENGTH) ?? '',
            domain: row.domain,
            status: row.status as 'success' | 'failed',
            responseCode: row.response_code,
            errorMessage: row.error_message,
            serverReceivedAt: row.server_received_at,
            durations,
            // 无 LLM 调用整体 null；有调用但 usage 缺失（NULL）的列 SUM 后为 null
            tokens:
              row.llm_count === 0
                ? null
                : { input: row.input_tokens, output: row.output_tokens },
            routeSource: row.route_source as RouteSource | null,
            hasRetry: row.max_attempt === 2,
          };
        }),
      };
    },

    queryDetail(traceId): LogDetail | null {
      const row = queryDetailStmt.get(traceId) as RequestLogRow | undefined;
      if (row === undefined) {
        return null;
      }
      const llmCalls = (queryLlmCallsStmt.all(traceId) as LlmLogRow[]).map(
        (llm): LlmCallLog => ({
          seq: llm.seq,
          stage: llm.stage,
          model: llm.model,
          requestAt: llm.request_at,
          responseAt: llm.response_at,
          requestSummary: llm.request_summary,
          responseSummary: llm.response_summary,
          toolCalls: llm.tool_calls,
          promptTokens: llm.prompt_tokens,
          completionTokens: llm.completion_tokens,
          cachedTokens: llm.cached_tokens,
          reasoningTokens: llm.reasoning_tokens,
          attempt: llm.attempt,
          inputBreakdown: parseInputBreakdown(llm.input_breakdown),
          maxTokens: llm.max_tokens,
          finishReason: llm.finish_reason,
          status: llm.status as 'success' | 'failed',
          errorMessage: llm.error_message,
        })
      );
      const toolCalls = (queryToolCallsStmt.all(traceId) as ToolLogRow[]).map(
        (tool): ToolCallLog => {
          // feat-A009：工具明细附检索诊断（解析后对象；无行 / 解析失败 → null，不炸前端）
          const retrieval = queryRetrievalStmt.get(traceId, tool.seq) as
            | { diagnostics: string }
            | undefined;
          let diagnostics: Record<string, unknown> | null = null;
          if (retrieval) {
            try {
              diagnostics = JSON.parse(retrieval.diagnostics) as Record<string, unknown>;
            } catch {
              diagnostics = null;
            }
          }
          return {
            seq: tool.seq,
            mcpServer: tool.mcp_server,
            toolName: tool.tool_name,
            argsSummary: tool.args_summary,
            callSentAt: tool.call_sent_at,
            callReturnedAt: tool.call_returned_at,
            resultSummary: tool.result_summary,
            status: tool.status as 'success' | 'failed',
            errorMessage: tool.error_message,
            caller: tool.caller as ToolCallCaller | null,
            stage: tool.stage as ToolCallStage | null,
            diagnostics,
          };
        }
      );
      return {
        log: {
          traceId: row.trace_id,
          logType: row.log_type,
          userInput: row.user_input,
          domain: row.domain,
          routeSource: row.route_source as RouteSource | null,
          status: row.status as 'success' | 'failed',
          responseCode: row.response_code,
          errorMessage: row.error_message,
          clientSentAt: row.client_sent_at,
          serverReceivedAt: row.server_received_at,
          handleStartedAt: row.handle_started_at,
          serverRespondedAt: row.server_responded_at,
          clientReceivedAt: row.client_received_at,
          answer: row.answer,
          citations: row.citations,
          createdAt: row.created_at,
        },
        llmCalls,
        toolCalls,
      };
    },

    queryTokenStats(query): TokenStatsResult {
      const granularity = effectiveGranularity(query.granularity, query.startAt, query.endAt);
      const rows = queryTokenRowsStmt.all(query.startAt, query.endAt) as Array<{
        request_at: number;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        cached_tokens: number | null;
      }>;
      const accumulated = new Map<number, { input: number; output: number; cached: number }>();
      for (const row of rows) {
        const start = bucketStartMs(row.request_at, granularity);
        const current = accumulated.get(start) ?? { input: 0, output: 0, cached: 0 };
        current.input += row.prompt_tokens ?? 0;
        current.output += row.completion_tokens ?? 0;
        current.cached += row.cached_tokens ?? 0;
        accumulated.set(start, current);
      }
      const step = granularity === 'day' ? DAY_MS : 3600 * 1000;
      const buckets: TokenBucket[] = [];
      const first = bucketStartMs(query.startAt, granularity);
      const last = bucketStartMs(query.endAt, granularity);
      for (let cursor = first; cursor <= last; cursor += step) {
        const current = accumulated.get(cursor);
        buckets.push({
          bucket: bucketLabel(cursor, granularity),
          inputTokens: current?.input ?? 0,
          outputTokens: current?.output ?? 0,
          cachedTokens: current?.cached ?? 0,
        });
      }
      return {
        granularity,
        timezone: SHANGHAI_TZ,
        startAt: query.startAt,
        endAt: query.endAt,
        buckets,
      };
    },

    // ===== feat-A013：缓存存储实现（cache_logs / cache_entries；均同步直写，不经 pendingOps 写缓冲；
    // 写入旁路静默——失败 console.error 告警，绝不影响判定主流程） =====

    appendCacheLog(traceId, payload): void {
      // request_logs 骨架行走 A007 写缓冲（1s / 50 条），判定时刻父行可能未落盘；先探父行，
      // 缺失则 flush 把骨架补齐再直写——cache_logs 是图表 / 误判率唯一数据源，不允许因缓冲时序空窗丢行
      // （§2.4 强一致对账口径）。父行真实缺失（骨架未建）→ 单条 try/catch 静默告警，绝不影响判定主流程。
      try {
        if (cacheLogParentExistsStmt.get(traceId) === undefined) {
          flush();
        }
        insertCacheLogStmt.run(
          traceId,
          payload.userQuery,
          payload.nearestQuery ?? null,
          payload.similarity ?? null,
          payload.hitLine,
          payload.hit ? 1 : 0,
          payload.tieHits ?? null,
          Date.now()
        );
      } catch (error) {
        console.error('Failed to write cache_logs (bypass):', error);
      }
    },

    queryCacheLogByTrace(traceId): CacheLogRecord | null {
      const row = queryCacheLogByTraceStmt.get(traceId) as CacheLogRow | undefined;
      return row === undefined ? null : mapCacheLogRow(row);
    },

    queryCacheLogs(filter): { list: GrayZoneLogItem[]; total: number } {
      // §3.8 口径：hit=0 AND 0.80 ≤ similarity < hit_line（hit_line 取各行生效值，历史行不随配置漂移）；
      // marked 过滤：all（默认）/ marked / unmarked
      const conditions = [
        'hit = 0',
        'similarity >= ?',
        'similarity < hit_line',
        'created_at >= ?',
        'created_at <= ?',
      ];
      const params: Array<string | number> = [CACHE_LOW_SIM_LINE, filter.startAt, filter.endAt];
      if (filter.similarityMin !== undefined) {
        conditions.push('similarity >= ?');
        params.push(filter.similarityMin);
      }
      if (filter.similarityMax !== undefined) {
        conditions.push('similarity <= ?');
        params.push(filter.similarityMax);
      }
      if (filter.marked === 'marked') {
        conditions.push('marked = 1');
      } else if (filter.marked === 'unmarked') {
        conditions.push('marked = 0');
      }
      const whereSql = `WHERE ${conditions.join(' AND ')}`;
      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM cache_logs ${whereSql}`)
        .get(...params) as { total: number };
      const total = countRow.total;
      const pageNo = Math.max(1, filter.pageNo ?? 1);
      const pageSizeRaw = filter.pageSize ?? 20;
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
      const rows = db
        .prepare(
          `SELECT id, trace_id, created_at, user_query, nearest_query, similarity, hit_line, marked
           FROM cache_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, pageSize, (pageNo - 1) * pageSize) as Array<{
        id: number;
        trace_id: string;
        created_at: number;
        user_query: string;
        nearest_query: string | null;
        similarity: number | null;
        hit_line: number;
        marked: number;
      }>;
      return {
        total,
        list: rows.map((row) => ({
          cacheLogId: row.id,
          traceId: row.trace_id,
          createdAt: row.created_at,
          userQuery: row.user_query,
          nearestQuery: row.nearest_query,
          similarity: row.similarity,
          hitLine: row.hit_line,
          marked: row.marked === 1,
        })),
      };
    },

    queryCacheDistribution(startAt, endAt): CacheDistributionResult {
      const rows = db
        .prepare(
          `SELECT similarity, hit_line FROM cache_logs WHERE created_at >= ? AND created_at <= ?`
        )
        .all(startAt, endAt) as Array<{ similarity: number | null; hit_line: number }>;
      // §3.7：50 桶，第 0~48 桶 [i×0.02, (i+1)×0.02)，第 49 桶 [0.98, 1.00]（含 1.0）；
      // 上下界四舍五入到 2 位小数（0.80 / 0.92 恰为桶边界，防 0.02 浮点误差破坏着色分界）
      const buckets: CacheDistributionBucket[] = [];
      for (let i = 0; i < CACHE_DISTRIBUTION_BUCKET_COUNT; i += 1) {
        const lower = Math.round(i * CACHE_DISTRIBUTION_BUCKET_WIDTH * 100) / 100;
        const upper =
          i === CACHE_DISTRIBUTION_BUCKET_COUNT - 1
            ? 1
            : Math.round((i + 1) * CACHE_DISTRIBUTION_BUCKET_WIDTH * 100) / 100;
        buckets.push({ lower, upper, count: 0 });
      }
      let lowSimilar = 0;
      let grayZone = 0;
      let highConfidence = 0;
      for (const row of rows) {
        const similarity = row.similarity;
        // bucketIndex(sim)：sim=null → 0（池空行落桶 0）；sim=1.0 → min(floor(50), 49) = 49
        const index =
          similarity === null
            ? 0
            : Math.min(
                Math.floor(similarity / CACHE_DISTRIBUTION_BUCKET_WIDTH),
                CACHE_DISTRIBUTION_BUCKET_COUNT - 1
              );
        buckets[index].count += 1;
        // 三档派生（§3.7 区间着色口径）：低相似（含池空 sim=null）/ 灰色区 [0.80, hit_line) / 高置信 ≥ hit_line
        if (similarity === null || similarity < CACHE_LOW_SIM_LINE) {
          lowSimilar += 1;
        } else if (similarity < row.hit_line) {
          grayZone += 1;
        } else {
          highConfidence += 1;
        }
      }
      return {
        buckets,
        totals: { lowSimilar, grayZone, highConfidence, totalCount: rows.length },
      };
    },

    querySimilarityRows(filter): { list: SimilarityRowsItem[]; total: number } {
      // §3.11 桶过滤口径（与 §3.7 bucketIndex(sim) 同源，桶边界含下不含上）：
      // 0 → sim IS NULL OR sim < 0.02；1≤i≤48 → i×0.02 ≤ sim < (i+1)×0.02；49 → 0.98 ≤ sim ≤ 1.00
      let similarityCondition: string;
      let similarityParams: number[];
      if (filter.bucketIndex === 0) {
        similarityCondition = '(similarity IS NULL OR similarity < ?)';
        similarityParams = [CACHE_DISTRIBUTION_BUCKET_WIDTH];
      } else if (filter.bucketIndex >= CACHE_DISTRIBUTION_BUCKET_COUNT - 1) {
        similarityCondition = '(similarity >= ? AND similarity <= ?)';
        similarityParams = [
          (CACHE_DISTRIBUTION_BUCKET_COUNT - 1) * CACHE_DISTRIBUTION_BUCKET_WIDTH,
          1,
        ];
      } else {
        similarityCondition = '(similarity >= ? AND similarity < ?)';
        similarityParams = [
          filter.bucketIndex * CACHE_DISTRIBUTION_BUCKET_WIDTH,
          (filter.bucketIndex + 1) * CACHE_DISTRIBUTION_BUCKET_WIDTH,
        ];
      }
      const conditions = ['created_at >= ?', 'created_at <= ?', similarityCondition];
      const params: Array<string | number> = [filter.startAt, filter.endAt, ...similarityParams];
      const whereSql = `WHERE ${conditions.join(' AND ')}`;
      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM cache_logs ${whereSql}`)
        .get(...params) as { total: number };
      const total = countRow.total;
      const pageNo = Math.max(1, filter.pageNo ?? 1);
      const pageSizeRaw = filter.pageSize ?? 20;
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw));
      const rows = db
        .prepare(
          `SELECT id, trace_id, created_at, user_query, nearest_query, similarity, hit, tie_hits, hit_line, marked
           FROM cache_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, pageSize, (pageNo - 1) * pageSize) as Array<{
        id: number;
        trace_id: string;
        created_at: number;
        user_query: string;
        nearest_query: string | null;
        similarity: number | null;
        hit: number;
        tie_hits: number | null;
        hit_line: number;
        marked: number;
      }>;
      return {
        total,
        list: rows.map((row) => ({
          cacheLogId: row.id,
          traceId: row.trace_id,
          createdAt: row.created_at,
          userQuery: row.user_query,
          nearestQuery: row.nearest_query,
          similarity: row.similarity,
          hit: row.hit === 1,
          tieHits: row.tie_hits,
          hitLine: row.hit_line,
          marked: row.marked === 1,
        })),
      };
    },

    queryMisjudgeStats(startAt, endAt): CacheMisjudgeStats {
      const hitRow = db
        .prepare(
          `SELECT COUNT(*) AS total FROM cache_logs WHERE hit = 1 AND created_at >= ? AND created_at <= ?`
        )
        .get(startAt, endAt) as { total: number };
      const markedRow = db
        .prepare(
          `SELECT COUNT(*) AS total FROM cache_logs WHERE hit = 1 AND marked = 1 AND created_at >= ? AND created_at <= ?`
        )
        .get(startAt, endAt) as { total: number };
      const hitTotal = hitRow.total;
      const markedMisjudge = markedRow.total;
      // §3.9：误判率 4 位小数；hitTotal=0 → null（页面显示「—」）
      return {
        hitTotal,
        markedMisjudge,
        misjudgeRate:
          hitTotal === 0 ? null : Math.round((markedMisjudge / hitTotal) * 10000) / 10000,
      };
    },

    updateCacheLogMark(id, marked, markedBy): boolean {
      try {
        const result = updateCacheLogMarkStmt.run(
          marked ? 1 : 0,
          marked ? (markedBy ?? null) : null,
          marked ? Date.now() : null,
          id
        );
        if (result.changes > 0) {
          return true;
        }
        // 幂等：行已存在但值未变（重复标记 / 重复取消）→ 按存在性返回 true；id 不存在 → false（404）
        return queryCacheLogExistsStmt.get(id) !== undefined;
      } catch (error) {
        console.error('Failed to update cache_logs mark (bypass):', error);
        return false;
      }
    },

    insertCacheEntry(payload): number | null {
      try {
        const info = insertCacheEntryStmt.run(
          payload.queryText,
          payload.embeddingB64,
          payload.answerJson,
          payload.answerBytes,
          payload.hitCount,
          payload.lastAccessAt,
          payload.createdAt,
          payload.versionTag
        );
        return Number(info.lastInsertRowid);
      } catch (error) {
        console.error('Failed to insert cache entry (bypass):', error);
        return null;
      }
    },

    updateCacheEntry(id, update): boolean {
      try {
        // COALESCE：缺省字段保持原值（命中计数 / 最后访问刷新二选一或同时）
        const result = updateCacheEntryStmt.run(
          update.hitCount ?? null,
          update.lastAccessAt ?? null,
          id
        );
        return result.changes > 0;
      } catch (error) {
        console.error('Failed to update cache entry (bypass):', error);
        return false;
      }
    },

    deleteCacheEntry(id): boolean {
      try {
        return deleteCacheEntryStmt.run(id).changes > 0;
      } catch (error) {
        console.error('Failed to delete cache entry (bypass):', error);
        return false;
      }
    },

    listCacheEntries(options): { list: CacheEntryListItem[]; total: number } {
      // §3.5：sortBy / order 白名单（API 已校验，此处防御性兜底默认 lastAccessAt / desc）
      const sortColumn = options.sortBy === 'hitCount' ? 'hit_count' : 'last_access_at';
      const orderSql = options.order === 'asc' ? 'ASC' : 'DESC';
      const pageNo = Math.max(1, options.pageNo);
      const pageSize = Math.min(100, Math.max(1, options.pageSize));
      const countRow = countCacheEntriesStmt.get() as { total: number };
      const rows = db
        .prepare(
          `SELECT id, query_text, answer_bytes, hit_count, last_access_at, created_at
           FROM cache_entries ORDER BY ${sortColumn} ${orderSql}, id ${orderSql} LIMIT ? OFFSET ?`
        )
        .all(pageSize, (pageNo - 1) * pageSize) as CacheEntryListRow[];
      return {
        total: countRow.total,
        list: rows.map((row) => ({
          id: row.id,
          queryText: row.query_text,
          answerBytes: row.answer_bytes,
          embeddingBytes: CACHE_EMBEDDING_BYTES,
          hitCount: row.hit_count,
          lastAccessAt: row.last_access_at,
          createdAt: row.created_at,
        })),
      };
    },

    queryEntryHits(entryId, pageNo, pageSize): { list: CacheEntryHitItem[]; total: number } | null {
      // §3.12 口径：cache_logs 中 hit=1 且 nearest_query = 条目 query_text（命中该条目的请求）；条目不存在 → null（404）
      const entry = getCacheEntryQueryTextStmt.get(entryId) as { query_text: string } | undefined;
      if (entry === undefined) {
        return null;
      }
      const pageNoSafe = Math.max(1, pageNo);
      const pageSizeSafe = Math.min(100, Math.max(1, pageSize));
      const whereSql = 'WHERE hit = 1 AND nearest_query = ?';
      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM cache_logs ${whereSql}`)
        .get(entry.query_text) as { total: number };
      const rows = db
        .prepare(
          `SELECT trace_id, user_query, similarity, created_at, marked
           FROM cache_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
        )
        .all(entry.query_text, pageSizeSafe, (pageNoSafe - 1) * pageSizeSafe) as Array<{
        trace_id: string;
        user_query: string;
        similarity: number | null;
        created_at: number;
        marked: number;
      }>;
      return {
        total: countRow.total,
        list: rows.map((row) => ({
          traceId: row.trace_id,
          userQuery: row.user_query,
          similarity: row.similarity,
          createdAt: row.created_at,
          marked: row.marked === 1,
        })),
      };
    },

    clearCacheEntries(): number {
      try {
        return clearCacheEntriesStmt.run().changes;
      } catch (error) {
        console.error('Failed to clear cache entries (bypass):', error);
        return 0;
      }
    },

    countCacheEntries(): number {
      const row = countCacheEntriesStmt.get() as { total: number };
      return row.total;
    },

    flush,
    runRetentionCleanup,

    close(): void {
      clearInterval(flushTimer);
      clearInterval(cleanupTimer);
      try {
        flush();
      } catch {
        // 旁路：关闭阶段的落盘失败不阻断
      }
      try {
        db.close();
      } catch {
        // 旁路：重复关闭等忽略
      }
    },
  };

  return store;
}

let sharedStore: LogStore | null = null;

/** 进程级共享存储（server.ts 埋点与 小胡 agent/transport 明细共用同一实例 / 同一 DB 连接） */
export function getLogStore(): LogStore {
  if (sharedStore === null) {
    sharedStore = createLogStore();
  }
  return sharedStore;
}

// 模块级便捷函数：小胡 agent.ts / transport.ts 埋点直接 import（与 server.ts 共用同一实例）
export function ensureSkeleton(
  logType: string,
  traceId: string,
  userInput: string | null,
  domain: string | null,
  receivedAt: number,
  clientSentAt?: number | null
): void {
  getLogStore().ensureSkeleton(logType, traceId, userInput, domain, receivedAt, clientSentAt);
}

export function markHandled(traceId: string, handleStartedAt: number): void {
  getLogStore().markHandled(traceId, handleStartedAt);
}

export function markResponded(
  traceId: string,
  serverRespondedAt: number,
  status: 'success' | 'failed',
  responseCode: number,
  errorMessage: string,
  answer: string | null,
  citations: string | null
): void {
  getLogStore().markResponded(
    traceId,
    serverRespondedAt,
    status,
    responseCode,
    errorMessage,
    answer,
    citations
  );
}

export function appendLlmCall(traceId: string, payload: LlmCallPayload): void {
  getLogStore().appendLlmCall(traceId, payload);
}

export function appendToolCall(traceId: string, payload: ToolCallPayload): number | null {
  return getLogStore().appendToolCall(traceId, payload);
}

/** feat-A009：写入检索诊断（trace_id+seq 复合主键）；失败静默，不影响主流程（旁路） */
export function appendRetrievalLog(traceId: string, seq: number, diagnostics: unknown): void {
  getLogStore().appendRetrievalLog(traceId, seq, diagnostics);
}

/** feat-A012：路由判定完成后回填路由来源（agent.ts processQueryData 调用；旁路静默，失败不影响主流程） */
export function reportRouteSource(traceId: string, routeSource: RouteSource): void {
  getLogStore().reportRouteSource(traceId, routeSource);
}

export function reportFrontendEnd(traceId: string, clientReceivedAt: number): void {
  getLogStore().reportFrontendEnd(traceId, clientReceivedAt);
}

// ===== feat-A013：缓存存储模块级便捷函数（小胡 cache.ts / 后台 API 直调，与既有埋点函数同模式） =====

/** feat-A013：判定审计落库（命中 / 未命中一律一行；旁路静默，失败不影响主流程） */
export function appendCacheLog(traceId: string, payload: CacheLogPayload): void {
  getLogStore().appendCacheLog(traceId, payload);
}

export function queryCacheLogByTrace(traceId: string): CacheLogRecord | null {
  return getLogStore().queryCacheLogByTrace(traceId);
}

/** feat-A013：灰色区 query 对清单（§3.8 数据源） */
export function queryCacheLogs(filter: CacheLogsFilter): { list: GrayZoneLogItem[]; total: number } {
  return getLogStore().queryCacheLogs(filter);
}

export function queryCacheDistribution(startAt: number, endAt: number): CacheDistributionResult {
  return getLogStore().queryCacheDistribution(startAt, endAt);
}

export function querySimilarityRows(
  filter: CacheLogBucketFilter
): { list: SimilarityRowsItem[]; total: number } {
  return getLogStore().querySimilarityRows(filter);
}

export function queryMisjudgeStats(startAt: number, endAt: number): CacheMisjudgeStats {
  return getLogStore().queryMisjudgeStats(startAt, endAt);
}

/** feat-A013：缓存条目命中记录（§3.12 数据源，条目不存在 → null） */
export function queryEntryHits(
  entryId: number,
  pageNo: number,
  pageSize: number
): { list: CacheEntryHitItem[]; total: number } | null {
  return getLogStore().queryEntryHits(entryId, pageNo, pageSize);
}

/** feat-A013：误判标记 / 取消；返回行是否存在（不存在 → false 供 404） */
export function updateCacheLogMark(id: number, marked: boolean, markedBy: string | null): boolean {
  return getLogStore().updateCacheLogMark(id, marked, markedBy);
}

/** feat-A013：缓存条目镜像写入，返回新条目自增 id（写入失败静默降级 null） */
export function insertCacheEntry(payload: CacheEntryPayload): number | null {
  return getLogStore().insertCacheEntry(payload);
}

export function updateCacheEntry(id: number, update: CacheEntryUpdate): boolean {
  return getLogStore().updateCacheEntry(id, update);
}

export function deleteCacheEntry(id: number): boolean {
  return getLogStore().deleteCacheEntry(id);
}

export function listCacheEntries(
  options: CacheEntryListOptions
): { list: CacheEntryListItem[]; total: number } {
  return getLogStore().listCacheEntries(options);
}

export function clearCacheEntries(): number {
  return getLogStore().clearCacheEntries();
}

export function countCacheEntries(): number {
  return getLogStore().countCacheEntries();
}
