import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import {
  ToolExecutionError,
  type MCPToolDefinition,
  type ToolCallResult,
} from '../../types.js';

type SangoOptionKey = 'A' | 'B' | 'C' | 'D';

interface SangoQuestion {
  question: string;
  options: Record<SangoOptionKey, string>;
  answer: string;
}

const QUESTION: SangoQuestion = {
  question: '夏侯惇的字是什么？',
  options: { A: '元让', B: '妙才', C: '子龙', D: '云长' },
  answer: '元让',
};

const QUESTION_ANSWER =
  '题目：夏侯惇的字是什么？\nA. 元让\nB. 妙才\nC. 子龙\nD. 云长';

/** 与 mcp-server fengyunsanguo 的提示词同文（搬迁前 sango.ts 常量） */
const SANGO_NO_SESSION_PROMPT = '请先发送“随机一题”开始';

const OPTION_KEYS: SangoOptionKey[] = ['A', 'B', 'C', 'D'];
const RANDOM_COMMANDS = new Set(['随机一题', '来一题']);
const ANSWER_COMMANDS = new Set(['答案', '这题选什么']);

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

/** 风云三国候选召回：与 mcp-server fengyunsanguo_query 同名同文（来源 MCP） */
const FENGYUNSANGUO_TOOL: MCPToolDefinition = {
  name: 'fengyunsanguo_query',
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
  domains: string[] = [];
  listToolsCalls = 0;
  maxActive = 0;
  private active = 0;

  constructor(private options: StubAgentOptions = {}) {}

  async processQuery(query: string, domain?: string): Promise<string> {
    this.queries.push(query);
    if (domain !== undefined) this.domains.push(domain);
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
    return this.options.tools ?? [...MCP_TOOLS, FENGYUNSANGUO_TOOL];
  }
}

function asAgent(stub: StubAgent): Agent {
  return stub as unknown as Agent;
}

/**
 * quiz 替身：模拟 mcp-server fengyunsanguo_quiz_command 状态机（出题 / 判题 / 查答案 / 无会话），
 * 行为与搬迁前 SangoService.handleRandom 一致；只实现 server.ts 依赖的 fengyunsanguo_quiz_command。
 */
class QuizSimTransport {
  calls: Array<{ message: string; sessionId?: string }> = [];
  private sessions = new Map<string, { question: SangoQuestion; createdAt: number }>();

  constructor(
    private options: { ttlMs?: number; error?: Error; delayMs?: number; order?: string[] } = {}
  ) {}

  getCurrentQuestion(sessionId: string): SangoQuestion | null {
    return this.session(sessionId)?.question ?? null;
  }

  async fengyunsanguo_quiz_command(
    message: string,
    sessionId?: string
  ): Promise<ToolCallResult> {
    this.calls.push({ message, sessionId });
    this.options.order?.push('random:start');
    if (this.options.delayMs) {
      await sleep(this.options.delayMs);
    }
    try {
      if (this.options.error) {
        throw this.options.error;
      }
      return {
        content: [{ type: 'text', text: this.handleRandom(message, sessionId) }],
      };
    } finally {
      this.options.order?.push('random:end');
    }
  }

  private handleRandom(message: string, sessionId?: string): string {
    const normalized = normalize(message);

    if (RANDOM_COMMANDS.has(normalized)) {
      if (sessionId) {
        this.sessions.set(sessionId, { question: QUESTION, createdAt: Date.now() });
      }
      return QUESTION_ANSWER;
    }

    const session = sessionId ? this.session(sessionId) : null;
    if (!session) {
      return SANGO_NO_SESSION_PROMPT;
    }

    if (ANSWER_COMMANDS.has(normalized)) {
      return this.formatAnswer(this.answerOf(session.question));
    }

    const result = this.judge(message, session.question);
    if (!result) {
      return `答错了，${this.formatAnswer(this.answerOf(session.question))}`;
    }
    return result.correct
      ? `答对了！${this.formatAnswer(result.answer)}`
      : `答错了，${this.formatAnswer(result.answer)}`;
  }

