// feat-A008 quiz 埋点 + /api/chat domain 扩项集成测试（测试即文档）：
// 覆盖：/api/sango/random 全链路落库（log_type=quiz / domain=fengyunsanguo / answer / citations=[]）、
// 工具明细 fengyunsanguo_quiz_command（mcp_server=fengyunsanguo）、无 LLM 明细（列表 tokens=null）、
// X-Client-Sent-At（t0）+ t6 补报回填 durations.frontend、未知 traceId 补报静默 200、
// 缺失 X-Trace-Id 响应头兜底 + 可用该值补报、校验失败 400/413 也落主表、
// /api/chat domain=weather 下线后 400 且文案固定（A011）、未知 domain 仍 400、
// domain=fengyunsanguo 走题库快路径工具明细落 fengyunsanguo_query、日志存储抛错旁路仍 200。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import { getTraceId } from '../../trace.js';
import {
  FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
  FENGYUNSANGUO_SERVER_NAME,
  type MCPTransport,
} from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import {
  type LLMConfig,
  type MCPToolDefinition,
  type ModelResponse,
  type ToolCallResult,
} from '../../types.js';

const TRACE_ID = '11111111-2222-4333-8444-555555555555';
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUIZ_COMMAND_TOOL: MCPToolDefinition = {
  name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
  description: '风云三国随机一题状态机',
  inputSchema: { type: 'object' },
};
const FENGYUNSANGUO_QUERY_TOOL: MCPToolDefinition = {
  name: 'fengyunsanguo_query',
  description: '风云三国题库候选召回',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

/** 记录到注入 store 的假 transport：模拟真实 MCPTransport.callTool 的工具明细埋点——
 * 读 getTraceId()，server.ts 中间件 runWithTraceId 上下文就位即自动落库（验证 A008 接线）；
 * mcp_server/tool_name 归属与 storage 明细写入本身由 A004 registry / A007 storage 既有测试覆盖。 */
class TracingTransport {
  constructor(private store: LogStore) {}

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const traceId = getTraceId();
    if (traceId) {
      try {
        this.store.appendToolCall(traceId, {
          mcpServer: FENGYUNSANGUO_SERVER_NAME,
          toolName: name,
          argsSummary: JSON.stringify(args),
          callSentAt: Date.now(),
          callReturnedAt: Date.now(),
          resultSummary: '{"content":[{"type":"text","text":"模拟回复"}]}',
          status: 'success',
        });
      } catch {
        // 旁路：埋点失败静默，绝不影响工具调用
      }
    }
    return { content: [{ type: 'text', text: '模拟回复' }] };
  }

  async fengyunsanguo_quiz_command(
    message: string,
    sessionId?: string
  ): Promise<ToolCallResult> {
    const args: Record<string, unknown> = { message };
    if (sessionId) {
      args.sessionId = sessionId;
    }
    return this.callTool(FENGYUNSANGUO_QUIZ_COMMAND_TOOL, args);
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    return [FENGYUNSANGUO_QUERY_TOOL, QUIZ_COMMAND_TOOL];
  }
}

/** 无 LLM / 无工具调用的 Agent 替身：只实现 server.ts 依赖的 processQueryData / listTools */
class StubAgent {
  async processQueryData(
    query: string
  ): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    return [];
  }
}

/** quiz 替身（不落工具明细）：只实现 server.ts 依赖的 fengyunsanguo_quiz_command */
class QuizSimTransport {
  async fengyunsanguo_quiz_command(message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: '模拟回复' }] };
  }
}

interface StartOptions {
  agent?: Agent;
  logStore?: LogStore;
  transport?: MCPTransport;
}

