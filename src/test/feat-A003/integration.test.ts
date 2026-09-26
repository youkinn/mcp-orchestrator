import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  Agent,
  CLASSIFY_SYSTEM_PROMPT,
  FENGYUNSANGUO_DOMAIN_PROMPT,
  FREE_CHAT_SYSTEM_PROMPT,
  SANGO_NOVEL_DOMAIN_PROMPT,
} from '../../agent.js';
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
 * feat-A003 端到端集成用例（feat-A011 适配版）：真实 server.ts + 真实 Agent + 替身 MCP transport，
 * 只把 MCP server 与 LLM 换成替身（零网络、不起真实 MCP Server）。
 * feat-A011：auto 首轮改无 tools 轻量分类（classify）→ 服务端按编号预调工具并注入 → 生成轮不带工具；
 * 天气能力已下线；生成轮消息固定 [system 域提示 + user + system 注入]。
 */

const FORECAST_TOOL: MCPToolDefinition = {
  name: 'get-forecast',
  description: '获取美国境内某个经纬度位置的天气预报（数据源：美国国家气象局 NWS）。仅覆盖美国境内。',
  inputSchema: { type: 'object' },
};

const ALERTS_TOOL: MCPToolDefinition = {
  name: 'get-alerts',
  description: '获取美国某个州的当前天气预警（数据源：美国国家气象局 NWS）。仅覆盖美国境内。',
  inputSchema: { type: 'object' },
};

