// feat-A007 日志查询接口测试（测试即文档）：
// 覆盖：信封与列表项字段 / 参数校验 / 过滤分页 / 明细 400/404 / 补报 400 与静默 /
// token-stats 参数 400 与降级 / 路由顺序（token-stats 先于 :traceId）/ 存储异常 500。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { ToolCallResult } from '../../types.js';

const TRACE_A = '9f7c0000-0000-4000-8000-00000000000a';
const TRACE_B = '9f7c0000-0000-4000-8000-00000000000b';

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

async function post(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function assertEnvelope(body: any, code: number, data: unknown, message: string): void {
  assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'message']);
  assert.deepEqual(body, { code, data, message });
}

/** 与接口文档示例同口径的种子数据（时间点 / 耗时 / token 均取自文档示例） */
function seedTraceA(logStore: LogStore, traceId: string = TRACE_A): void {
  logStore.ensureSkeleton('chat', traceId, '《三国演义》中关羽千里走单骑的经过是怎样的？', 'sango-novel', 1789884000000, 1789883998000);
  logStore.markHandled(traceId, 1789884000012);
  logStore.appendLlmCall(traceId, {
    stage: 'generation',
    model: 'qwen-plus',
    requestAt: 1789884000300,
    responseAt: 1789884003100,
    requestSummary: '{"role":"user","content":"关羽千里走单骑"}',
    responseSummary: '{"role":"assistant","content":"关羽在曹操军中……"}',
    promptTokens: 1234,
    completionTokens: 860,
    finishReason: 'stop',
    status: 'success',
  });
  logStore.appendToolCall(traceId, {
    mcpServer: 'sango',
    toolName: 'sango_novel_search',
    argsSummary: '{"query":"关羽 千里走单骑"}',
    callSentAt: 1789884003200,
    callReturnedAt: 1789884003800,
    resultSummary: '[{"fragment":"关羽千里走单骑……"}]',
    status: 'success',
  });
  logStore.markResponded(traceId, 1789884003450, 'success', 200, '', '关羽在曹操军中得知刘备下落……', '[]');
  logStore.reportFrontendEnd(traceId, 1789884009000);
  logStore.flush();
}

test('GET /api/v1/logs：成功信封 + 列表项字段 + durations/tokens 派生（与接口文档示例一致）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedTraceA(logStore);
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, '/api/v1/logs');

  assert.equal(res.status, 200);
  assertEqualListEnvelope(res.body);
  const item = res.body.data.list[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'cacheHit', 'domain', 'durations', 'errorMessage', 'hasRetry', 'logType', 'responseCode',
      'routeSource', 'serverReceivedAt', 'status', 'tokens', 'traceId', 'userInput',
    ]
  );
  assert.equal(item.traceId, TRACE_A);
  assert.equal(item.logType, 'chat');
  assert.equal(item.domain, 'sango-novel');
  assert.equal(item.cacheHit, null, 'feat-A013 §3.10：无 cache_logs 行（A013 前历史行）→ null');
  assert.equal(item.status, 'success');
  assert.equal(item.responseCode, 200);
  assert.equal(item.errorMessage, '');
  assert.equal(item.serverReceivedAt, 1789884000000);
  assert.deepEqual(item.durations, { frontend: 7550, queueWait: 12, server: 3450, llm: 2800, tool: 600, total: 11000 });
  assert.deepEqual(item.tokens, { input: 1234, output: 860 });
});

function assertEqualListEnvelope(body: any): void {
  assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'message']);
  assert.equal(body.code, 200);
  assert.equal(body.message, '');
  assert.deepEqual(Object.keys(body.data).sort(), ['list', 'pageNo', 'pageSize', 'total']);
}