  private session(sessionId: string): { question: SangoQuestion; createdAt: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (Date.now() - session.createdAt > (this.options.ttlMs ?? 30 * 60 * 1000)) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  private judge(
    text: string,
    question: SangoQuestion
  ): { correct: boolean; answer: { key: SangoOptionKey; text: string } } | null {
    const normalized = normalize(text);
    const key = this.matchOptionKey(normalized, question);
    if (!key) {
      return null;
    }
    const answer = this.answerOf(question);
    return { correct: key === answer.key, answer };
  }

  private matchOptionKey(
    normalized: string,
    question: SangoQuestion
  ): SangoOptionKey | null {
    if (normalized.length === 1) {
      const letterIndex = 'abcd'.indexOf(normalized);
      if (letterIndex >= 0) {
        return OPTION_KEYS[letterIndex]!;
      }
    }
    for (const key of OPTION_KEYS) {
      if (normalize(question.options[key]) === normalized) {
        return key;
      }
    }
    return null;
  }

  private answerOf(question: SangoQuestion): { key: SangoOptionKey; text: string } {
    const answerText = question.answer.trim();
    const key = OPTION_KEYS.find(
      (optionKey) => normalize(question.options[optionKey]) === normalize(answerText)
    );
    if (!key) {
      throw new Error('QuizSimTransport: question answer not found in options');
    }
    return { key, text: answerText };
  }

  private formatAnswer(answer: { key: SangoOptionKey; text: string }): string {
    return `正确答案：${answer.text}（${answer.key}）`;
  }
}

/** 归一化：全角→半角、小写、去空白与标点（与 mcp-server fengyunsanguo 一致） */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\p{P}/gu, '');
}

interface StartOptions {
  agent?: StubAgent;
  quiz?: QuizSimTransport;
}

