
// feat-A011 天气下线测试（测试即文档）：
// 覆盖：resolveMCPServerConfigs 不再读 MCP_WEATHER_SCRIPT（残留忽略、全缺配不报错 = index.ts 不再必需校验）、
// /api/chat 传 domain=weather → 400 且文案为「domain 字段仅支持 fengyunsanguo、sango-novel」、
// GET /api/v1/logs?domain=weather 仍返回历史记录（日志过滤枚举保留 weather，与 chat 校验解耦）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  resolveMCPServerConfigs,
  SANGO_SERVER_NAME,
  FENGYUNSANGUO_SERVER_NAME,
} from '../../transport.js';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { ToolCallResult } from '../../types.js';

const TRACE_WEATHER = '9f7c0000-0000-4000-8000-0000000000e1';

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

test('① 启动装配：resolveMCPServerConfigs 不再读 MCP_WEATHER_SCRIPT——残留配置忽略不注册、不报错', () => {
  // index.ts 不再校验 weather 必需（已移除 exit(1)），全缺配返回空数组即可正常启动
  assert.deepEqual(resolveMCPServerConfigs({}), []);

  // 残留 MCP_WEATHER_SCRIPT 直接忽略：不注册 weather server，其余配置照常
  assert.deepEqual(
    resolveMCPServerConfigs({
      MCP_WEATHER_SCRIPT: 'D:/weather/src/index.js',
      MCP_SANGO_SCRIPT: 'D:/sango/dist/index.js',
    }),
    [{ name: SANGO_SERVER_NAME, scriptPath: 'D:/sango/dist/index.js', required: false }]
  );
  assert.deepEqual(
    resolveMCPServerConfigs({
      MCP_WEATHER_SCRIPT: 'w.js',
      MCP_FENGYUNSANGUO_SCRIPT: 'f.js',
    }),
    [{ name: FENGYUNSANGUO_SERVER_NAME, scriptPath: 'f.js', required: false }]
  );
});

test('② /api/chat：传 domain=weather → 400 且文案固定「domain 字段仅支持 fengyunsanguo、sango-novel」', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const baseUrl = await startServer(t, logStore);

  const res = await post(baseUrl, '/api/chat', {
    message: '北京今天适合出门吗',
    domain: 'weather',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 400);
  assert.equal(res.body.data, null);
  assert.equal(res.body.message, 'domain 字段仅支持 fengyunsanguo、sango-novel');
});

test('③ 历史天气日志可查：GET /api/v1/logs?domain=weather 仍返回历史记录（过滤枚举保留 weather）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  logStore.ensureSkeleton('chat', TRACE_WEATHER, '纽约天气', 'weather', 1789884000000, 1789883998000);
  logStore.markResponded(TRACE_WEATHER, 1789884001000, 'success', 200, '', '晴', null);
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, '/api/v1/logs?domain=weather');
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.total, 1, '历史 weather 记录仍可查');
  assert.equal(res.body.data.list[0].domain, 'weather');
  assert.equal(res.body.data.list[0].userInput, '纽约天气');
});

test('④ 两处 domain 枚举解耦：chat 校验移除 weather、日志过滤保留 weather（weather 请求 400 不影响日志筛选）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const baseUrl = await startServer(t, logStore);

  const chat = await post(baseUrl, '/api/chat', { message: '天气', domain: 'weather' });
  assert.equal(chat.status, 400, '/api/chat 拒绝 weather');

  const list = await get(baseUrl, '/api/v1/logs?domain=weather');
  assert.equal(list.status, 200, '日志过滤枚举仍接受 weather，不被 chat 校验联动移除');
});