async function startServer(
  t: TestContext,
  options: StartOptions = {}
): Promise<{ baseUrl: string; logStore: LogStore }> {
  const logStore = options.logStore ?? createLogStore({ dbPath: ':memory:' });
  t.after(() => {
    try {
      logStore.close();
    } catch {
      // 故障注入用 store 的 close 也可能抛错，测试收尾不因此失败
    }
  });
  const app = createServer(
    (options.agent ?? new StubAgent()) as unknown as Agent,
    (options.transport ?? new QuizSimTransport()) as unknown as MCPTransport,
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
  return { baseUrl: `http://127.0.0.1:${port}`, logStore };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function makeLLMConfig(): LLMConfig {
  return {
    provider: 'deepseek',
    model: 'mock-model',
    apiKey: 'mock-key',
    apiBaseUrl: 'https://mock.local',
  };
}

function quizTransport(logStore: LogStore): MCPTransport {
  return new TracingTransport(logStore) as unknown as MCPTransport;
}

test('quiz 埋点：/api/sango/random 落主表 quiz/fengyunsanguo/answer/citations=[]，工具明细 fengyunsanguo_quiz_command，无 LLM 明细（列表 tokens=null）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const { baseUrl } = await startServer(t, {
    logStore,
    transport: quizTransport(logStore),
  });

  const res = await post(
    baseUrl,
    '/api/sango/random',
    { message: '随机一题', sessionId: 's1' },
    { 'X-Trace-Id': TRACE_ID, 'X-Client-Sent-At': '1789883998000' }
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.headers.get('x-trace-id'), TRACE_ID);
  assert.deepEqual(Object.keys(res.body.data).sort(), ['answer', 'citations'], '响应体契约不变');
  assert.equal(res.body.data.answer, '模拟回复');
  assert.deepEqual(res.body.data.citations, []);

  logStore.flush();
  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.log.logType, 'quiz');
  assert.equal(detail.log.userInput, '随机一题');
  assert.equal(detail.log.domain, 'fengyunsanguo');
  assert.equal(detail.log.clientSentAt, 1789883998000);
  assert.ok(detail.log.serverReceivedAt > 0);
  assert.ok(detail.log.handleStartedAt !== null, 't2 已回填');
  assert.ok(detail.log.serverRespondedAt !== null, 't5 已回填');
  assert.ok(
    detail.log.handleStartedAt! >= detail.log.serverReceivedAt &&
      detail.log.serverRespondedAt! >= detail.log.handleStartedAt!,
    't1 ≤ t2 ≤ t5'
  );
  assert.equal(detail.log.status, 'success');
  assert.equal(detail.log.responseCode, 200);
  assert.equal(detail.log.errorMessage, '');
  assert.equal(detail.log.answer, '模拟回复');
  assert.equal(detail.log.citations, '[]', 'quiz 恒无原文引用');

  assert.equal(detail.llmCalls.length, 0, 'quiz 为确定性薄转发，不经 LLM');
  assert.equal(detail.toolCalls.length, 1, '一次 HTTP 请求恰好调用一次工具 → 一条明细');
  assert.equal(detail.toolCalls[0].mcpServer, 'fengyunsanguo');
  assert.equal(detail.toolCalls[0].toolName, 'fengyunsanguo_quiz_command');
  assert.equal(detail.toolCalls[0].status, 'success');
  assert.ok(detail.toolCalls[0].callReturnedAt !== null, '工具耗时已回填');

  const item = logStore.queryList({}).list.find((row) => row.traceId === TRACE_ID)!;
  assert.equal(item.logType, 'quiz');
  assert.equal(item.domain, 'fengyunsanguo');
  assert.equal(item.tokens, null, '无 LLM 明细时列表 tokens 恒 null');
});

test('quiz 埋点：X-Client-Sent-At（t0）+ t6 补报回填 durations.frontend；未知 traceId 补报静默 200', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const { baseUrl } = await startServer(t, {
    logStore,
    transport: quizTransport(logStore),
  });

  const SENT_AT = Date.now() - 1000;
  const res = await post(
    baseUrl,
    '/api/sango/random',
    { message: '随机一题' },
    { 'X-Trace-Id': TRACE_ID, 'X-Client-Sent-At': String(SENT_AT) }
  );
  assert.equal(res.status, 200);

  const unknown = await post(
    baseUrl,
    '/api/v1/logs/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/frontend-end',
    { clientReceivedAt: Date.now() }
  );
  assert.equal(unknown.status, 200, '未知 traceId 补报静默 200');
  assert.equal(unknown.body.code, 200);

  const RECEIVED_AT = Date.now() + 100;
  const report = await post(baseUrl, `/api/v1/logs/${TRACE_ID}/frontend-end`, {
    clientReceivedAt: RECEIVED_AT,
  });
  assert.equal(report.status, 200);
  assert.equal(report.body.code, 200);

  logStore.flush();
  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.log.clientSentAt, SENT_AT);
  assert.equal(detail.log.clientReceivedAt, RECEIVED_AT, 't6 已回填');
  assert.ok(detail.log.serverReceivedAt >= SENT_AT);
  assert.ok(detail.log.serverRespondedAt! <= RECEIVED_AT, 't5 在 t6 之前');

  const item = logStore.queryList({}).list.find((row) => row.traceId === TRACE_ID)!;
  assert.ok(item.durations.frontend !== null, 't0+t6 齐备后 frontend 时长有值');
  assert.equal(
    item.durations.frontend,
    detail.log.serverReceivedAt - SENT_AT + (RECEIVED_AT - detail.log.serverRespondedAt!)
  );
});

test('quiz 埋点：缺失 X-Trace-Id 时响应头返回兜底 UUID v4，且用该值可补报成功回填 t6', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const { baseUrl } = await startServer(t, {
    logStore,
    transport: quizTransport(logStore),
  });

  const res = await post(baseUrl, '/api/sango/random', { message: '随机一题' });
  assert.equal(res.status, 200);
  const traceId = res.headers.get('x-trace-id');
  assert.ok(traceId, '响应头必须回写兜底 X-Trace-Id');
  assert.match(traceId!, UUID_V4_PATTERN);

  const RECEIVED_AT = Date.now();
  const report = await post(baseUrl, `/api/v1/logs/${traceId}/frontend-end`, {
    clientReceivedAt: RECEIVED_AT,
  });
  assert.equal(report.status, 200);
  assert.equal(report.body.code, 200);

  logStore.flush();
  const detail = logStore.queryDetail(traceId!)!;
  assert.equal(detail.log.traceId, traceId);
  assert.equal(detail.log.logType, 'quiz');
  assert.equal(detail.log.clientSentAt, null, '未上报 X-Client-Sent-At 时为 NULL');
  assert.equal(detail.log.clientReceivedAt, RECEIVED_AT, '兜底 traceId 可用于补报回填 t6');
});