async function startServer(
  t: TestContext,
  options: StartOptions = {}
): Promise<string> {
  const agent = options.agent ?? new StubAgent();
  const quiz = (options.quiz ?? new QuizSimTransport()) as unknown as MCPTransport;
  const app = createServer(asAgent(agent), quiz, {
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

test('域名白名单：fengyunsanguo / sango-novel 透传给 Agent（旧值 sango 已废弃返回 400）', async (t) => {
  const agent = new StubAgent({ reply: 'ok' });
  const baseUrl = await startServer(t, { agent });

  for (const domain of ['fengyunsanguo', 'sango-novel']) {
    const res = await post(baseUrl, '/api/chat', { message: '你好', domain });
    assert.equal(res.status, 200, domain);
  }
  assert.deepEqual(
    agent.domains,
    ['fengyunsanguo', 'sango-novel'],
    'domain 应原样透传给 Agent'
  );

  const LEGACY_SANGO_VALUE = 'sango';
  const legacy = await post(baseUrl, '/api/chat', { message: '你好', domain: LEGACY_SANGO_VALUE });
  assert.equal(legacy.status, 400);
  assertEnvelope(legacy.body, 400, null, 'domain 字段仅支持 fengyunsanguo、sango-novel');

  const bad = await post(baseUrl, '/api/chat', {
    message: '你好',
    domain: 'weather',
  });
  assert.equal(bad.status, 400);
  assertEnvelope(bad.body, 400, null, 'domain 字段仅支持 fengyunsanguo、sango-novel');
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

test('⑧ /api/tools 返回统一 Agent 可见的全部工具（全部来自 MCP server，总台无本地工具）', async (t) => {
  const agent = new StubAgent({ tools: [...MCP_TOOLS, FENGYUNSANGUO_TOOL] });
  const baseUrl = await startServer(t, { agent });

  const res = await get(baseUrl, '/api/tools');

  assert.equal(res.status, 200);
  assertEnvelope(
    res.body,
    200,
    { tools: [...MCP_TOOLS, FENGYUNSANGUO_TOOL] },
    ''
  );
  assert.deepEqual(
    res.body.data.tools.map((tool: any) => tool.name),
    ['get-alerts', 'get-forecast', 'fengyunsanguo_query']
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

test('装配回归：index.ts 工具集全部来自 MCP、L3 走 fengyunsanguo_quiz_route、createServer 只收 transport', () => {
  const source = readFileSync(join(__dirname, '../../../src/index.ts'), 'utf8');

  assert.match(source, /const mcpTools = await transport\.listTools\(\);/);
  assert.match(source, /tools: mcpTools/);
  assert.match(source, /new Agent\(transport, llmConfig, \{/);
  assert.match(
    source,
    /fengyunsanguoVectorMatcher: \(query\) => transport\.fengyunsanguo_quiz_route\(query\)/
  );
  assert.match(
    source,
    /createServer\(agent, transport, \{ port, allowedOrigin \}\)/
  );
  // 总台无本地工具：不再出现 SangoService / localTools 装配
  assert.doesNotMatch(
    source,
    /SangoService|sangoService|localTools|FENGYUNSANGUO_QUERY_TOOL/
  );
});

test('ToolExecutionError 契约：Error 子类、携带 toolName、保留 cause（agent / transport 抛出）', () => {
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

test('⑨ /api/sango/random：出题 → 判对 → 判错 → 查答案 → 无会话提示，全程不调用 Agent，薄转发 quiz_command', async (t) => {
  const agent = new StubAgent();
  const quiz = new QuizSimTransport();
  const baseUrl = await startServer(t, { agent, quiz });
  const sessionId = 'sid-a003';

  const ask = await post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId,
  });
  assert.equal(ask.status, 200);
  assertEnvelope(ask.body, 200, { answer: QUESTION_ANSWER }, '');

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
  assert.deepEqual(
    quiz.calls.map((call) => call.message),
    ['随机一题', 'A', '妙才', '答案', 'A']
  );
  assert.deepEqual(
    quiz.calls.map((call) => call.sessionId),
    ['sid-a003', 'sid-a003', 'sid-a003', 'sid-a003', undefined]
  );
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

test('quiz 缺配 / 调用失败 → /api/sango/random 503（ToolExecutionError），/api/chat 其余功能正常', async (t) => {
  const agent = new StubAgent({ reply: '正常回复' });
  const quiz = new QuizSimTransport({
    error: new ToolExecutionError('fengyunsanguo_quiz_command', {
      cause: new Error('quiz 未配置'),
    }),
  });
  const baseUrl = await startServer(t, { agent, quiz });

  const random = await post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId: 'sid',
  });
  assert.equal(random.status, 503);
  assertEnvelope(random.body, 503, null, '工具服务暂不可用，请稍后重试');

  const chat = await post(baseUrl, '/api/chat', { message: '你好' });
  assert.equal(chat.status, 200);
  assertEnvelope(chat.body, 200, { answer: '正常回复' }, '');
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
  assert.deepEqual([...agent.queries].sort(), ['第一问', '第三问', '第二问'].sort());
});

test('队列串行：/api/chat 与 /api/sango/random 共用一条队列，按到达顺序执行', async (t) => {
  const order: string[] = [];
  const agent = new StubAgent({ delayMs: 40, order });
  const quiz = new QuizSimTransport({ delayMs: 10, order });
  const baseUrl = await startServer(t, { agent, quiz });

  const chat = post(baseUrl, '/api/chat', { message: '纽约天气' });
  await sleep(15);
  const random = post(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId: 'sid-q',
  });
  const [chatRes, randomRes] = await Promise.all([chat, random]);

  assert.equal(chatRes.status, 200);
  assert.equal(randomRes.status, 200);
  assert.deepEqual(order, ['chat:start', 'chat:end', 'random:start', 'random:end']);
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
