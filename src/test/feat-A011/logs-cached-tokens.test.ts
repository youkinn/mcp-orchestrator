
// feat-A011 cachedTokens 存储层与接口测试（测试即文档）：
// 覆盖：新库 cachedTokens 数值落库与读取 / 缺省 null（老调用方）/ 明细接口返回 cachedTokens、
// 列表接口结构不变（不加字段）/ 旧库（无 cached_tokens 列）迁移后旧明细 cachedTokens=null 且明细接口 200
// / 迁移幂等（再次打开不报错）。
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

/** 旧库建表 SQL（feat-A011 之前：llm_call_logs 无 cached_tokens 列） */
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
  finish_reason      TEXT,
  status             TEXT NOT NULL,
  error_message      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (trace_id, seq)
);
`;

/** 用旧 schema 建库并写入一条旧明细（含 request_logs 主表 + llm_call_logs 明细，无 cached_tokens 列） */
function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(LEGACY_SCHEMA_SQL);
  db.prepare(
    `INSERT INTO request_logs
      (trace_id, log_type, user_input, domain, status, response_code, error_message,
       server_received_at, created_at)
     VALUES (?, 'chat', ?, ?, 'success', 200, '', ?, ?)`
  ).run(TRACE_A, '旧天气日志', 'weather', 1789884000000, 1789884000000);
  db.prepare(
    `INSERT INTO llm_call_logs
      (trace_id, seq, stage, model, request_at, response_at, request_summary,
       response_summary, tool_calls, prompt_tokens, completion_tokens, finish_reason,
       status, error_message)
     VALUES (?, 1, 'generation', 'qwen-plus', ?, ?, ?, ?, ?, ?, ?, 'stop', 'success', '')`
  ).run(TRACE_A, 1789884000300, 1789884003100, null, null, null, 1234, 860);
  db.close();
}

test('① cachedTokens 落库与读取：新库传数值 → 明细返回数值；缺省不传 → null（老调用方兼容）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, '问题一', 'sango-novel', 1000);
  store.appendLlmCall(TRACE_A, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1100,
    responseAt: 1800,
    promptTokens: 1234,
    completionTokens: 860,
    cachedTokens: 320,
    status: 'success',
  });
  store.ensureSkeleton('chat', TRACE_B, '问题二', 'sango-novel', 2000);
  store.appendLlmCall(TRACE_B, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 2100,
    responseAt: 2800,
    promptTokens: 200,
    completionTokens: 60,
    status: 'success',
  });
  store.flush();

  const hit = store.queryDetail(TRACE_A)!;
  assert.equal(hit.llmCalls.length, 1);
  assert.equal(hit.llmCalls[0].cachedTokens, 320, '命中缓存时 cachedTokens 为数值');
  assert.equal(hit.llmCalls[0].promptTokens, 1234);
  assert.equal(hit.llmCalls[0].completionTokens, 860);

  const noHit = store.queryDetail(TRACE_B)!;
  assert.equal(noHit.llmCalls[0].cachedTokens, null, '未传 cachedTokens（老调用方）→ null');
});

test('② 明细接口：llmCalls[] 每项含 cachedTokens（number），列表项结构不变（不加字段）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  logStore.ensureSkeleton('chat', TRACE_A, '关羽千里走单骑', 'sango-novel', 1789884000000);
  logStore.appendLlmCall(TRACE_A, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1789884000300,
    responseAt: 1789884003100,
    promptTokens: 1234,
    completionTokens: 860,
    cachedTokens: 800,
    finishReason: 'stop',
    status: 'success',
  });
  logStore.markResponded(TRACE_A, 1789884003450, 'success', 200, '', '关羽在曹操军中得知刘备下落……', '[]');
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const detail = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.code, 200);
  const llmCall = detail.body.data.llmCalls[0];
  assert.equal(llmCall.cachedTokens, 800, '明细 llmCalls[].cachedTokens 为 number（camelCase）');
  assert.equal(llmCall.promptTokens, 1234, '与既有 promptTokens 同风格');

  const list = await get(baseUrl, '/api/v1/logs');
  assert.equal(list.status, 200);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(list.body.data.list[0], 'cachedTokens'),
    '列表项结构不变：不加 cachedTokens 字段'
  );
});

test('③ 旧库迁移：无 cached_tokens 列的存量库打开后自动补列，旧明细 cachedTokens=null 且明细接口 200 不报错', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a011-legacy-'));
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
  assert.equal(detail.log.domain, 'weather');
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].promptTokens, 1234, '旧明细既有字段不受影响');
  assert.equal(detail.llmCalls[0].cachedTokens, null, '旧明细缺列 → 读取为 null');

  const baseUrl = await startServer(t, logStore);
  const res = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(res.status, 200, '旧库明细接口 200 不报错');
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.llmCalls[0].cachedTokens, null);
});

test('④ 迁移幂等：已迁移库再次打开（重复 ALTER duplicate column）不报错、数据仍在', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'a011-legacy2-'));
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
  assert.equal(first.queryDetail(TRACE_A)!.llmCalls[0].cachedTokens, null);
  first.close();

  const second = createLogStore({ dbPath });
  t.after(() => second.close());
  const detail = second.queryDetail(TRACE_A)!;
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].cachedTokens, null, '重复打开不因 duplicate column 报错');
  assert.equal(detail.log.domain, 'weather');
});