const FENGYUNSANGUO_QUERY_TOOL: MCPToolDefinition = {
  name: 'fengyunsanguo_query',
  description: '风云三国题库检索：参数 text 传用户原始问法，返回候选题目（题干 → 答案）',
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

const SANGO_NOVEL_TOOL: MCPToolDefinition = {
  name: 'sango_novel_search',
  description: '《三国演义》原著检索：参数 source=sanguo-yanyi、query=用户白话问句、limit 默认 5',
  inputSchema: { type: 'object' },
};

/** 全部 MCP 上报工具（含已下线的天气，供 /api/tools 白名单过滤验证） */
const MCP_TOOLS: MCPToolDefinition[] = [
  FORECAST_TOOL,
  ALERTS_TOOL,
  FENGYUNSANGUO_QUERY_TOOL,
  FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
  FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
  SANGO_NOVEL_TOOL,
];

/** 白名单后的模型可见工具（feat-A011：无天气） */
const VISIBLE_TOOL_NAMES = [
  'fengyunsanguo_query',
  'fengyunsanguo_quiz_command',
  'fengyunsanguo_quiz_route',
  'sango_novel_search',
].sort();

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

/** 原著召回出参（裸 JSON 数组，与 mcp-server 同构） */
const NOVEL_RECALL = JSON.stringify([
  {
    id: 'sanguo-yanyi:0005:c0001',
    text: '众皆大惊曰：“云长提刀出阵，斩华雄于帐前！”',
    chapter: 5,
    title: '发矫诏诸镇应曹公　破关兵三英战吕布',
    type: 'narration',
    segFrom: 4,
    segTo: 4,
    quoteBalanced: true,
    quotes: [{ offset: 7, len: 13 }],
  },
]);

/**
 * MCP transport 替身：模拟 weather + fengyunsanguo + sango 演义 三个 MCP server 的工具行为，
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
      case 'sango_novel_search':
        return textResult(NOVEL_RECALL);
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
  const sim = new FengyunsanguoSim(options.questions ?? QUESTIONS);
  const transport = new MockTransport(sim, {
    failTools: options.failTools,
    failToolsError: options.failToolsError,
    quizRouteHit: options.quizRouteHit,
  });
  transport.callToolError = options.callToolError ?? null;
  const model = new FakeModel(options.script ?? []);

  const agent = new Agent(transport, LLM_CONFIG, {
    tools: MCP_TOOLS,
    // 与 index.ts 同形：L3 无 domain 自动路由走 transport 的 fengyunsanguo_quiz_route
    fengyunsanguoVectorMatcher: (query) => transport.fengyunsanguo_quiz_route(query),
    modelCaller: model.respond,
  });

  const app = createServer(agent, transport, {
    port: 0,
    allowedOrigin: '*',
    logStore: createLogStore({ dbPath: ':memory:' }),
  });
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

test('域锁定快路径：domain=sango-novel 单轮生成（无 tools），注入片段恒在消息末尾', async (t) => {
  // 泛答不含人物名/指针：引用校验早退，单轮生成断言聚焦 A011 消息排布（引用行为见 agent-novel）
  const answer = '这是测试回复。';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text(answer)],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '谁斩了华雄？',
    domain: 'sango-novel',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    code: 200,
    data: { answer, citations: [] },
    message: '',
  });
  assert.equal(model.calls.length, 1, '域锁定只走一轮生成');
  assert.equal(model.calls[0].systemPrompt, SANGO_NOVEL_DOMAIN_PROMPT);
  assert.deepEqual(model.calls[0].toolNames, [], '快路径生成轮不携带工具定义');
  assert.equal(
    model.calls[0].messages[1].content,
    '谁斩了华雄？',
    '问题 trim 后原样透传'
  );
  assert.equal(model.calls[0].messages[2].role, 'system', '注入片段为第三条消息');
  assert.ok(
    model.calls[0].messages[2].content.includes('云长提刀出阵，斩华雄于帐前！'),
    '预调 sango_novel_search 后注入原文片段'
  );
  assert.equal(transport.callToolCalls.length, 1);
  assert.equal(transport.callToolCalls[0]!.name, 'sango_novel_search');
  assert.deepEqual(transport.callToolCalls[0]!.args, {
    source: 'sanguo-yanyi',
    query: '谁斩了华雄？',
    limit: 10,
  });
});

test('auto 分类轮：请求体无 tools；分类 1 → 预调 sango_novel_search 后生成轮也无 tools', async (t) => {
  // 泛答不含人物名/指针：引用校验早退，保持分类 + 生成两轮断言（引用行为见 agent-novel）
  const answer = '这是测试回复。';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text('1'), text(answer)],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '谁斩了华雄？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer, citations: [] });
  assert.equal(model.calls.length, 2, 'auto 未命中能力域分分类 + 生成两轮');
  assert.equal(model.calls[0].systemPrompt, CLASSIFY_SYSTEM_PROMPT);
  assert.deepEqual(model.calls[0].toolNames, [], '分类轮请求体无 tools');
  assert.equal(model.calls[0].messages.length, 2, '分类轮仅 system 分类提示 + user 问题');
  assert.equal(model.calls[1].systemPrompt, SANGO_NOVEL_DOMAIN_PROMPT);
  assert.deepEqual(model.calls[1].toolNames, [], '生成轮不携带工具定义');
  assert.ok(
    model.calls[1].messages[2].content.includes('云长提刀出阵'),
    '编号 1 预调 sango_novel_search 并注入'
  );
  assert.equal(transport.callToolCalls[0]!.name, 'fengyunsanguo_quiz_route', 'L3 先识别');
  assert.equal(transport.callToolCalls[1]!.name, 'sango_novel_search', '分类 1 服务端预调');
});

test('auto 分类 2 → 服务端预调 fengyunsanguo_query 注入题库候选，生成轮按域提示作答', async (t) => {
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text('2'), text('元让')],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '夏侯惇的字是什么？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: '元让', citations: [] });
  assert.equal(transport.callToolCalls.length, 2);
  assert.equal(transport.callToolCalls[0]!.name, 'fengyunsanguo_quiz_route');
  assert.deepEqual(transport.callToolCalls[1], {
    name: 'fengyunsanguo_query',
    args: { text: '夏侯惇的字是什么？' },
  });
  assert.equal(model.calls[1].systemPrompt, FENGYUNSANGUO_DOMAIN_PROMPT);
  assert.ok(
    JSON.stringify(model.calls[1].messages[2]).includes('夏侯惇的字是什么？ → 元让'),
    '题库候选注入生成轮末尾'
  );
});

test('题库未收录：分类 2 预调无候选 → 生成轮注入「未召回到任何候选题目」话术', async (t) => {
  const fixed = '题库未收录该题，请换个问法';
  const { baseUrl, model } = await startApp(t, {
    questions: [],
    script: [text('2'), text(fixed)],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '司马懿的字是什么？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: fixed, citations: [] });
  assert.ok(
    JSON.stringify(model.calls[1].messages[2]).includes('未召回到任何候选题目'),
    '无候选时注入固定话术'
  );
});

test('题库非空但候选与问题不相关 → 注入该候选且服务端原样返回未收录话术', async (t) => {
  const fixed = '题库未收录该题，请换个问法';
  const { baseUrl, model } = await startApp(t, {
    questions: [
      {
        question: '吕布的字是什么？',
        options: { A: '奉孝', B: '奉先', C: '公瑾', D: '伯符' },
        answer: '奉先',
      },
    ],
    script: [text('2'), text(fixed)],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '刘备的字是什么？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: fixed, citations: [] });
  assert.ok(
    JSON.stringify(model.calls[1].messages[2]).includes('吕布的字是什么？ → 奉先'),
    '有候选时注入该候选，走「有候选」分支'
  );
  assert.notEqual(res.body.data.answer, '奉先', '服务端未把答案替换为候选答案');
});

test('闲聊 auto → 分类 99：自由对话提示，无注入、无预调、无 tools', async (t) => {
  const answer = '你好，我在，有什么可以帮你的？';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text('99'), text(answer)],
  });

  const res = await postJson(baseUrl, '/api/chat', { message: '你好' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer, citations: [] });
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name),
    ['fengyunsanguo_quiz_route'],
    '99 不预调任何能力工具'
  );
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[1].systemPrompt, FREE_CHAT_SYSTEM_PROMPT);
  assert.equal(model.calls[1].messages.length, 2, '99 无注入段');
  assert.deepEqual(model.calls[1].toolNames, [], '生成轮无 tools');
});

test('天气能力下线：纽约天气语义不再调任何天气工具，走分类 99 自由对话', async (t) => {
  const answer = '我可以聊聊别的。';
  const { baseUrl, transport, model } = await startApp(t, {
    script: [text('99'), text(answer)],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '纽约今天适合坐地铁通勤吗？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer, citations: [] });
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name),
    ['fengyunsanguo_quiz_route'],
    '天气能力下线：不调用 get-forecast / get-alerts'
  );
  assert.equal(model.calls[1].systemPrompt, FREE_CHAT_SYSTEM_PROMPT);
});

test('L3 命中 → 题库快路径（不经分类轮）：quiz_route 识别命中后预调 fengyunsanguo_query 单轮生成', async (t) => {
  const { baseUrl, transport, model } = await startApp(t, {
    quizRouteHit: true,
    script: [text('元让')],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '夏侯惇的字是什么？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: '元让', citations: [] });
  assert.equal(model.calls.length, 1, 'L3 命中直接走题库快路径，不经分类轮');
  assert.equal(model.calls[0].systemPrompt, FENGYUNSANGUO_DOMAIN_PROMPT);
  assert.deepEqual(model.calls[0].toolNames, []);
  assert.deepEqual(
    transport.callToolCalls.map((call) => call.name),
    ['fengyunsanguo_quiz_route', 'fengyunsanguo_query']
  );
});

test('L3 识别失败（可选 server 异常）→ 按未命中处理，auto 分类照常', async (t) => {
  const { baseUrl, transport, model } = await startApp(t, {
    failTools: ['fengyunsanguo_quiz_route'],
    script: [text('2'), text('元让')],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '夏侯惇的字是什么？',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { answer: '元让', citations: [] });
  assert.equal(transport.callToolCalls.length, 2, 'quiz_route 失败被记录一次 + 分类 2 预调一次');
  assert.equal(transport.callToolCalls[0]!.name, 'fengyunsanguo_quiz_route', 'L3 识别失败调用被记录');
  assert.equal(transport.callToolCalls[1]!.name, 'fengyunsanguo_query', '分类 2 预调题库检索');
  assert.equal(model.calls.length, 2);
});

test('旧字段 scenario / service 一律 400，请求完全不触达 Agent 与工具', async (t) => {
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

test('GET /api/tools：白名单过滤后仅 4 个能力工具（无天气 / 无后台），description 为 §1.2 瘦身全文', async (t) => {
  const { baseUrl, transport, model } = await startApp(t);

  const res = await getJson(baseUrl, '/api/tools');

  assert.equal(res.status, 200);
  assertEnvelope(res.body, 200);
  const tools = res.body.data.tools as MCPToolDefinition[];
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    VISIBLE_TOOL_NAMES,
    '天气工具已下线，后台专用工具不在白名单'
  );
  assert.match(
    tools.find((tool) => tool.name === 'sango_novel_search')!.description,
    /检索《三国演义》原著原文/
  );
  assert.match(
    tools.find((tool) => tool.name === 'fengyunsanguo_query')!.description,
    /风云三国题库候选召回/
  );
  assert.equal(model.calls.length, 0);
  assert.equal(transport.listToolsCount, 0, '注入 tools 后 /api/tools 不打 MCP');
});

test('POST /api/sango/random：出题、判对、判错、查答案、无会话，薄转发 fengyunsanguo_quiz_command，全程不调 Agent / LLM', async (t) => {
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

test('quiz 调用失败 → /api/sango/random 503，/api/chat 其余功能正常', async (t) => {
  const { baseUrl } = await startApp(t, {
    failTools: ['fengyunsanguo_quiz_command'],
    script: [text('99'), text('你好，我在。')],
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
  const { baseUrl } = await startApp(t, {
    script: [text('99'), text('你好，我在。')],
  });

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

test('503：domain=sango-novel 预调 sango_novel_search 失败 → 判工具服务暂不可用', async (t) => {
  const { baseUrl } = await startApp(t, {
    callToolError: new Error('MCP stdio closed'),
    script: [],
  });

  const res = await postJson(baseUrl, '/api/chat', {
    message: '谁斩了华雄？',
    domain: 'sango-novel',
  });

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {
    code: 503,
    data: null,
    message: '工具服务暂不可用，请稍后重试',
  });
});

test('503：auto 分类 2 预调 fengyunsanguo_query 失败同样判工具服务暂不可用', async (t) => {
  const { baseUrl } = await startApp(t, {
    failTools: ['fengyunsanguo_query'],
    script: [text('2')],
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
