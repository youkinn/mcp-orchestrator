// feat-A012 可观测字段 存储层与接口测试（测试即文档）：
// 覆盖：新库全字段落库与读取 / attempt 两轮各自成行 / reportRouteSource 回填与明细 routeSource /
// 明细接口新字段 / 列表 routeSource + hasRetry / token-stats cachedTokens 桶聚合（历史 null 计 0）/
// 旧库（无新 6 列）迁移后新字段 null + hasRetry false / 迁移幂等（再次打开不报错）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { ToolCallResult } from '../../types.js';

const TRACE_A = '9f7c0000-0000-4000-8000-0000000000a1';
const TRACE_B = '9f7c0000-0000-4000-8000-0000000000b2';

class StubAgent {
  async processQueryData(query: string): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }

  async listTools(): Promise<unknown[]> {
    return [];
  }
}

class QuizSimTransport {
  async fengyunsanguo_quiz_command(message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `模拟回复：${message}` }] };
  }
}

async function startServer(t: TestContext, logStore: LogStore): Promise<string> {
  const app = createServer(
    new StubAgent() as unknown as Agent,
    new QuizSimTransport() as unknown as MCPTransport,
    { port: 0, allowedOrigin: '*', logStore }
  );
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

/** 旧库建表 SQL（feat-A012 之前：llm_call_logs 无 reasoning_tokens / attempt / input_breakdown / max_tokens / temperature，request_logs 无 route_source） */
const LEGACY_SCHEMA_SQL = `
CREATE TABLE request_logs (
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
CREATE TABLE llm_call_logs (
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
  finish_reason      TEXT,
  status             TEXT NOT NULL,
  error_message      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (trace_id, seq)
);
`;

/** 用旧 schema 建库并写入一条旧明细（含 request_logs 主表 + llm_call_logs 明细，无新 5 列） */
function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(LEGACY_SCHEMA_SQL);
  db.prepare(
    `INSERT INTO request_logs
      (trace_id, log_type, user_input, domain, status, response_code, error_message,
       server_received_at, created_at)
     VALUES (?, 'chat', ?, ?, 'success', 200, '', ?, ?)`
  ).run(TRACE_A, '旧日志', 'sango-novel', 1789884000000, 1789884000000);
  db.prepare(
    `INSERT INTO llm_call_logs
      (trace_id, seq, stage, model, request_at, response_at, request_summary,
       response_summary, tool_calls, prompt_tokens, completion_tokens, cached_tokens,
       finish_reason, status, error_message)
     VALUES (?, 1, 'generation', 'qwen-plus', ?, ?, ?, ?, ?, ?, ?, 320, 'stop', 'success', '')`
  ).run(TRACE_A, 1789884000300, 1789884003100, null, null, null, 1234, 860);
  db.close();
}

/** 造一条带全部新字段的调用（attempt / reasoning / inputBreakdown / maxTokens） */
function appendFullCall(
  store: LogStore,
  traceId: string,
  overrides: Record<string, unknown> = {}
): void {
  store.appendLlmCall(traceId, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1789884000300,
    responseAt: 1789884003100,
    promptTokens: 1280,
    completionTokens: 520,
    cachedTokens: 1024,
    reasoningTokens: 300,
    attempt: 1,
    inputBreakdown: { system: 230, user: 45, injected: 180, history: 0, tools: 0 },
    maxTokens: 1000,
    temperature: 0.7,
    finishReason: 'stop',
    status: 'success',
    ...overrides,
  });
}

test('① 新库全字段落库与读取：reasoningTokens / attempt / inputBreakdown / maxTokens / temperature 逐字段读回；缺省不传 → null', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  store.ensureSkeleton('chat', TRACE_A, '问题一', 'sango-novel', 1789884000000);
  appendFullCall(store, TRACE_A);
  store.flush();

  const call = store.queryDetail(TRACE_A)!.llmCalls[0];
  assert.equal(call.reasoningTokens, 300, 'reasoningTokens = provider 原值');
  assert.equal(call.attempt, 1, 'attempt=1 首轮');
  assert.deepEqual(call.inputBreakdown, { system: 230, user: 45, injected: 180, history: 0, tools: 0 }, 'inputBreakdown JSON 解析为对象');
  assert.equal(call.maxTokens, 1000, 'maxTokens = 调用点参数原值');
  assert.equal(call.temperature, 0.7, 'temperature = 调用点温度实参');

  // 缺省不传 → null（老调用方 / 历史语义）
  store.ensureSkeleton('chat', TRACE_B, '问题二', 'sango-novel', 1789884005000);
  store.appendLlmCall(TRACE_B, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1789884005100,
    responseAt: 1789884005200,
    promptTokens: 200,
    completionTokens: 60,
    status: 'success',
  });
  store.flush();
  const plain = store.queryDetail(TRACE_B)!.llmCalls[0];
  assert.equal(plain.reasoningTokens, null);
  assert.equal(plain.attempt, null);
  assert.equal(plain.inputBreakdown, null);
  assert.equal(plain.maxTokens, null);
  assert.equal(plain.temperature, null, '缺省不传 → null（前端不推断）');
});

