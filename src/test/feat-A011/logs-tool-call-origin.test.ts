// bug-00019 工具调用「调用方 + 发起阶段」测试（测试即文档）：
// ① transport 埋点：成功 / 失败两条路径都落 caller + stage；调用点未传 origin → 两字段 NULL（与历史行同口径）；
// ② 调用点显式传值（走真实 agent → transport → 落库）：域锁定快路径 fastpath、L3 命中后预调 l3
//    （复现 trace 2ef3608a 的两条服务端调用：quiz_route 预检 + 题库预调）、分类轮判定后预调 classify；
// ③ 明细接口 data.toolCalls[] 返回 caller / stage（未标注为 null）；
// ④ 旧库（无 caller / stage 列）迁移：历史行两字段 null、明细接口 200、重复打开幂等。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Agent, type FengyunsanguoVectorMatcher } from '../../agent.js';
import { createServer } from '../../server.js';
import {
  FENGYUNSANGUO_QUERY_TOOL,
  FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
  FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
  FENGYUNSANGUO_SERVER_NAME,
  MCPTransport,
  SANGO_SERVER_NAME,
  type MCPServerConfig,
  type MCPServerConnection,
  type MCPServerConnectionFactory,
  type ToolCallOrigin,
} from '../../transport.js';
import { runWithTraceId } from '../../trace.js';
import { SANGO_NOVEL_SEARCH_TOOL } from '../../citation.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { LLMConfig, MCPToolDefinition, ToolCallResult } from '../../types.js';

const TRACE_OK = '9f7c0000-0000-4000-8000-0000000001a1';
const TRACE_FAIL = '9f7c0000-0000-4000-8000-0000000001b2';
const TRACE_NONE = '9f7c0000-0000-4000-8000-0000000001c3';
const TRACE_FASTPATH = '9f7c0000-0000-4000-8000-0000000002a1';
const TRACE_L3 = '9f7c0000-0000-4000-8000-0000000002b2';
const TRACE_CLASSIFY = '9f7c0000-0000-4000-8000-0000000002c3';
const TRACE_API = '9f7c0000-0000-4000-8000-0000000003a1';
const TRACE_LEGACY = '9f7c0000-0000-4000-8000-0000000004a1';

const NOVEL_TOOLS: MCPToolDefinition[] = [
  { name: SANGO_NOVEL_SEARCH_TOOL, description: '原著检索', inputSchema: {} },
];
const FYS_TOOLS: MCPToolDefinition[] = [
  { name: FENGYUNSANGUO_QUERY_TOOL, description: '题库召回', inputSchema: {} },
  { name: FENGYUNSANGUO_QUIZ_ROUTE_TOOL, description: 'L3 高置信识别', inputSchema: {} },
  { name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL, description: '随机一题状态机', inputSchema: {} },
];
const ALL_TOOLS: MCPToolDefinition[] = [...NOVEL_TOOLS, ...FYS_TOOLS];

function makeConfig(): LLMConfig {
  return {
    provider: 'deepseek',
    model: 'mock-model',
    apiKey: 'mock-key',
    apiBaseUrl: 'https://mock.local',
  };
}

/** 假 MCP 连接：按工具名返回文本（quiz_route 返回 "true" 以命中 L3），可指定必失败工具 */
class FakeConnection implements MCPServerConnection {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    private tools: MCPToolDefinition[],
    private failingTools: string[] = []
  ) {}

  async connect(): Promise<void> {}
  async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    this.calls.push({ name, args });
    if (this.failingTools.includes(name)) {
      throw new Error(`MCP 工具不可用：${name}`);
    }
    const text = name === FENGYUNSANGUO_QUIZ_ROUTE_TOOL ? 'true' : '工具返回文本';
    return { content: [{ type: 'text', text }] };
  }
  async close(): Promise<void> {}
}

class FakeFactory implements MCPServerConnectionFactory {
  connections: FakeConnection[] = [];

  constructor(private failingTools: string[] = []) {}

  create(config: MCPServerConfig): MCPServerConnection {
    const tools = config.name === SANGO_SERVER_NAME ? NOVEL_TOOLS : FYS_TOOLS;
    const connection = new FakeConnection(tools, this.failingTools);
    this.connections.push(connection);
    return connection;
  }
}

function serverConfigs(): MCPServerConfig[] {
  return [
    { name: SANGO_SERVER_NAME, scriptPath: 'sango.js', required: false },
    { name: FENGYUNSANGUO_SERVER_NAME, scriptPath: 'fys.js', required: false },
  ];
}

/** 接好真实 transport（假连接 + 注入 :memory: store），工具归属由 listTools 建立 */
async function connectedTransport(
  store: LogStore,
  failingTools: string[] = []
): Promise<MCPTransport> {
  const transport = new MCPTransport(serverConfigs(), new FakeFactory(failingTools), store);
  await transport.connect();
  await transport.listTools();
  return transport;
}