test('GET /api/v1/logs：参数非法 400（pageNo/pageSize/startAt/endAt/responseCode/status）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const baseUrl = await startServer(t, logStore);

  const cases: Array<[string, string]> = [
    ['/api/v1/logs?pageNo=0', '分页参数非法'],
    ['/api/v1/logs?pageNo=abc', '分页参数非法'],
    ['/api/v1/logs?pageSize=abc', '分页参数非法'],
    ['/api/v1/logs?pageSize=-5', '分页参数非法'],
    ['/api/v1/logs?startAt=abc', '分页参数非法'],
    ['/api/v1/logs?endAt=-1', '分页参数非法'],
    ['/api/v1/logs?responseCode=abc', '分页参数非法'],
    ['/api/v1/logs?responseCode=1.5', '分页参数非法'],
    ['/api/v1/logs?status=weird', 'status 只支持 success/failed'],
  ];
  for (const [path, message] of cases) {
    const res = await get(baseUrl, path);
    assert.equal(res.status, 400, path);
    assertEnvelope(res.body, 400, null, message);
  }

  // pageSize 越界裁剪到 1–100
  const clamped = await get(baseUrl, '/api/v1/logs?pageSize=99999');
  assert.equal(clamped.status, 200);
  assert.equal(clamped.body.data.pageSize, 100);
});

test('GET /api/v1/logs：过滤（status/responseCode/keyword/traceId/时间范围/logType）+ 分页 + DESC 排序', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedTraceA(logStore);
  logStore.ensureSkeleton('chat', TRACE_B, '今天天气怎么样', null, 1789883999000);
  logStore.markResponded(TRACE_B, 1789883999500, 'failed', 500, '处理失败，请稍后重试', null, null);
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const byStatus = await get(baseUrl, '/api/v1/logs?status=failed');
  assert.equal(byStatus.body.data.total, 1);
  assert.equal(byStatus.body.data.list[0].traceId, TRACE_B);

  const byCode = await get(baseUrl, '/api/v1/logs?responseCode=500');
  assert.equal(byCode.body.data.total, 1);
  assert.equal(byCode.body.data.list[0].errorMessage, '处理失败，请稍后重试');

  const byKeyword = await get(baseUrl, '/api/v1/logs?keyword=天气');
  assert.equal(byKeyword.body.data.total, 1);
  assert.equal(byKeyword.body.data.list[0].traceId, TRACE_B);

  const byTrace = await get(baseUrl, `/api/v1/logs?traceId=${TRACE_A}`);
  assert.equal(byTrace.body.data.total, 1);
  assert.equal(byTrace.body.data.list[0].userInput, '《三国演义》中关羽千里走单骑的经过是怎样的？');

  const byRange = await get(baseUrl, '/api/v1/logs?startAt=1789884000000&endAt=1789884000500');
  assert.equal(byRange.body.data.total, 1);
  assert.equal(byRange.body.data.list[0].traceId, TRACE_A);

  const byType = await get(baseUrl, '/api/v1/logs?logType=chat');
  assert.equal(byType.body.data.total, 2);

  // 排序：server_received_at DESC（B 早于 A，故 B 在后）；分页
  const all = await get(baseUrl, '/api/v1/logs?pageNo=1&pageSize=1');
  assert.equal(all.body.data.total, 2);
  assert.equal(all.body.data.list.length, 1);
  assert.equal(all.body.data.list[0].traceId, TRACE_A);
  const page2 = await get(baseUrl, '/api/v1/logs?pageNo=2&pageSize=1');
  assert.equal(page2.body.data.list[0].traceId, TRACE_B);
});

