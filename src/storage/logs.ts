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
  PRIMARY KEY (trace_id, seq)
);
`;

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
  finishReason?: string | null;
  status: 'success' | 'failed';
  errorMessage?: string;
}

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
}

export interface ListQuery {
  pageNo?: number;
  pageSize?: number;
  logType?: string;
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
}

export interface LogDetailLog {
  traceId: string;
  logType: string;
  userInput: string | null;
  domain: string | null;
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
}

export interface TokenStatsResult {
  granularity: 'day' | 'hour';
  timezone: string;
  startAt: number;
  endAt: number;
  buckets: TokenBucket[];
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
  appendToolCall(traceId: string, payload: ToolCallPayload): void;
  reportFrontendEnd(traceId: string, clientReceivedAt: number): void;
  queryList(query: ListQuery): { list: LogListItem[]; total: number };
  queryDetail(traceId: string): LogDetail | null;
  queryTokenStats(query: {
    startAt: number;
    endAt: number;
    granularity: 'day' | 'hour';
  }): TokenStatsResult;
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
}

interface ListRow extends RequestLogRow {
  llm_count: number;
  llm_duration: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool_duration: number | null;
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
    appendToolCall: noopWrite,
    reportFrontendEnd: noopWrite,
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
  const insertLlmCallStmt = db.prepare(`
    INSERT INTO llm_call_logs
      (trace_id, seq, stage, model, request_at, response_at, request_summary,
       response_summary, tool_calls, prompt_tokens, completion_tokens, finish_reason,
       status, error_message)
    VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM llm_call_logs WHERE trace_id = ?),
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLlmCallWithSeqStmt = db.prepare(`
    INSERT OR IGNORE INTO llm_call_logs
      (trace_id, seq, stage, model, request_at, response_at, request_summary,
       response_summary, tool_calls, prompt_tokens, completion_tokens, finish_reason,
       status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolCallStmt = db.prepare(`
    INSERT INTO tool_call_logs
      (trace_id, seq, mcp_server, tool_name, args_summary, call_sent_at,
       call_returned_at, result_summary, status, error_message)
    VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_call_logs WHERE trace_id = ?),
            ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertToolCallWithSeqStmt = db.prepare(`
    INSERT OR IGNORE INTO tool_call_logs
      (trace_id, seq, mcp_server, tool_name, args_summary, call_sent_at,
       call_returned_at, result_summary, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteExpiredStmt = db.prepare(
    `DELETE FROM request_logs WHERE created_at < ?`
  );

  const pendingOps: Array<() => void> = [];

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
      r.client_received_at, r.created_at,
      (SELECT COUNT(*) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS llm_count,
      (SELECT SUM(l.response_at - l.request_at) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS llm_duration,
      (SELECT SUM(l.prompt_tokens) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS input_tokens,
      (SELECT SUM(l.completion_tokens) FROM llm_call_logs l WHERE l.trace_id = r.trace_id) AS output_tokens,
      (SELECT SUM(t.call_returned_at - t.call_sent_at) FROM tool_call_logs t WHERE t.trace_id = r.trace_id) AS tool_duration
    FROM request_logs r
  `;
  const queryDetailStmt = db.prepare(`SELECT * FROM request_logs WHERE trace_id = ?`);
  const queryLlmCallsStmt = db.prepare(
    `SELECT * FROM llm_call_logs WHERE trace_id = ? ORDER BY seq ASC`
  );
  const queryToolCallsStmt = db.prepare(
    `SELECT * FROM tool_call_logs WHERE trace_id = ? ORDER BY seq ASC`
  );
  const queryTokenRowsStmt = db.prepare(
    `SELECT request_at, prompt_tokens, completion_tokens
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

    appendToolCall(traceId, payload): void {
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
        ];
        if (payload.seq != null) {
          insertToolCallWithSeqStmt.run(traceId, payload.seq, ...base);
        } else {
          insertToolCallStmt.run(traceId, traceId, ...base);
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
          finishReason: llm.finish_reason,
          status: llm.status as 'success' | 'failed',
          errorMessage: llm.error_message,
        })
      );
      const toolCalls = (queryToolCallsStmt.all(traceId) as ToolLogRow[]).map(
        (tool): ToolCallLog => ({
          seq: tool.seq,
          mcpServer: tool.mcp_server,
          toolName: tool.tool_name,
          argsSummary: tool.args_summary,
          callSentAt: tool.call_sent_at,
          callReturnedAt: tool.call_returned_at,
          resultSummary: tool.result_summary,
          status: tool.status as 'success' | 'failed',
          errorMessage: tool.error_message,
        })
      );
      return {
        log: {
          traceId: row.trace_id,
          logType: row.log_type,
          userInput: row.user_input,
          domain: row.domain,
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
      }>;
      const accumulated = new Map<number, { input: number; output: number }>();
      for (const row of rows) {
        const start = bucketStartMs(row.request_at, granularity);
        const current = accumulated.get(start) ?? { input: 0, output: 0 };
        current.input += row.prompt_tokens ?? 0;
        current.output += row.completion_tokens ?? 0;
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

export function appendToolCall(traceId: string, payload: ToolCallPayload): void {
  getLogStore().appendToolCall(traceId, payload);
}

export function reportFrontendEnd(traceId: string, clientReceivedAt: number): void {
  getLogStore().reportFrontendEnd(traceId, clientReceivedAt);
}