test('② attempt 两轮各自成行：空答案变参重试 → attempt=1 failed + attempt=2 success 两条', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  store.ensureSkeleton('chat', TRACE_A, '问题', 'auto', 1789884000000);
  // 首轮空答案 failed
  store.appendLlmCall(TRACE_A, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1789884000300,
    responseAt: 1789884000400,
    promptTokens: 1280,
    completionTokens: 0,
    cachedTokens: 1024,
    reasoningTokens: 0,
    attempt: 1,
    inputBreakdown: { system: 230, user: 45, injected: 0, history: 0, tools: 0 },
    maxTokens: 1000,
    finishReason: 'length',
    status: 'failed',
    errorMessage: '空答案：content 为空 / finish_reason=length',
  });
  // 重试轮成功
  store.appendLlmCall(TRACE_A, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1789884000500,
    responseAt: 1789884000800,
    promptTokens: 1280,
    completionTokens: 520,
    cachedTokens: 1024,
    reasoningTokens: 300,
    attempt: 2,
    inputBreakdown: { system: 230, user: 45, injected: 0, history: 0, tools: 0 },
    maxTokens: 1000,
    finishReason: 'stop',
    status: 'success',
  });
  store.flush();

  const calls = store.queryDetail(TRACE_A)!.llmCalls;
  assert.equal(calls.length, 2, '两轮各自成行，不覆盖首轮');
  assert.deepEqual(calls.map((c) => c.attempt), [1, 2], 'attempt 顺序 = 首轮 1 / 重试 2');
  assert.equal(calls[0].status, 'failed');
  assert.equal(calls[1].status, 'success');
});

test('③ reportRouteSource 回填与明细 routeSource：回填后明细 / 查询读回；未回填为 null', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  store.ensureSkeleton('chat', TRACE_A, '问题', 'auto', 1789884000000);
  store.reportRouteSource(TRACE_A, 'classify');
  store.flush();
  assert.equal(store.queryDetail(TRACE_A)!.log.routeSource, 'classify', '回填后 routeSource 读回');

  store.ensureSkeleton('chat', TRACE_B, '问题二', 'sango-novel', 1789884005000);
  store.flush();
  assert.equal(store.queryDetail(TRACE_B)!.log.routeSource, null, '未回填 → null');
});

test('④ 明细接口：log.routeSource + llmCalls[] 四新字段 camelCase 下发，inputBreakdown 为对象', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  logStore.ensureSkeleton('chat', TRACE_A, '关羽千里走单骑', 'sango-novel', 1789884000000);
  appendFullCall(logStore, TRACE_A);
  logStore.reportRouteSource(TRACE_A, 'label');
  logStore.markResponded(TRACE_A, 1789884003450, 'success', 200, '', '关羽在曹操军中得知刘备下落……', '[]');
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const detail = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(detail.status, 200);
  const log = detail.body.data.log;
  const llmCall = detail.body.data.llmCalls[0];
  assert.equal(log.routeSource, 'label', '明细 log.routeSource');
  assert.equal(llmCall.reasoningTokens, 300);
  assert.equal(llmCall.attempt, 1);
  assert.deepEqual(llmCall.inputBreakdown, { system: 230, user: 45, injected: 180, history: 0, tools: 0 }, 'inputBreakdown 解析为对象');
  assert.equal(llmCall.maxTokens, 1000);
  assert.equal(llmCall.temperature, 0.7, '明细 llmCalls[] temperature camelCase 下发');
});

test('⑤ 列表接口：routeSource 透传 + hasRetry 按 attempt=2 聚合（历史行 false）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  // TRACE_A：有重试（attempt=2）
  logStore.ensureSkeleton('chat', TRACE_A, '问题A', 'auto', 1789884000000);
  appendFullCall(logStore, TRACE_A, { attempt: 1, status: 'failed', errorMessage: '空答案', finishReason: 'length', completionTokens: 0 });
  appendFullCall(logStore, TRACE_A, { attempt: 2, requestAt: 1789884000500, responseAt: 1789884000800 });
  logStore.reportRouteSource(TRACE_A, 'classify');
  // TRACE_B：无重试（仅 attempt=1）
  logStore.ensureSkeleton('chat', TRACE_B, '问题B', 'sango-novel', 1789884005000);
  appendFullCall(logStore, TRACE_B);
  logStore.reportRouteSource(TRACE_B, 'keyword');
  logStore.markResponded(TRACE_A, 1789884003450, 'success', 200, '', 'A', '[]');
  logStore.markResponded(TRACE_B, 1789884005450, 'success', 200, '', 'B', '[]');
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const list = await get(baseUrl, '/api/v1/logs');
  assert.equal(list.status, 200);
  const items = list.body.data.list;
  const a = items.find((item: any) => item.traceId === TRACE_A)!;
  const b = items.find((item: any) => item.traceId === TRACE_B)!;
  assert.equal(a.hasRetry, true, '有 attempt=2 → hasRetry true');
  assert.equal(a.routeSource, 'classify');
  assert.equal(b.hasRetry, false, '无重试 → hasRetry false');
  assert.equal(b.routeSource, 'keyword');
});

