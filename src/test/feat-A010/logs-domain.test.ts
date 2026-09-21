// feat-A010 日志列表 domain 过滤测试（测试即文档）：
// 覆盖：domain 正常过滤（weather/fengyunsanguo/sango-novel）/ 与既有条件叠加（AND）/
// 空值（未传 / 空白）视同「全部」/ 非枚举 400 message 原文 / domain 为空记录只在「全部」出现。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { ToolCallResult } from '../../types.js';

const TRACE_WEATHER = '9f7c0000-0000-4000-8000-0000000000a1';
const TRACE_FYS = '9f7c0000-0000-4000-8000-0000000000b2';
const TRACE_NOVEL = '9f7c0000-0000-4000-8000-0000000000c3';
const TRACE_EMPTY = '9f7c0000-0000-4000-8000-0000000000d4';

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

function assertEnvelope(body: any, code: number, data: unknown, message: string): void {
  assert.deepEqual(body, { code, data, message });
}

/** 四类 domain 记录：weather / fengyunsanguo / sango-novel / domain 为空（历史记录）。 */
function seedLogs(logStore: LogStore): void {
  logStore.ensureSkeleton('chat', TRACE_WEATHER, '纽约天气', 'weather', 1789884000000, 1789883998000);
  logStore.ensureSkeleton('chat', TRACE_FYS, '夏侯惇的字', 'fengyunsanguo', 1789884000100, 1789883998100);
  logStore.ensureSkeleton('chat', TRACE_NOVEL, '关羽千里走单骑', 'sango-novel', 1789884000200, 1789883998200);
  logStore.ensureSkeleton('chat', TRACE_EMPTY, '自由问答', null, 1789884000300, 1789883998300);
  logStore.markResponded(TRACE_WEATHER, 1789884001000, 'success', 200, '', '晴', null);
  logStore.markResponded(TRACE_FYS, 1789884001100, 'success', 200, '', '元让', null);
  logStore.markResponded(TRACE_NOVEL, 1789884001200, 'success', 200, '', '关羽在曹操军中得知刘备下落……', null);
  logStore.markResponded(TRACE_EMPTY, 1789884001300, 'success', 200, '', '自由回答', null);
  logStore.flush();
}

test('① domain 过滤：三种枚举各只返回对应项目记录，且每行 domain 与筛选值自洽', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedLogs(logStore);
  const baseUrl = await startServer(t, logStore);

  for (const domain of ['weather', 'fengyunsanguo', 'sango-novel']) {
    const res = await get(baseUrl, `/api/v1/logs?domain=${domain}`);
    assert.equal(res.status, 200, domain);
    assert.equal(res.body.data.total, 1, domain);
    assert.equal(res.body.data.list.length, 1, domain);
    assert.equal(res.body.data.list[0].domain, domain, domain);
  }
});

test('② domain 与既有条件（logType）叠加：AND 生效', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedLogs(logStore);
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, '/api/v1/logs?domain=sango-novel&logType=chat');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 1);
  assert.equal(res.body.data.list[0].traceId, TRACE_NOVEL);
});

test('③ domain 为空的历史记录只在「全部」出现：不传 domain 返回 4 条，选中任一 domain 不含空记录', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedLogs(logStore);
  const baseUrl = await startServer(t, logStore);

  const all = await get(baseUrl, '/api/v1/logs');
  assert.equal(all.body.data.total, 4, '全部应含 domain 为空的记录');

  const domainOnly = await get(baseUrl, '/api/v1/logs?domain=weather');
  assert.equal(domainOnly.body.data.total, 1);
  assert.equal(domainOnly.body.data.list[0].domain, 'weather');
});

test('④ 空值行为：未传 / 空白视同未传（返回全部）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedLogs(logStore);
  const baseUrl = await startServer(t, logStore);

  const blank = await get(baseUrl, '/api/v1/logs?domain=%20%20');
  assert.equal(blank.status, 200);
  assert.equal(blank.body.data.total, 4, '纯空白 domain 视同未传');

  const encodedEmpty = await get(baseUrl, '/api/v1/logs?domain=');
  assert.equal(encodedEmpty.status, 200);
  assert.equal(encodedEmpty.body.data.total, 4, '空字符串 domain 视同未传');
});

test('⑤ 非法值：非枚举 domain → 400 且 message 原文固定', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedLogs(logStore);
  const baseUrl = await startServer(t, logStore);

  for (const bad of ['unknown', 'sango', 'WEATHER']) {
    const res = await get(baseUrl, `/api/v1/logs?domain=${bad}`);
    assert.equal(res.status, 400, bad);
    assertEnvelope(res.body, 400, null, 'domain 只支持 weather/fengyunsanguo/sango-novel');
  }
});
