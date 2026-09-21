import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Agent, UNIFIED_SYSTEM_PROMPT } from '../../agent.js';
import { createServer } from '../../server.js';
import { createLogStore } from '../../storage/logs.js';
import { MCPTransport } from '../../transport.js';
import type {
  LLMConfig,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from '../../types.js';

/**
 * feat-A003 端到端集成用例（A005 适配版）：真实 server.ts + 真实 Agent + 替身 MCP transport，
 * 只把 MCP server 与 LLM 换成替身（零网络、不起真实 MCP Server）。
 * 风云三国能力全部经 MCP（fengyunsanguo_query / fengyunsanguo_quiz_route / fengyunsanguo_quiz_command），
 * 总台无本地工具；/api/sango/random 为薄转发。这里验「HTTP 请求 → 统一 Agent → MCP 工具」整条链路。
 *
 * 与同目录 server.test.ts（StubAgent，只验 HTTP 契约）、agent-routing.test.ts
 * （直调 Agent，不起服务，小胡维护）互补。
 */

const FORECAST_TOOL: MCPToolDefinition = {
  name: 'get-forecast',
  description:
    '获取美国境内某个经纬度位置的天气预报（数据源：美国国家气象局 NWS）。仅覆盖美国境内；非美国地区（如中国北京）不要调用本工具，应直接告知用户仅支持美国天气，不要编造数据。',
  inputSchema: { type: 'object' },
};

const ALERTS_TOOL: MCPToolDefinition = {
  name: 'get-alerts',
  description:
    '获取美国某个州的当前天气预警（数据源：美国国家气象局 NWS）。仅覆盖美国境内，state 必须是美国两字母州代码；非美国地区不要调用本工具。',
  inputSchema: { type: 'object' },
};

/** 与 mcp-server fengyunsanguo 工具契约同文的工具定义（MCP 上报，总台无本地工具） */
const FENGYUNSANGUO_QUERY_TOOL: MCPToolDefinition = {
  name: 'fengyunsanguo_query',
  description:
    '风云三国题库检索：仅当用户询问风云三国游戏内招募武将问答题时调用；参数 text 传用户原始问法，返回候选题目（题干 → 答案）',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
};

const FENGYUNSANGUO_QUIZ_ROUTE_TOOL: MCPToolDefinition = {
  name: 'fengyunsanguo_quiz_route',
  description: '风云三国题库高置信识别（L3 自动路由）',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
};

const FENGYUNSANGUO_QUIZ_COMMAND_TOOL: MCPToolDefinition = {
  name: 'fengyunsanguo_quiz_command',
  description: '风云三国随机一题状态机（出题 / 判题 / 查答案）',
  inputSchema: { type: 'object' },
};

const MCP_TOOLS: MCPToolDefinition[] = [
  FORECAST_TOOL,
  ALERTS_TOOL,
  FENGYUNSANGUO_QUERY_TOOL,
  FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
  FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
];
const UNIFIED_TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

type SangoOptionKey = 'A' | 'B' | 'C' | 'D';

interface SangoQuestion {
  question: string;
  options: Record<SangoOptionKey, string>;
  answer: string;
}

const QUESTIONS: SangoQuestion[] = [
  {
    question: '夏侯惇的字是什么？',
    options: { A: '元让', B: '妙才', C: '子龙', D: '云长' },
    answer: '元让',
  },
  {
    question: '「乐不思蜀」说的是谁？',
    options: { A: '刘禅', B: '刘备', C: '关羽', D: '张飞' },
    answer: '刘禅',
  },
];

const SANGO_NO_SESSION_PROMPT = '请先发送“随机一题”开始';

const OPTION_KEYS: SangoOptionKey[] = ['A', 'B', 'C', 'D'];
const RANDOM_COMMANDS = new Set(['随机一题', '来一题']);
const ANSWER_COMMANDS = new Set(['答案', '这题选什么']);

const LLM_CONFIG: LLMConfig = {
  provider: 'deepseek',
  model: 'mock-model',
  apiKey: 'mock-key',
  apiBaseUrl: 'https://mock.local',
};

/** 归一化：全角→半角、小写、去空白与标点（与 mcp-server fengyunsanguo 一致） */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\p{P}/gu, '');
}

/** 字符 bigram 集合（相邻二字组，与 mcp-server fengyunsanguo 召回算法一致） */
function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  if (text.length === 1) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i++) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