test('GET /api/v1/logs/:traceId：非 UUID 400 / 不存在 404 / 存在返回主表 + LLM + 工具明细', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedTraceA(logStore);
  const baseUrl = await startServer(t, logStore);

  const bad = await get(baseUrl, '/api/v1/logs/not-a-uuid');
  assert.equal(bad.status, 400);
  assertEnvelope(bad.body, 400, null, 'traceId 格式非法');

  const missing = await get(baseUrl, `/api/v1/logs/9f7c0000-0000-4000-8000-0000000000ff`);
  assert.equal(missing.status, 404);
  assertEnvelope(missing.body, 404, null, '日志不存在');

  const ok = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, 200);
  const { log, llmCalls, toolCalls } = ok.body.data;
  assert.equal(log.traceId, TRACE_A);
  assert.equal(log.logType, 'chat');
  assert.equal(log.userInput, '《三国演义》中关羽千里走单骑的经过是怎样的？');
  assert.equal(log.domain, 'sango-novel');
  assert.equal(log.status, 'success');
  assert.equal(log.responseCode, 200);
  assert.equal(log.errorMessage, '');
  assert.equal(log.clientSentAt, 1789883998000);
  assert.equal(log.serverReceivedAt, 1789884000000);
  assert.equal(log.handleStartedAt, 1789884000012);
  assert.equal(log.serverRespondedAt, 1789884003450);
  assert.equal(log.clientReceivedAt, 1789884009000);
  assert.equal(log.answer, '关羽在曹操军中得知刘备下落……');
  assert.equal(log.citations, '[]');
  assert.equal(llmCalls.length, 1);
  assert.equal(llmCalls[0].seq, 1);
  assert.equal(llmCalls[0].model, 'qwen-plus');
  assert.equal(llmCalls[0].promptTokens, 1234);
  assert.equal(llmCalls[0].completionTokens, 860);
  assert.equal(llmCalls[0].finishReason, 'stop');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].toolName, 'sango_novel_search');
  assert.equal(toolCalls[0].mcpServer, 'sango');
  assert.equal(toolCalls[0].argsSummary, '{"query":"关羽 千里走单骑"}');
});

test('POST /api/v1/logs/:traceId/frontend-end：body 非法 400、已知回填 t6、未知 traceId 静默 200', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedTraceA(logStore);
  const baseUrl = await startServer(t, logStore);

  const badBodies: Array<unknown> = [
    {},
    { clientReceivedAt: '123' },
    { clientReceivedAt: -1 },
    { clientReceivedAt: 1.5 },
    { clientReceivedAt: undefined },
  ];
  for (const body of badBodies) {
    const res = await post(baseUrl, `/api/v1/logs/${TRACE_A}/frontend-end`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assertEnvelope(res.body, 400, null, 'clientReceivedAt 必填且为毫秒时间戳');
  }

  // 未知 traceId：静默 200，不产生新记录
  const unknown = await post(baseUrl, '/api/v1/logs/9f7c0000-0000-4000-8000-0000000000ff/frontend-end', {
    clientReceivedAt: 1789884010000,
  });
  assert.equal(unknown.status, 200);
  assertEnvelope(unknown.body, 200, null, '');
  const after = await get(baseUrl, '/api/v1/logs');
  assert.equal(after.body.data.total, 1);

  // 已知 traceId：补报回填 t6（seed 已有 t6，覆盖为更晚时刻）
  const known = await post(baseUrl, `/api/v1/logs/${TRACE_A}/frontend-end`, {
    clientReceivedAt: 1789884012345,
  });
  logStore.flush(); // 补报走写缓冲，先落盘再查库
  assert.equal(known.status, 200);
  assertEnvelope(known.body, 200, null, '');
  const detail = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(detail.body.data.log.clientReceivedAt, 1789884012345);
});

test('契约：GET /api/v1/logs/token-stats 不被 /:traceId 吞掉（路由顺序），返回统计信封', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, '/api/v1/logs/token-stats?startAt=1789833600000&endAt=1790006400000&granularity=day');

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.message, '');
  assert.deepEqual(Object.keys(res.body.data).sort(), ['buckets', 'endAt', 'granularity', 'startAt', 'timezone']);
  assert.equal(res.body.data.granularity, 'day');
  assert.equal(res.body.data.timezone, 'Asia/Shanghai');
  assert.equal(res.body.data.startAt, 1789833600000);
  assert.equal(res.body.data.endAt, 1790006400000);
  assert.ok(Array.isArray(res.body.data.buckets));
});