test('quiz 埋点：校验失败（400 / 413）也落主表一条，handle_started_at 为 NULL', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const { baseUrl } = await startServer(t, { logStore });

  const empty = await post(baseUrl, '/api/sango/random', { message: '' });
  assert.equal(empty.status, 400);
  const badTrace = empty.headers.get('x-trace-id')!;

  const tooLong = await post(baseUrl, '/api/sango/random', { message: 'x'.repeat(301) });
  assert.equal(tooLong.status, 413);
  const longTrace = tooLong.headers.get('x-trace-id')!;

  logStore.flush();
  const cases: Array<[string, number, string]> = [
    [badTrace, 400, 'message 不能为空'],
    [longTrace, 413, '消息不能超过 300 字符'],
  ];
  for (const [traceId, code, message] of cases) {
    const detail = logStore.queryDetail(traceId)!;
    assert.equal(detail.log.logType, 'quiz');
    assert.equal(detail.log.domain, 'fengyunsanguo', '校验失败同样固定 domain');
    assert.equal(detail.log.status, 'failed');
    assert.equal(detail.log.responseCode, code);
    assert.equal(detail.log.errorMessage, message);
    assert.equal(detail.log.handleStartedAt, null, '未入队 t2 为 NULL');
    assert.ok(detail.log.serverRespondedAt !== null, 't5 回填校验失败时刻');
    assert.equal(detail.log.answer, null);
    assert.equal(detail.log.citations, null);
  }
});

test('/api/chat：domain=weather 下线后 400 且文案固定（feat-A011）；未知 domain 仍 400', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const { baseUrl } = await startServer(t, { logStore });

  const weather = await post(
    baseUrl,
    '/api/chat',
    { message: '北京今天适合出门吗', domain: 'weather' },
    { 'X-Trace-Id': TRACE_ID }
  );
  assert.equal(weather.status, 400, 'weather 已下线，校验拒绝');
  assert.equal(weather.body.code, 400);
  assert.equal(weather.body.message, 'domain 字段仅支持 fengyunsanguo、sango-novel');

  logStore.flush();
  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.log.logType, 'chat');
  assert.equal(detail.log.domain, 'weather', '校验失败同样落主表，domain 取请求体');
  assert.equal(detail.log.status, 'failed');
  assert.equal(detail.log.responseCode, 400);
  assert.equal(detail.log.errorMessage, 'domain 字段仅支持 fengyunsanguo、sango-novel');

  const unknown = await post(baseUrl, '/api/chat', { message: '你好', domain: 'banana' });
  assert.equal(unknown.status, 400, '未知 domain 仍 400');
  assert.equal(unknown.body.code, 400);
  const unknownTrace = unknown.headers.get('x-trace-id')!;

  logStore.flush();
  const unknownDetail = logStore.queryDetail(unknownTrace)!;
  assert.equal(unknownDetail.log.status, 'failed');
  assert.equal(unknownDetail.log.responseCode, 400);
  assert.equal(
    unknownDetail.log.errorMessage,
    'domain 字段仅支持 fengyunsanguo、sango-novel'
  );
});

test('/api/chat：domain=fengyunsanguo 走题库快路径，工具明细落 fengyunsanguo_query', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const transport = quizTransport(logStore);
  const modelCaller = async (
    _messages: unknown[],
    _tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => ({
    content: [{ type: 'text', text: '元让' }],
  });
  const agent = new Agent(transport, makeLLMConfig(), { modelCaller });
  const { baseUrl } = await startServer(t, { logStore, transport, agent });

  const res = await post(
    baseUrl,
    '/api/chat',
    { message: '夏侯惇的字是什么？', domain: 'fengyunsanguo' },
    { 'X-Trace-Id': TRACE_ID }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.answer, '元让');

  logStore.flush();
  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.log.domain, 'fengyunsanguo');
  const tool = detail.toolCalls.find((call) => call.toolName === 'fengyunsanguo_query');
  assert.ok(tool, '工具明细含 fengyunsanguo_query');
  assert.equal(tool!.mcpServer, 'fengyunsanguo');
  assert.equal(tool!.status, 'success');
});

test('旁路：日志存储抛错时 /api/sango/random 仍 200 正常返回（故障注入，验收⑦）', async (t) => {
  const throwingStore = new ThrowingStore() as unknown as LogStore;
  const { baseUrl } = await startServer(t, {
    logStore: throwingStore,
    transport: quizTransport(throwingStore),
  });

  const res = await post(baseUrl, '/api/sango/random', { message: '随机一题' });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.answer, '模拟回复');
  assert.deepEqual(res.body.data.citations, []);
  assert.ok(res.headers.get('x-trace-id'), '兜底 traceId 仍随响应头返回');
});

/** 所有方法都抛错：模拟存储故障，验证埋点旁路（查询接口 500 见 logs-api.test.ts） */
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