/**
 * fengyunsanguo server 替身：候选召回（bigram Dice）+ 随机一题状态机（出题 / 判题 / 查答案），
 * 行为与搬迁前 SangoService 一致，只存在于测试进程内。
 */
class FengyunsanguoSim {
  private sessions = new Map<string, { question: SangoQuestion; createdAt: number }>();

  constructor(private questions: SangoQuestion[]) {}

  getCurrentQuestion(sessionId: string): SangoQuestion | null {
    return this.session(sessionId)?.question ?? null;
  }

  candidates(text: string, limit = 8): Array<{ question: SangoQuestion; answer: string }> {
    const normalized = normalize(text);
    if (!normalized) {
      return [];
    }
    const inputGrams = bigrams(normalized);
    return this.questions
      .map((question) => {
        const questionGrams = bigrams(normalize(question.question));
        let shared = 0;
        for (const gram of inputGrams) {
          if (questionGrams.has(gram)) {
            shared += 1;
          }
        }
        return {
          question,
          score: (2 * shared) / (inputGrams.size + questionGrams.size),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => ({ question: entry.question, answer: entry.question.answer }));
  }

  quizCommand(message: string, sessionId?: string): string {
    const normalized = normalize(message);

    if (RANDOM_COMMANDS.has(normalized)) {
      const question = this.questions[Math.floor(Math.random() * this.questions.length)]!;
      if (sessionId) {
        this.sessions.set(sessionId, { question, createdAt: Date.now() });
      }
      return formatQuestion(question);
    }

    const session = sessionId ? this.session(sessionId) : null;
    if (!session) {
      return SANGO_NO_SESSION_PROMPT;
    }

    if (ANSWER_COMMANDS.has(normalized)) {
      return formatAnswer(answerOf(session.question));
    }

    const result = this.judge(message, session.question);
    if (!result) {
      return `答错了，${formatAnswer(answerOf(session.question))}`;
    }
    return result.correct
      ? `答对了！${formatAnswer(result.answer)}`
      : `答错了，${formatAnswer(result.answer)}`;
  }

  private session(sessionId: string): { question: SangoQuestion; createdAt: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (Date.now() - session.createdAt > 30 * 60 * 1000) {
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
    const key = matchOptionKey(normalized, question);
    if (!key) {
      return null;
    }
    const answer = answerOf(question);
    return { correct: key === answer.key, answer };
  }
}

function matchOptionKey(
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

function answerOf(question: SangoQuestion): { key: SangoOptionKey; text: string } {
  const answerText = question.answer.trim();
  const key = OPTION_KEYS.find(
    (optionKey) => normalize(question.options[optionKey]) === normalize(answerText)
  );
  if (!key) {
    throw new Error('FengyunsanguoSim: question answer not found in options');
  }
  return { key, text: answerText };
}

function formatQuestion(question: SangoQuestion): string {
  return (
    `题目：${question.question}\n` +
    `A. ${question.options.A}\n` +
    `B. ${question.options.B}\n` +
    `C. ${question.options.C}\n` +
    `D. ${question.options.D}`
  );
}

function formatAnswer(answer: { key: SangoOptionKey; text: string }): string {
  return `正确答案：${answer.text}（${answer.key}）`;
}

/**
 * MCP transport 替身：模拟 weather + fengyunsanguo 两个 MCP server 的工具行为，
 * 只记录调用，不发真实 stdio 连接；可注入指定工具失败 / 全局失败 / quiz_route 命中。
 */
class MockTransport extends MCPTransport {
  listToolsCount = 0;
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  callToolError: Error | null = null;

  constructor(
    private sim: FengyunsanguoSim,
    private options: {
      failTools?: string[];
      failToolsError?: Error;
      quizRouteHit?: boolean;
    } = {}
  ) {
    super('mock-server');
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    this.listToolsCount += 1;
    return MCP_TOOLS;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.callToolCalls.push({ name, args });
    if (this.options.failTools?.includes(name)) {
      throw (
        this.options.failToolsError ??
        new Error(`MCP tool failed: ${name}`)
      );
    }
    if (this.callToolError) {
      throw this.callToolError;
    }
    switch (name) {
      case 'get-forecast':
        return textResult('晴，5℃');
      case 'get-alerts':
        return textResult('大风预警');
      case 'fengyunsanguo_query': {
        const query = typeof args.text === 'string' ? args.text : '';
        const hits = this.sim.candidates(query);
        return textResult(
          hits.length
            ? hits
                .map((hit, index) => `${index + 1}. ${hit.question.question} → ${hit.answer}`)
                .join('\n')
            : '未召回到任何候选题目'
        );
      }
      case 'fengyunsanguo_quiz_route':
        return textResult(this.options.quizRouteHit === true ? 'true' : 'false');
      case 'fengyunsanguo_quiz_command':
        return textResult(
          this.sim.quizCommand(
            String(args.message),
            typeof args.sessionId === 'string' ? args.sessionId : undefined
          )
        );
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }
}

function textResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

interface ModelCall {
  systemPrompt: string;
  toolNames: string[];
  messages: any[];
}

/** LLM 替身：按脚本顺序返回响应，并记录每轮看到的 system prompt 与可见工具 */
class FakeModel {
  calls: ModelCall[] = [];
  private script: ModelResponse[];

  constructor(script: ModelResponse[]) {
    this.script = [...script];
  }

  respond = async (
    messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    const system = messages.find((item: any) => item?.role === 'system');
    this.calls.push({
      systemPrompt: typeof system?.content === 'string' ? system.content : '',
      toolNames: tools.map((tool) => tool.name),
      messages: [...messages],
    });
    const next = this.script.shift();
    if (!next) {
      throw new Error('模型脚本已耗尽：实际轮数多于预期');
    }
    return next;
  };
}

function toolUse(name: string, input: Record<string, unknown>): ModelResponse {
  return { content: [{ type: 'tool_use', id: 'call_' + name, name, input }] };
}

function text(answer: string): ModelResponse {
  return { content: [{ type: 'text', text: answer }] };
}

function lastMessage(call: ModelCall): any {
  return call.messages[call.messages.length - 1];
}

function callsNamed(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  name: string
): Array<{ name: string; args: Record<string, unknown> }> {
  return calls.filter((call) => call.name === name);
}

interface HarnessOptions {
  script?: ModelResponse[];
  questions?: SangoQuestion[];
  callToolError?: Error;
  failTools?: string[];
  failToolsError?: Error;
  quizRouteHit?: boolean;
}

interface Harness {
  baseUrl: string;
  transport: MockTransport;
  model: FakeModel;
  sim: FengyunsanguoSim;
}

/** 按 index.ts 的装配方式起真实服务：单个统一 Agent（L3 走 transport）+ createServer */
async function startApp(
  t: TestContext,
  options: HarnessOptions = {}
): Promise<Harness> {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => {
    try {
      logStore.close();
    } catch {
      // 故障注入用 store 的 close 也可能抛错，测试收尾不因此失败
    }
  });
  const sim = new FengyunsanguoSim(options.questions ?? QUESTIONS);
  const transport = new MockTransport(sim, {
    failTools: options.failTools,
    failToolsError: options.failToolsError,
    quizRouteHit: options.quizRouteHit,
  });
  transport.callToolError = options.callToolError ?? null;
  const model = new FakeModel(options.script ?? []);

  const agent = new Agent(transport, LLM_CONFIG, {
    systemPrompt: UNIFIED_SYSTEM_PROMPT,
    tools: MCP_TOOLS,
    // 与 index.ts 同形：L3 无 domain 自动路由走 transport 的 fengyunsanguo_quiz_route
    fengyunsanguoVectorMatcher: (query) => transport.fengyunsanguo_quiz_route(query),
    modelCaller: model.respond,
  });

  const app = createServer(agent, transport, { port: 0, allowedOrigin: '*', logStore });
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const baseUrl = 'http://127.0.0.1:' + address.port;

  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  });

  return { baseUrl, transport, model, sim };
}

async function postJson(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function getJson(baseUrl: string, path: string) {
  const response = await fetch(baseUrl + path);
  return { status: response.status, body: (await response.json()) as any };
}

/** 验收 10：统一响应信封，键集恰为 code / data / message */
function assertEnvelope(body: any, code: number) {
  assert.deepEqual(Object.keys(body).sort(), ['code', 'data', 'message']);
  assert.equal(body.code, code);
}

test('1/6 美国天气语义：只传 message，真实 Agent 调 get-forecast，200 信封回传播报文本', async (t) => {
  const answer =
    '纽约今天基本适合通勤，5℃有小雨。出门必备：手机、乘车码、证件、钥匙、雨伞';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [
      toolUse('get-forecast', { latitude: 40.71, longitude: -74.01 }),
      text(answer),
    ],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '  纽约今天适合坐地铁通勤吗  ',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    code: 200,
    data: { answer, citations: [] },
    message: '',
  });
  assert.deepEqual(
    transport.callToolCalls[0],
    { name: 'fengyunsanguo_quiz_route', args: { text: '纽约今天适合坐地铁通勤吗' } }
  );
  assert.deepEqual(callsNamed(transport.callToolCalls, 'get-forecast'), [
    { name: 'get-forecast', args: { latitude: 40.71, longitude: -74.01 } },
  ]);
  // 问题原文 trim 后透传给模型，请求体不含任何路由字段
  assert.equal(lastMessage(model.calls[0]).content, '纽约今天适合坐地铁通勤吗');
  assert.deepEqual(model.calls[0].toolNames, UNIFIED_TOOL_NAMES);
});

test('1 多轮 tool-use：get-forecast 后 get-alerts 再出文本，调用顺序与参数完整透传', async (t) => {
  const answer =
    '纽约今天建议调整时间，5℃有大风预警。出门必备：手机、乘车码、证件、钥匙';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [
      toolUse('get-forecast', { latitude: 40.71, longitude: -74.01 }),
      toolUse('get-alerts', { state: 'NY' }),
      text(answer),
    ],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '纽约今天有预警吗，适合通勤吗',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer, citations: [] });
  assert.deepEqual(
    callsNamed(transport.callToolCalls, 'get-forecast').map((call) => call.name),
    ['get-forecast']
  );
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name).filter((name) => name !== 'fengyunsanguo_quiz_route'),
    ['get-forecast', 'get-alerts']
  );
  assert.equal(model.calls.length, 3);
});