test('⑥ token-stats：cachedTokens 桶聚合；历史 null 计 0；cached_tokens > prompt_tokens 时服务端原样聚合（负值兜底在前端）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const startAt = 1789884000000; // 同一 day 桶
  const endAt = startAt + 3600_000;
  // 桶内 3 条：cached=2048 / cached=null(计0) / 异常 cached>prompt（cached=5000, prompt=100）
  store.ensureSkeleton('chat', TRACE_A, 'A', 'sango-novel', startAt);
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: startAt + 100, responseAt: startAt + 200, promptTokens: 2560, completionTokens: 1040, cachedTokens: 2048, status: 'success' });
  store.ensureSkeleton('chat', TRACE_B, 'B', 'auto', startAt + 1000);
  store.appendLlmCall(TRACE_B, { stage: 'generation', model: 'm', requestAt: startAt + 1100, responseAt: startAt + 1200, promptTokens: 200, completionTokens: 60, status: 'success' });
  store.ensureSkeleton('chat', '9f7c0000-0000-4000-8000-0000000000c3', 'C', 'sango-novel', startAt + 2000);
  store.appendLlmCall('9f7c0000-0000-4000-8000-0000000000c3', { stage: 'generation', model: 'm', requestAt: startAt + 2100, responseAt: startAt + 2200, promptTokens: 100, completionTokens: 50, cachedTokens: 5000, status: 'success' });
  store.flush();

  const result = store.queryTokenStats({ startAt, endAt, granularity: 'hour' });
  // 区间 [startAt, startAt+1h] 跨 14:00 / 15:00 两桶；3 条记录同落 14:00 数据桶
  const dataBucket = result.buckets.find((b) => b.inputTokens > 0);
  assert.ok(dataBucket, '存在数据桶');
  assert.equal(dataBucket!.cachedTokens, 2048 + 0 + 5000, 'cachedTokens = Σ cached_tokens，历史 null 计 0');
  assert.equal(dataBucket!.inputTokens, 2560 + 200 + 100);
  assert.equal(dataBucket!.outputTokens, 1040 + 60 + 50);
  const emptyBucket = result.buckets.find((b) => b.inputTokens === 0);
  assert.ok(emptyBucket, '存在空桶');
  assert.equal(emptyBucket!.cachedTokens, 0, '空桶 cachedTokens 0');
  // 缓存命中率 = Σcached / Σinput（区间合计，由前端算）；服务端不裁剪负值（兜底在前端展示层）
  assert.ok(dataBucket!.cachedTokens > dataBucket!.inputTokens, '异常数据 cached>prompt 原样聚合，负值段由前端兜底 0');
});

test('⑦ 旧库迁移：无新 6 列的存量库打开自动补列，旧明细新字段 null、列表 routeSource null + hasRetry false，接口 200', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a012-legacy-'));
  const dbPath = join(dir, 'logs.db');
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 旁路：Windows 偶发文件占用，忽略
    }
  });
  seedLegacyDb(dbPath);

  const logStore = createLogStore({ dbPath });
  t.after(() => logStore.close());
  const detail = logStore.queryDetail(TRACE_A)!;
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].promptTokens, 1234, '旧明细既有字段不受影响');
  assert.equal(detail.llmCalls[0].cachedTokens, 320);
  assert.equal(detail.llmCalls[0].reasoningTokens, null);
  assert.equal(detail.llmCalls[0].attempt, null);
  assert.equal(detail.llmCalls[0].inputBreakdown, null);
  assert.equal(detail.llmCalls[0].maxTokens, null);
  assert.equal(detail.llmCalls[0].temperature, null, '旧明细无 temperature（迁移补列 NULL，不回填）');
  assert.equal(detail.log.routeSource, null, '旧主表无 route_source → null');

  const list = logStore.queryList({ pageNo: 1, pageSize: 20 });
  assert.equal(list.list[0].routeSource, null);
  assert.equal(list.list[0].hasRetry, false, '历史行无 attempt=2 → hasRetry false');

  const baseUrl = await startServer(t, logStore);
  const res = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(res.status, 200, '旧库明细接口 200 不报错');
  assert.equal(res.body.data.llmCalls[0].reasoningTokens, null);
  assert.equal(res.body.data.llmCalls[0].temperature, null, '旧库明细接口 temperature null 不炸');
});

test('⑧ 迁移幂等：已迁移库再次打开（重复 ALTER duplicate column，含 temperature 列）不报错、数据仍在', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a012-legacy2-'));
  const dbPath = join(dir, 'logs.db');
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 旁路
    }
  });
  seedLegacyDb(dbPath);

  const first = createLogStore({ dbPath });
  assert.equal(first.queryDetail(TRACE_A)!.llmCalls[0].attempt, null);
  first.close();

  const second = createLogStore({ dbPath });
  t.after(() => second.close());
  const detail = second.queryDetail(TRACE_A)!;
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].reasoningTokens, null, '重复打开不因 duplicate column 报错');
  assert.equal(detail.llmCalls[0].temperature, null, 'temperature 列重复 ALTER 幂等，旧行保持 NULL');
  assert.equal(detail.log.routeSource, null);
});