test('GET /api/v1/logs/token-stats：参数非法 400（缺失/非法/倒置/非法粒度）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const baseUrl = await startServer(t, logStore);

  const cases: Array<[string, string]> = [
    ['/api/v1/logs/token-stats', 'startAt/endAt 必填且为毫秒时间戳'],
    ['/api/v1/logs/token-stats?startAt=1000', 'startAt/endAt 必填且为毫秒时间戳'],
    ['/api/v1/logs/token-stats?endAt=1000', 'startAt/endAt 必填且为毫秒时间戳'],
    ['/api/v1/logs/token-stats?startAt=abc&endAt=1000', 'startAt/endAt 必填且为毫秒时间戳'],
    ['/api/v1/logs/token-stats?startAt=2000&endAt=1000', 'startAt/endAt 必填且为毫秒时间戳'],
    ['/api/v1/logs/token-stats?startAt=1000&endAt=2000&granularity=week', 'granularity 只支持 day/hour'],
  ];
  for (const [path, message] of cases) {
    const res = await get(baseUrl, path);
    assert.equal(res.status, 400, path);
    assertEnvelope(res.body, 400, null, message);
  }
});

test('GET /api/v1/logs/token-stats：Asia/Shanghai 日界分桶 + 空桶补零 + hour 超 7 天降级 day', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const day1Start = Date.parse('2026-09-20T00:00:00+08:00');
  logStore.ensureSkeleton('chat', TRACE_A, 'q', null, day1Start);
  logStore.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-20T23:30:00+08:00'), promptTokens: 100, completionTokens: 10, status: 'success' });
  logStore.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-21T00:30:00+08:00'), promptTokens: 200, completionTokens: 20, status: 'success' });
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const day = await get(baseUrl, `/api/v1/logs/token-stats?startAt=${day1Start}&endAt=${Date.parse('2026-09-22T00:00:00+08:00')}&granularity=day`);
  assert.equal(day.status, 200);
  assert.deepEqual(
    day.body.data.buckets.slice(0, 3),
    [
      { bucket: '2026-09-20', inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
      { bucket: '2026-09-21', inputTokens: 200, outputTokens: 20, cachedTokens: 0 },
      { bucket: '2026-09-22', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    ]
  );

  const degrade = await get(baseUrl, `/api/v1/logs/token-stats?startAt=${day1Start}&endAt=${day1Start + 8 * 24 * 3600 * 1000}&granularity=hour`);
  assert.equal(degrade.status, 200);
  assert.equal(degrade.body.data.granularity, 'day', 'hour 且区间 > 7 天自动降级 day 并如实返回');
});

test('存储异常 → 500 信封（列表 / token-stats / 补报）', async (t) => {
  const logStore = new ThrowingStore() as unknown as LogStore;
  const baseUrl = await startServer(t, logStore);

  const list = await get(baseUrl, '/api/v1/logs');
  assert.equal(list.status, 500);
  assertEnvelope(list.body, 500, null, '查询日志失败，请稍后重试');

  const stats = await get(baseUrl, '/api/v1/logs/token-stats?startAt=1&endAt=2');
  assert.equal(stats.status, 500);
  assertEnvelope(stats.body, 500, null, '查询统计失败，请稍后重试');

  const report = await post(baseUrl, `/api/v1/logs/${TRACE_A}/frontend-end`, { clientReceivedAt: 1 });
  assert.equal(report.status, 500);
  assertEnvelope(report.body, 500, null, '查询日志失败，请稍后重试');
});

/** 所有方法都抛错：模拟存储故障，验证查询接口 500 与 /api/chat 旁路（server-tracing.test.ts） */
class ThrowingStore {
  private throw(): never {
    throw new Error('injected storage failure');
  }

  ensureSkeleton(): void { this.throw(); }
  markHandled(): void { this.throw(); }
  markResponded(): void { this.throw(); }
  appendLlmCall(): void { this.throw(); }
  appendToolCall(): void { this.throw(); }
  reportFrontendEnd(): void { this.throw(); }
  flush(): void { this.throw(); }
  runRetentionCleanup(): void { this.throw(); }
  close(): void { this.throw(); }
  queryList(): never { this.throw(); }
  queryDetail(): never { this.throw(); }
  queryTokenStats(): never { this.throw(); }
}