test('2/6 无 domain 题库问法：L3 经 fengyunsanguo_quiz_route 未命中 → 模型自主调 fengyunsanguo_query，答案取题库原文', async (t) => {
  const { baseUrl, transport, model } = await startApp(t, {
    script: [toolUse('fengyunsanguo_query', { text: '夏侯的字是什么' }), text('元让')],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '夏侯的字是什么',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: '元让', citations: [] });
  assert.deepEqual(transport.callToolCalls[0], {
    name: 'fengyunsanguo_quiz_route',
    args: { text: '夏侯的字是什么' },
  });
  assert.deepEqual(callsNamed(transport.callToolCalls, 'fengyunsanguo_query'), [
    { name: 'fengyunsanguo_query', args: { text: '夏侯的字是什么' } },
  ]);
  // MCP 召回结果按「题干 → 答案」回填给模型，模型才有机会输出题库原文
  assert.ok(
    JSON.stringify(lastMessage(model.calls[1])).includes('夏侯惇的字是什么？ → 元让')
  );
});

test('3/6 题库未收录：fengyunsanguo_query 无候选，回答固定话术且不用题库外知识', async (t) => {
  const fixed = '题库未收录该题，请换个问法';
  const { baseUrl, transport, model } = await startApp(t, {
    questions: [],
    script: [
      toolUse('fengyunsanguo_query', { text: '司马懿的字是什么' }),
      text(fixed),
    ],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '司马懿的字是什么',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: fixed, citations: [] });
  assert.deepEqual(callsNamed(transport.callToolCalls, 'fengyunsanguo_query').length, 1);
  assert.ok(
    JSON.stringify(lastMessage(model.calls[1])).includes('未召回到任何候选题目')
  );
});