/** 真实 Agent（注入 modelCaller 免真实 LLM 调用）：按顺序吐预设回复；matcher 缺省不注入（L3 不命中） */
function makeAgent(
  transport: MCPTransport,
  modelResponses: string[],
  matcher?: FengyunsanguoVectorMatcher
): Agent {
  const responses = [...modelResponses];
  return new Agent(transport, makeConfig(), {
    tools: ALL_TOOLS,
    fengyunsanguoVectorMatcher: matcher,
    modelCaller: async () => ({
      content: [{ type: 'text', text: responses.shift() ?? '' }],
    }),
  });
}

/** 工具明细三元组（工具名 / 调用方 / 发起阶段），断言用 */
function toolCallTriples(store: LogStore, traceId: string): Array<[string, string | null, string | null]> {
  return store
    .queryDetail(traceId)!
    .toolCalls.map((call) => [call.toolName, call.caller, call.stage]);
}

test('① transport 埋点：成功 / 失败两条路径都落 caller + stage；调用点未传 origin → 两字段 null', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  store.ensureSkeleton('chat', TRACE_OK, '关羽千里走单骑', 'sango-novel', 1000);
  store.ensureSkeleton('chat', TRACE_FAIL, '关羽', 'sango-novel', 1000);
  store.ensureSkeleton('chat', TRACE_NONE, '关羽', 'sango-novel', 1000);

  const transport = await connectedTransport(store, [SANGO_NOVEL_SEARCH_TOOL]);

  await runWithTraceId(TRACE_OK, () =>
    transport.callTool(
      FENGYUNSANGUO_QUERY_TOOL,
      { text: '关羽' },
      { caller: 'server', stage: 'l3' }
    )
  );
  await runWithTraceId(TRACE_FAIL, () =>
    assert.rejects(
      transport.callTool(
        SANGO_NOVEL_SEARCH_TOOL,
        { query: '关羽' },
        { caller: 'server', stage: 'fastpath' }
      ),
      /MCP 工具不可用/
    )
  );
  await runWithTraceId(TRACE_NONE, () =>
    transport.callTool(FENGYUNSANGUO_QUERY_TOOL, { text: '关羽' })
  );
  store.flush();

  const ok = store.queryDetail(TRACE_OK)!.toolCalls[0];
  assert.equal(ok.toolName, FENGYUNSANGUO_QUERY_TOOL);
  assert.equal(ok.status, 'success');
  assert.equal(ok.caller, 'server', '成功路径落调用方');
  assert.equal(ok.stage, 'l3', '成功路径落发起阶段');

  const failed = store.queryDetail(TRACE_FAIL)!.toolCalls[0];
  assert.equal(failed.toolName, SANGO_NOVEL_SEARCH_TOOL);
  assert.equal(failed.status, 'failed', '失败路径同样落工具明细');
  assert.equal(failed.caller, 'server', '失败路径落调用方');
  assert.equal(failed.stage, 'fastpath', '失败路径落发起阶段');

  const none = store.queryDetail(TRACE_NONE)!.toolCalls[0];
  assert.equal(none.caller, null, '未显式传 origin → caller 为 null（不做推断）');
  assert.equal(none.stage, null, '未显式传 origin → stage 为 null');
});

test('② 调用点显式传值：域锁定快路径 fastpath / L3 命中后预调 l3 / 分类轮判定后预调 classify', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  // 域锁定快路径：L2 关键词「风云三国」命中 → 域内快路径预调题库（不经分类轮）
  const fastpathTransport = await connectedTransport(store);
  const fastpathAgent = makeAgent(fastpathTransport, ['快路径答案']);
  store.ensureSkeleton('chat', TRACE_FASTPATH, '风云三国怎么招募武将', 'fengyunsanguo', 1000);
  await runWithTraceId(TRACE_FASTPATH, () =>
    fastpathAgent.processQueryData('风云三国怎么招募武将')
  );
  store.flush();
  assert.deepEqual(toolCallTriples(store, TRACE_FASTPATH), [
    [FENGYUNSANGUO_QUERY_TOOL, 'server', 'fastpath'],
  ]);

  // L3：matcher 与 index.ts 装配同形（显式传 caller=server / stage=l3），复现 trace 2ef3608a 两条服务端调用
  const l3Transport = await connectedTransport(store);
  const l3Agent = makeAgent(l3Transport, ['L3 答案'], (query) =>
    l3Transport.fengyunsanguo_quiz_route(query, { caller: 'server', stage: 'l3' })
  );
  store.ensureSkeleton('chat', TRACE_L3, '夏侯惇眼睛怎么瞎的', null, 1000);
  await runWithTraceId(TRACE_L3, () => l3Agent.processQueryData('夏侯惇眼睛怎么瞎的'));
  store.flush();
  assert.deepEqual(toolCallTriples(store, TRACE_L3), [
    [FENGYUNSANGUO_QUIZ_ROUTE_TOOL, 'server', 'l3'],
    [FENGYUNSANGUO_QUERY_TOOL, 'server', 'l3'],
  ]);

  // 分类轮：L3 未命中 → 分类轮输出 2（题库）→ 服务端按编号预调
  const classifyTransport = await connectedTransport(store);
  const classifyAgent = makeAgent(classifyTransport, ['2', '分类答案'], async () => false);
  store.ensureSkeleton('chat', TRACE_CLASSIFY, '随便问问', null, 1000);
  await runWithTraceId(TRACE_CLASSIFY, () => classifyAgent.processQueryData('随便问问'));
  store.flush();
  assert.deepEqual(toolCallTriples(store, TRACE_CLASSIFY), [
    [FENGYUNSANGUO_QUERY_TOOL, 'server', 'classify'],
  ]);
});

