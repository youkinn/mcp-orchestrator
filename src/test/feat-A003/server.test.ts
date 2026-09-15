import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../../agent.js';
import {
  SangoService,
  SANGO_NO_SESSION_PROMPT,
  type SangoQuestion,
} from '../../sango.js';
import { createServer } from '../../server.js';
import { ToolExecutionError, type MCPToolDefinition } from '../../types.js';

const QUESTION: SangoQuestion = {
  question: '夏侯惇的字是什么？',
  options: { A: '元让', B: '妙才', C: '子龙', D: '云长' },
  answer: '元让',
};

const QUESTION_ANSWER = '题目：夏侯惇的字是什么？\nA. 元让\nB. 妙才\nC. 子龙\nD. 云长';

const MCP_TOOLS: MCPToolDefinition[] = [
  {
    name: 'get-alerts',
    description: '获取美国某个州的当前天气预警',
    inputSchema: { type: 'object' },
  },
  {
    name: 'get-forecast',
    description: '获取美国境内某个经纬度位置的天气预报',
    inputSchema: { type: 'object' },
  },
];

const SANGO_TOOL: MCPToolDefinition = {
  name: 'sango_query',
  description: '风云三国题库检索：仅当用户询问风云三国游戏内招募武将问答题时调用',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface StubAgentOptions {
  reply?: string;
  tools?: MCPToolDefinition[];
  chatError?: Error;
  listToolsError?: Error;
  delayMs?: number;
  order?: string[];
}

/** 统一 Agent 替身：只实现 server.ts 依赖的 processQuery / listTools，不发真实 LLM 与 MCP 调用 */
class StubAgent {
  queries: string[] = [];
  listToolsCalls = 0;
  maxActive = 0;
  private active = 0;

  constructor(private options: StubAgentOptions = {}) {}

  async processQuery(query: string): Promise<string> {
    this.queries.push(query);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.options.order?.push('chat:start');
    try {
      if (this.options.delayMs) {
        await sleep(this.options.delayMs);
      }
      if (this.options.chatError) {
        throw this.options.chatError;
      }
      return this.options.reply ?? '统一 Agent 回复';
    } finally {
      this.active -= 1;
      this.options.order?.push('chat:end');
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    this.listToolsCalls += 1;
    if (this.options.listToolsError) {
      throw this.options.listToolsError;
    }
    return this.options.tools ?? [...MCP_TOOLS, SANGO_TOOL];
  }
}

function asAgent(stub: StubAgent): Agent {
  return stub as unknown as Agent;
}

function makeSangoService(
  t: TestContext,
  entries: unknown[] = [QUESTION]
): SangoService {
  const dir = mkdtempSync(join(tmpdir(), 'sango-a003-'));
  const file = join(dir, 'questions.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }));
  return new SangoService({ questionFile: file });
}

/** 记录调用顺序的随机一题服务：用于断言两个端点共用同一条串行队列 */
function recordingSango(
  service: SangoService,
  order: string[],
  delayMs = 0
): SangoService {
  return {
    async handleRandom(message: string, sessionId?: string) {
      order.push('random:start');
      if (delayMs) {
        await sleep(delayMs);
      }
      const answer = service.handleRandom(message, sessionId);
      order.push('random:end');
      return answer;
    },
  } as unknown as SangoService;
}

interface StartOptions {
  agent?: StubAgent;
  sango?: SangoService;
}

async function startServer(
  t: TestContext,
  options: StartOptions = {}
): Promise<string> {
  const agent = options.agent ?? new StubAgent();
  const sangoService = options.sango ?? makeSangoService(t);
  const app = createServer(asAgent(agent), sangoService, {
    port: 0,
    allowedOrigin: '*',
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

async function get(
  baseUrl: string,
  path: string
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

/** ⑩ 信封断言：顶层只有 code / data / message，且与期望完全一致 */
function assertEnvelope(
  body: any,
  code: number,
  data: unknown,
  message: string
): void {
  assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'message']);
  assert.deepEqual(body, { code, data, message });
}

test('⑥ /api/chat 只传 message：统一 Agent 收到 trim 后的问题，返回 200 信封', async (t) => {
  const agent = new StubAgent({ reply: '纽约晴，24℃，适合出行' });
  const baseUrl = await startServer(t, { agent });

  const res = await post(baseUrl, '/api/chat', {
    message: '  纽约今天适合坐地铁出门吗？  ',
  });

  assert.equal(res.status, 200);
  assertEnvelope(res.body, 200, { answer: '纽约晴，24℃，适合出行' }, '');
  assert.deepEqual(agent.queries, ['纽约今天适合坐地铁出门吗？']);
});

test('⑦ /api/chat 携带 scenario / service / sessionId → 400，无效字段按请求体顺序全部列出', async (t) => {
  const agent = new StubAgent();
  const baseUrl = await startServer(t, { agent });

  const cases: Array<[Record<string, unknown>, string]> = [
    [
      { message: '你好', scenario: 'weather' },
      '请求体只支持 message、domain 字段，收到无效字段：scenario',
    ],
    [
      { message: '你好', service: 'random' },
      '请求体只支持 message、domain 字段，收到无效字段：service',
    ],
    [
      { message: '你好', sessionId: 'sid' },
      '请求体只支持 message、domain 字段，收到无效字段：sessionId',
    ],
    [
      { message: '你好', scenario: 'sango', service: 'random' },
      '请求体只支持 message、domain 字段，收到无效字段：scenario、service',
    ],
  ];

  for (const [body, expected] of cases) {
    const res = await post(baseUrl, '/api/chat', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assertEnvelope(res.body, 400, null, expected);
  }
  assert.deepEqual(agent.queries, [], '校验失败不应触达 Agent');
});

test('⑦ /api/sango/random 白名单为 message、sessionId，其余键 400', async (t) => {
  const baseUrl = await startServer(t);

  const res = await post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId: 'sid',
    scenario: 'sango',
    service: 'random',
  });

  assert.equal(res.status, 400);
  assertEnvelope(
    res.body,
    400,
    null,
    '请求体只支持 message、sessionId 字段，收到无效字段：scenario、service'
  );
});

test('校验：message 缺失 / 空串 / 纯空白 / 非字符串 → 400 message 不能为空（两个端点一致）', async (t) => {
  const baseUrl = await startServer(t);
  const bodies: Array<Record<string, unknown>> = [
    {},
    { message: '' },
    { message: '   ' },
    { message: 42 },
    { message: null },
  ];

  for (const path of ['/api/chat', '/api/sango/random']) {
    for (const body of bodies) {
      const res = await post(baseUrl, path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assertEnvelope(res.body, 400, null, 'message 不能为空');
    }
  }
});

test('校验：message 超 300 字符 → 413，恰好 300 字符放行', async (t) => {
  const baseUrl = await startServer(t);

  const tooLong = await post(baseUrl, '/api/chat', {
    message: 'a'.repeat(301),
  });
  assert.equal(tooLong.status, 413);
  assertEnvelope(tooLong.body, 413, null, '消息不能超过 300 字符');

  const exact = await post(baseUrl, '/api/sango/random', {
    message: 'a'.repeat(300),
  });
  assert.equal(exact.status, 200);
});

test('⑧ /api/tools 返回统一 Agent 可见的全部工具（MCP 工具 + 本地 sango_query）', async (t) => {
  const agent = new StubAgent({ tools: [...MCP_TOOLS, SANGO_TOOL] });
  const baseUrl = await startServer(t, { agent });

  const res = await get(baseUrl, '/api/tools');

  assert.equal(res.status, 200);
  assertEnvelope(res.body, 200, { tools: [...MCP_TOOLS, SANGO_TOOL] }, '');
  assert.deepEqual(
    res.body.data.tools.map((tool: any) => tool.name),
    ['get-alerts', 'get-forecast', 'sango_query']
  );
  assert.equal(agent.listToolsCalls, 1);
});

test('⑧ /api/tools：Agent.listTools() 抛错 → 503 MCP Server 未连接', async (t) => {
  const agent = new StubAgent({
    listToolsError: new Error('Transport not connected'),
  });
  const baseUrl = await startServer(t, { agent });

  const res = await get(baseUrl, '/api/tools');

  assert.equal(res.status, 503);
  assertEnvelope(res.body, 503, null, 'MCP Server 未连接');
});

test('装配回归：index.ts 合成 [...mcpTools, SANGO_QUERY_TOOL] 并把单个 Agent 交给 createServer', () => {
  const source = readFileSync(join(__dirname, '../../../src/index.ts'), 'utf8');

  assert.match(source, /const mcpTools = await transport\.listTools\(\);/);
  assert.match(source, /tools: \[\.\.\.mcpTools, SANGO_QUERY_TOOL\]/);
  assert.match(source, /new Agent\(transport, llmConfig, \{/);
  assert.match(
    source,
    /createServer\(agent, sangoService, \{ port, allowedOrigin \}\)/
  );
  assert.match(
    source,
    /风云三国题库检索：仅当用户询问风云三国游戏内招募武将问答题时调用/
  );
  assert.doesNotMatch(
    source,
    /GENERAL_SYSTEM_PROMPT|SANGO_KNOWLEDGE_SYSTEM_PROMPT|sangoKnowledge/
  );
});

test('ToolExecutionError 契约：Error 子类、携带 toolName、保留 cause（小胡在 agent.ts 抛出）', () => {
  const cause = new Error('MCP down');
  const error = new ToolExecutionError('get-forecast', { cause });

  assert.ok(error instanceof Error);
  assert.ok(error instanceof ToolExecutionError);
  assert.equal(error.name, 'ToolExecutionError');
  assert.equal(error.toolName, 'get-forecast');
  assert.equal(error.cause, cause);
  assert.match(error.message, /get-forecast/);
});

test('503：ToolExecutionError → 工具服务暂不可用，请稍后重试', async (t) => {
  const agent = new StubAgent({
    chatError: new ToolExecutionError('get-forecast', {
      cause: new Error('MCP down'),
    }),
  });
  const baseUrl = await startServer(t, { agent });

  const res = await post(baseUrl, '/api/chat', {
    message: '纽约今天天气如何？',
  });

  assert.equal(res.status, 503);
  assertEnvelope(res.body, 503, null, '工具服务暂不可用，请稍后重试');
});

test('500：非 ToolExecutionError 异常 → 处理请求失败，请稍后重试，且不泄漏内部详情', async (t) => {
  const agent = new StubAgent({
    chatError: new Error('LLM auth failed: sk-secret-key'),
  });
  const baseUrl = await startServer(t, { agent });

  const res = await post(baseUrl, '/api/chat', { message: '你好' });

  assert.equal(res.status, 500);
  assertEnvelope(res.body, 500, null, '处理请求失败，请稍后重试');
  assert.doesNotMatch(JSON.stringify(res.body), /sk-secret-key/);
});

test('⑨ /api/sango/random：出题 → 判对 → 判错 → 查答案 → 无会话提示，全程不调用 Agent', async (t) => {
  const agent = new StubAgent();
  const baseUrl = await startServer(t, { agent });
  const sessionId = 'sid-a003';

  const quiz = await post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId,
  });
  assert.equal(quiz.status, 200);
  assertEnvelope(quiz.body, 200, { answer: QUESTION_ANSWER }, '');

  const correct = await post(baseUrl, '/api/sango/random', {
    message: 'A',
    sessionId,
  });
  assertEnvelope(correct.body, 200, { answer: '答对了！正确答案：元让（A）' }, '');

  const wrong = await post(baseUrl, '/api/sango/random', {
    message: '妙才',
    sessionId,
  });
  assertEnvelope(wrong.body, 200, { answer: '答错了，正确答案：元让（A）' }, '');

  const reveal = await post(baseUrl, '/api/sango/random', {
    message: '答案',
    sessionId,
  });
  assertEnvelope(reveal.body, 200, { answer: '正确答案：元让（A）' }, '');

  const withoutSession = await post(baseUrl, '/api/sango/random', {
    message: 'A',
  });
  assertEnvelope(
    withoutSession.body,
    200,
    { answer: SANGO_NO_SESSION_PROMPT },
    ''
  );

  assert.deepEqual(agent.queries, [], '随机一题不经 LLM，不应触达统一 Agent');
});

test('⑨ sessionId 非字符串 / 空串 / 纯空白视为未传 → 无会话提示', async (t) => {
  const baseUrl = await startServer(t);

  for (const sessionId of ['', '   ', 42, null]) {
    const res = await post(baseUrl, '/api/sango/random', {
      message: 'A',
      sessionId,
    });
    assert.equal(res.status, 200, String(sessionId));
    assertEnvelope(res.body, 200, { answer: SANGO_NO_SESSION_PROMPT }, '');
  }
});

test('⑨ sessionId 归一化：出题带空白、作答用 trim 后的同一 id 仍命中会话', async (t) => {
  const baseUrl = await startServer(t);

  await post(baseUrl, '/api/sango/random', {
    message: '来一题',
    sessionId: '  sid-trim  ',
  });
  const judge = await post(baseUrl, '/api/sango/random', {
    message: 'A',
    sessionId: 'sid-trim',
  });

  assertEnvelope(judge.body, 200, { answer: '答对了！正确答案：元让（A）' }, '');
});

test('/api/sango/random 不依赖 MCP：本地规则异常落 500，本端点没有 503', async (t) => {
  const broken = {
    handleRandom: () => {
      throw new Error('question bank broken');
    },
  } as unknown as SangoService;
  const baseUrl = await startServer(t, { sango: broken });

  const res = await post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId: 'sid',
  });

  assert.equal(res.status, 500);
  assertEnvelope(res.body, 500, null, '处理请求失败，请稍后重试');
});

test('⑩ 所有接口均为 { code, data, message } 信封：成功 data 有值，失败 data 为 null', async (t) => {
  const agent = new StubAgent({ reply: 'ok' });
  const baseUrl = await startServer(t, { agent });

  const responses = [
    await get(baseUrl, '/health'),
    await get(baseUrl, '/api/tools'),
    await post(baseUrl, '/api/chat', { message: '你好' }),
    await post(baseUrl, '/api/chat', { message: '' }),
    await post(baseUrl, '/api/chat', { message: 'a'.repeat(301) }),
    await post(baseUrl, '/api/chat', { message: '你好', scenario: 'weather' }),
    await post(baseUrl, '/api/sango/random', { message: '随机一题' }),
  ];

  for (const res of responses) {
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ['code', 'data', 'message'],
      `status=${res.status}`
    );
    assert.equal(res.body.code, res.status);
    if (res.body.code === 200) {
      assert.notEqual(res.body.data, null);
      assert.equal(res.body.message, '');
    } else {
      assert.equal(res.body.data, null);
      assert.ok(res.body.message.length > 0);
    }
  }
});

test('队列串行：/api/chat 并发请求不重叠执行（同一时刻只有一个在跑）', async (t) => {
  const agent = new StubAgent({ delayMs: 30 });
  const baseUrl = await startServer(t, { agent });

  const results = await Promise.all([
    post(baseUrl, '/api/chat', { message: '第一问' }),
    post(baseUrl, '/api/chat', { message: '第二问' }),
    post(baseUrl, '/api/chat', { message: '第三问' }),
  ]);

  assert.deepEqual(
    results.map((res) => res.status),
    [200, 200, 200]
  );
  assert.equal(agent.maxActive, 1, '并发请求必须排队，不能同时进入 Agent');
  assert.deepEqual([...agent.queries].sort(), [
    '第一问',
    '第三问',
    '第二问',
  ].sort());
});

test('队列串行：/api/chat 与 /api/sango/random 共用一条队列，按到达顺序执行', async (t) => {
  const order: string[] = [];
  const agent = new StubAgent({ delayMs: 40, order });
  const sango = recordingSango(makeSangoService(t), order);
  const baseUrl = await startServer(t, { agent, sango });

  const chat = post(baseUrl, '/api/chat', { message: '纽约天气' });
  await sleep(15);
  const random = post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId: 'sid-q',
  });
  const [chatRes, randomRes] = await Promise.all([chat, random]);

  assert.equal(chatRes.status, 200);
  assert.equal(randomRes.status, 200);
  assert.deepEqual(order, [
    'chat:start',
    'chat:end',
    'random:start',
    'random:end',
  ]);
});

test('/health 保持 feat-A002 行为：200 信封', async (t) => {
  const baseUrl = await startServer(t);

  const res = await get(baseUrl, '/health');

  assert.equal(res.status, 200);
  assertEnvelope(
    res.body,
    200,
    { status: 'ok', service: 'mcp-orchestrator' },
    ''
  );
});