test('L3 识别失败（可选 server 异常）→ 不命中，自动路由照常，其余功能正常', async (t) => {
  const { baseUrl, transport } = await startApp(t, {
    failTools: ['fengyunsanguo_quiz_route'],
    script: [toolUse('fengyunsanguo_query', { text: '夏侯惇的字是什么？' }), text('元让')],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '夏侯惇的字是什么？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: '元让', citations: [] });
  assert.ok(
    callsNamed(transport.callToolCalls, 'fengyunsanguo_query').length === 1,
    'L3 失败后模型仍可自主调 fengyunsanguo_query'
  );
});

test('4/6 非美国天气：不调用任何工具，明确告知仅支持美国境内且不编造数据', async (t) => {
  const answer = '仅支持美国境内天气查询，无法提供北京的天气数据。';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text(answer)],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '北京今天天气怎么样',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer, citations: [] });
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name),
    [],
    'L2 关键词已锁定 weather，L3 题库识别不再调用（路由分层：L3 仅 auto 生效）'
  );
  assert.equal(model.calls.length, 1);
});

test('5/6 闲聊：不调用任何工具（仅 L3 识别），自由作答，不套天气与题库模板', async (t) => {
  const answer = '你好，我在，有什么可以帮你的？';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text(answer)],
  });

  const res = await postJson(baseUrl, '/api/chat', { message: '你好' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer, citations: [] });
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name),
    ['fengyunsanguo_quiz_route']
  );
  assert.equal(model.calls.length, 1);
  // 工具仍然可见（由模型自主决定不用），不是靠前端或 server 收窄能力
  assert.deepEqual(model.calls[0].toolNames, UNIFIED_TOOL_NAMES);
});