/** 日志接口测试用桩：Agent 只回固定答案、transport 只满足 quiz_command 契约 */
class StubAgent {
  async processQueryData(): Promise<{ answer: string; citations: [] }> {
    return { answer: '桩回复', citations: [] };
  }
  async listTools(): Promise<unknown[]> {
    return [];
  }
}

class StubTransport {
  async fengyunsanguo_quiz_command(message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `模拟回复：${message}` }] };
  }
}

async function startServerWith(
  t: TestContext,
  transport: MCPTransport,
  logStore: LogStore
): Promise<string> {
  const app = createServer(new StubAgent() as unknown as Agent, transport, {
    port: 0,
    allowedOrigin: '*',
    logStore,
  });
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

/** 对话 / 后台路由测试默认桩 transport（仅满足 quiz_command 契约） */
function startServer(t: TestContext, logStore: LogStore): Promise<string> {
  return startServerWith(t, new StubTransport() as unknown as MCPTransport, logStore);
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  traceId?: string
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(traceId ? { 'X-Trace-Id': traceId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** 记录 origin 的假 transport：后台直调路由（/api/v1/sango* 不落日志）用它断言调用点显式传值 */
class OriginRecordingTransport extends MCPTransport {
  calls: Array<{ name: string; origin?: ToolCallOrigin }> = [];

  constructor() {
    super('mock-server');
  }

  override async callTool(
    name: string,
    _args: Record<string, unknown>,
    origin?: ToolCallOrigin
  ): Promise<ToolCallResult> {
    this.calls.push({ name, origin });
    return { content: [{ type: 'text', text: JSON.stringify({ chapter: 73, paragraphs: [] }) }] };
  }

  override async fengyunsanguo_quiz_command(
    message: string,
    _sessionId?: string,
    origin?: ToolCallOrigin
  ): Promise<ToolCallResult> {
    this.calls.push({ name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL, origin });
    return { content: [{ type: 'text', text: `题目：${message}` }] };
  }
}

test('③ 明细接口：data.toolCalls[] 返回 caller / stage（服务端预调 server+l3；未标注为 null）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  logStore.ensureSkeleton('chat', TRACE_API, '夏侯惇眼睛怎么瞎的', null, 1789884000000);
  logStore.appendToolCall(TRACE_API, {
    mcpServer: FENGYUNSANGUO_SERVER_NAME,
    toolName: FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
    argsSummary: '{"text":"夏侯惇眼睛怎么瞎的"}',
    callSentAt: 1789884000100,
    callReturnedAt: 1789884000200,
    resultSummary: 'false',
    status: 'success',
    caller: 'server',
    stage: 'l3',
  });
  logStore.appendToolCall(TRACE_API, {
    mcpServer: SANGO_SERVER_NAME,
    toolName: SANGO_NOVEL_SEARCH_TOOL,
    callSentAt: 1789884000300,
    callReturnedAt: 1789884000400,
    resultSummary: '[]',
    status: 'success',
  });
  logStore.markResponded(TRACE_API, 1789884000900, 'success', 200, '', '答案', '[]');
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, `/api/v1/logs/${TRACE_API}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  const toolCalls = res.body.data.toolCalls;
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].toolName, FENGYUNSANGUO_QUIZ_ROUTE_TOOL);
  assert.equal(toolCalls[0].caller, 'server', '接口返回调用方');
  assert.equal(toolCalls[0].stage, 'l3', '接口返回发起阶段');
  assert.equal(toolCalls[1].caller, null, '未显式传值 → 接口返回 null');
  assert.equal(toolCalls[1].stage, null);
});

/** 旧库建表 SQL（bug-00019 之前：tool_call_logs 无 caller / stage 列） */
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
CREATE TABLE tool_call_logs (
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

/** 用旧 schema 建库并写入一条历史工具明细（无 caller / stage 列） */
function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(LEGACY_SCHEMA_SQL);
  db.prepare(
    `INSERT INTO request_logs
      (trace_id, log_type, user_input, domain, status, response_code, error_message,
       server_received_at, created_at)
     VALUES (?, 'chat', ?, 'sango-novel', 'success', 200, '', ?, ?)`
  ).run(TRACE_LEGACY, '旧日志问题', 1789884000000, 1789884000000);
  db.prepare(
    `INSERT INTO tool_call_logs
      (trace_id, seq, mcp_server, tool_name, args_summary, call_sent_at,
       call_returned_at, result_summary, status, error_message)
     VALUES (?, 1, ?, ?, '{"query":"关羽"}', ?, ?, '[]', 'success', '')`
  ).run(TRACE_LEGACY, SANGO_SERVER_NAME, SANGO_NOVEL_SEARCH_TOOL, 1789884000100, 1789884000200);
  db.close();
}

test('④ 旧库迁移：自动补 caller / stage 列，历史行两字段 null、明细接口 200、重复打开幂等', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bug19-legacy-'));
  const dbPath = join(dir, 'logs.db');
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 旁路：Windows 偶发文件占用，忽略
    }
  });
  seedLegacyDb(dbPath);

  const store = createLogStore({ dbPath });
  const detail = store.queryDetail(TRACE_LEGACY)!;
  assert.equal(detail.toolCalls.length, 1);
  assert.equal(detail.toolCalls[0].toolName, SANGO_NOVEL_SEARCH_TOOL, '历史行既有字段不受影响');
  assert.equal(detail.toolCalls[0].caller, null, '历史行不回填 → caller 为 null');
  assert.equal(detail.toolCalls[0].stage, null, '历史行不回填 → stage 为 null');

  const baseUrl = await startServer(t, store);
  const res = await get(baseUrl, `/api/v1/logs/${TRACE_LEGACY}`);
  assert.equal(res.status, 200, '旧库明细接口 200 不报错');
  assert.equal(res.body.data.toolCalls[0].caller, null);
  assert.equal(res.body.data.toolCalls[0].stage, null);
  store.close();

  // 幂等：已迁移库再次打开（重复 ALTER duplicate column）不报错，且迁移后可正常写入新值
  const reopened = createLogStore({ dbPath });
  t.after(() => reopened.close());
  assert.equal(reopened.queryDetail(TRACE_LEGACY)!.toolCalls[0].caller, null);
  reopened.appendToolCall(TRACE_LEGACY, {
    mcpServer: FENGYUNSANGUO_SERVER_NAME,
    toolName: FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
    callSentAt: 1789884000300,
    callReturnedAt: 1789884000400,
    resultSummary: 'true',
    status: 'success',
    caller: 'server',
    stage: 'l3',
  });
  reopened.flush();
  assert.deepEqual(toolCallTriples(reopened, TRACE_LEGACY), [
    [SANGO_NOVEL_SEARCH_TOOL, null, null],
    [FENGYUNSANGUO_QUIZ_ROUTE_TOOL, 'server', 'l3'],
  ]);
});

test('⑤ 后台直调标注：随机一题 / 原文阅读器直调落 server + admin（非对话链路）', async (t) => {
  // ① /api/v1/sango/chapters/:chapter（后台原文阅读器，按设计不落日志）→ 断言调用点显式传 server / admin
  const recording = new OriginRecordingTransport();
  const recordingBase = await startServerWith(
    t,
    recording,
    createLogStore({ dbPath: ':memory:' })
  );
  const chapter = await get(recordingBase, '/api/v1/sango/chapters/73');
  assert.equal(chapter.status, 200);
  assert.deepEqual(recording.calls[0], {
    name: 'sango_novel_chapter',
    origin: { caller: 'server', stage: 'admin' },
  });

  // ② /api/sango/random（后台随机一题直调）→ 同一口径
  const randomViaStub = await post(recordingBase, '/api/sango/random', { message: '随机一题' });
  assert.equal(randomViaStub.status, 200);
  assert.deepEqual(recording.calls[1], {
    name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
    origin: { caller: 'server', stage: 'admin' },
  });

  // ③ 真实 transport + 注入 store：后台直调确实落库为 server / admin（NULL 语义只留给历史行）
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const transport = await connectedTransport(store);
  const realBase = await startServerWith(t, transport, store);
  const traceId = '9f7c0000-0000-4000-8000-0000000005a1';
  const random = await post(realBase, '/api/sango/random', { message: '随机一题' }, traceId);
  assert.equal(random.status, 200);
  store.flush();
  assert.deepEqual(toolCallTriples(store, traceId), [
    [FENGYUNSANGUO_QUIZ_COMMAND_TOOL, 'server', 'admin'],
  ]);
});