test('6 默认路径：天气、题库、兜底三种语义共用同一份统一提示词与同一份可见工具', async (t) => {
  const { baseUrl, model } = await startApp(t, {
    script: [
      toolUse('get-forecast', { latitude: 40.71, longitude: -74.01 }),
      text('纽约今天适合通勤，5℃。出门必备：手机、乘车码、证件、钥匙'),
      toolUse('fengyunsanguo_query', { text: '夏侯惇的字是什么？' }),
      text('元让'),
      text('你好，我在。'),
    ],
  });

  await postJson(baseUrl, '/api/chat', { message: '纽约今天天气' });
  await postJson(baseUrl, '/api/chat', { message: '夏侯惇的字是什么？' });
  await postJson(baseUrl, '/api/chat', { message: '你好' });

  assert.equal(model.calls.length, 5);
  const prompts = new Set(model.calls.map((call) => call.systemPrompt));
  assert.equal(prompts.size, 1);
  assert.equal(model.calls[0].systemPrompt, UNIFIED_SYSTEM_PROMPT);
  for (const call of model.calls) {
    assert.deepEqual(call.toolNames, UNIFIED_TOOL_NAMES);
  }
});

test('7 旧字段 scenario / service 一律 400，请求完全不触达 Agent 与工具', async (t) => {
  const { baseUrl, transport, model } = await startApp(t);

  const legacyOne = await postJson(baseUrl, '/api/chat', {
    message: '纽约天气',
    scenario: 'weather',
  });
  assert.equal(legacyOne.status, 400);
  assert.deepEqual(legacyOne.body, {
    code: 400,
    data: null,
    message: '请求体只支持 message、domain 字段，收到无效字段：scenario',
  });

  const legacyTwo = await postJson(baseUrl, '/api/chat', {
    message: '随机一题',
    scenario: 'sango',
    service: 'random',
  });
  assert.equal(legacyTwo.status, 400);
  assert.equal(
    legacyTwo.body.message,
    '请求体只支持 message、domain 字段，收到无效字段：scenario、service'
  );

  assert.equal(model.calls.length, 0);
  assert.deepEqual(transport.callToolCalls, []);
});

test('8 GET /api/tools：真实 Agent 上报 MCP 工具（含 fengyunsanguo_query），总台无本地工具', async (t) => {
  const { baseUrl, transport, model } = await startApp(t);

  const res = await getJson(baseUrl, '/api/tools');

  assert.equal(res.status, 200);
  assertEnvelope(res.body, 200);
  assert.deepEqual(
    res.body.data.tools.map((tool: any) => tool.name),
    UNIFIED_TOOL_NAMES
  );
  assert.deepEqual(res.body.data.tools[2], FENGYUNSANGUO_QUERY_TOOL);
  assert.equal(
    res.body.data.tools.length,
    UNIFIED_TOOL_NAMES.length,
    '总台无本地工具：上报列表与 MCP 工具集完全一致'
  );
  assert.equal(model.calls.length, 0);
  // 上报能力与模型可见能力同源：注入 tools 后不打 MCP
  assert.equal(transport.listToolsCount, 0);
});

test('9 POST /api/sango/random：出题、判对、判错、查答案、无会话，薄转发 fengyunsanguo_quiz_command，全程不调 Agent / LLM', async (t) => {
  const { baseUrl, transport, model, sim } = await startApp(t);
  const sessionId = 'sid-a003';

  const issue = await postJson(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId,
  });
  assert.equal(issue.status, 200);
  assertEnvelope(issue.body, 200);
  assert.match(issue.body.data.answer, /^题目：.+?\nA\. /);

  const current = sim.getCurrentQuestion(sessionId);
  assert.ok(current);
  const rightText = current.answer;
  const wrongText = Object.values(current.options).find(
    (option) => option !== rightText
  );

  const right = await postJson(baseUrl, '/api/sango/random', {
    message: rightText,
    sessionId,
  });
  assert.match(right.body.data.answer, /^答对了！正确答案：/);

  const wrong = await postJson(baseUrl, '/api/sango/random', {
    message: wrongText,
    sessionId,
  });
  assert.match(wrong.body.data.answer, /^答错了，正确答案：/);

  const reveal = await postJson(baseUrl, '/api/sango/random', {
    message: '答案',
    sessionId,
  });
  assert.match(reveal.body.data.answer, /^正确答案：/);

  const noSession = await postJson(baseUrl, '/api/sango/random', {
    message: '答案',
  });
  assert.equal(noSession.status, 200);
  assert.deepEqual(noSession.body.data, {
    answer: SANGO_NO_SESSION_PROMPT,
    citations: [],
  });

  assert.equal(model.calls.length, 0);
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name),
    Array(5).fill('fengyunsanguo_quiz_command')
  );
  assert.deepEqual(transport.callToolCalls[0]?.args, {
    message: '随机一题',
    sessionId,
  });
});

test('9 quiz 调用失败 → /api/sango/random 503，/api/chat 其余功能正常', async (t) => {
  const { baseUrl } = await startApp(t, {
    failTools: ['fengyunsanguo_quiz_command'],
    script: [text('你好，我在。')],
  });

  const random = await postJson(baseUrl, '/api/sango/random', {
    message: '随机一题',
    sessionId: 'sid',
  });
  assert.equal(random.status, 503);
  assert.deepEqual(random.body, {
    code: 503,
    data: null,
    message: '工具服务暂不可用，请稍后重试',
  });

  const chat = await postJson(baseUrl, '/api/chat', { message: '你好' });
  assert.equal(chat.status, 200);
});

test('10 所有端点均为 { code, data, message } 信封：成功 data 有值，失败 data 为 null', async (t) => {
  const { baseUrl } = await startApp(t, { script: [text('你好，我在。')] });

  const health = await getJson(baseUrl, '/health');
  assert.equal(health.status, 200);
  assertEnvelope(health.body, 200);
  assert.deepEqual(health.body.data, {
    status: 'ok',
    service: 'mcp-orchestrator',
  });
  assert.equal(health.body.message, '');

  const tools = await getJson(baseUrl, '/api/tools');
  assertEnvelope(tools.body, 200);
  assert.ok(Array.isArray(tools.body.data.tools));

  const chat = await postJson(baseUrl, '/api/chat', { message: '你好' });
  assertEnvelope(chat.body, 200);
  assert.equal(chat.body.message, '');
  assert.deepEqual(chat.body.data, { answer: '你好，我在。', citations: [] });

  const random = await postJson(baseUrl, '/api/sango/random', {
    message: '答案',
  });
  assertEnvelope(random.body, 200);
  assert.equal(random.body.data.answer, SANGO_NO_SESSION_PROMPT);

  const empty = await postJson(baseUrl, '/api/chat', { message: '   ' });
  assert.equal(empty.status, 400);
  assertEnvelope(empty.body, 400);
  assert.equal(empty.body.data, null);

  const tooLong = await postJson(baseUrl, '/api/chat', {
    message: '天'.repeat(301),
  });
  assert.equal(tooLong.status, 413);
  assertEnvelope(tooLong.body, 413);
  assert.equal(tooLong.body.data, null);
});

test('503：MCP 工具失败经真实 Agent 包装为 ToolExecutionError，判工具服务暂不可用', async (t) => {
  const { baseUrl } = await startApp(t, {
    script: [toolUse('get-forecast', { latitude: 40.71, longitude: -74.01 })],
    callToolError: new Error('MCP stdio closed'),
  });

  const res = await postJson(baseUrl, '/api/chat', { message: '纽约天气' });

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {
    code: 503,
    data: null,
    message: '工具服务暂不可用，请稍后重试',
  });
});

test('503：fengyunsanguo_query 失败同样判工具服务暂不可用（MCP 链路统一语义）', async (t) => {
  const { baseUrl } = await startApp(t, {
    script: [toolUse('fengyunsanguo_query', { text: '夏侯惇的字是什么？' })],
    failTools: ['fengyunsanguo_query'],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '夏侯惇的字是什么？',
  });

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {
    code: 503,
    data: null,
    message: '工具服务暂不可用，请稍后重试',
  });
});
