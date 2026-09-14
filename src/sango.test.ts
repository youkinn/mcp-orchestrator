import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Agent } from './agent.js';
import { MCPTransport } from './transport.js';
import {
  SangoService,
  normalize,
  SANGO_NO_SESSION_PROMPT,
  type SangoOptionKey,
  type SangoQuestion,
} from './sango.js';
import { createServer } from './server.js';
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from './types.js';

const XIAHOU_DUN_QUESTION: SangoQuestion = {
  question: '夏侯惇的字是什么？',
  options: { A: '元让', B: '妙才', C: '子龙', D: '云长' },
  answer: '元让',
};

const LV_BU_QUESTION: SangoQuestion = {
  question: '吕布的字是什么？',
  options: { A: '奉孝', B: '奉先', C: '公瑾', D: '伯符' },
  answer: '奉先',
};

const VALID_ENTRIES = [XIAHOU_DUN_QUESTION, LV_BU_QUESTION];

const BAD_ENTRIES: unknown[] = [
  { question: '缺选项', options: { A: '甲', B: '乙' }, answer: '甲' },
  {
    question: '答案不在选项中',
    options: { A: '甲', B: '乙', C: '丙', D: '丁' },
    answer: '戊',
  },
  {
    question: '',
    options: { A: '甲', B: '乙', C: '丙', D: '丁' },
    answer: '甲',
  },
  '不是对象',
  { question: '无 options', answer: '甲' },
];

function writeQuestionFile(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sango-test-'));
  const file = join(dir, 'questions.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  return file;
}

function cleanupQuestionFile(file: string): void {
  rmSync(dirname(file), { recursive: true, force: true });
}

function makeFixtureService(
  t: TestContext,
  entries: unknown[] = VALID_ENTRIES
): SangoService {
  const file = writeQuestionFile(entries);
  t.after(() => cleanupQuestionFile(file));
  return new SangoService({ questionFile: file });
}
test('load: 合法题加载，坏行跳过并告警，服务不挂', (t) => {
  const file = writeQuestionFile([...VALID_ENTRIES, ...BAD_ENTRIES]);
  t.after(() => cleanupQuestionFile(file));
  const warned = t.mock.method(console, 'warn', () => undefined);

  const service = new SangoService({ questionFile: file });

  assert.equal(service.questionCount, 2);
  assert.ok(warned.mock.calls.length >= BAD_ENTRIES.length);
  assert.equal(service.search('夏侯惇的字是什么？')?.answer, '元让');
});

test('load: 题库文件缺失时为空题库并告警，不抛异常', (t) => {
  const missingFile = join(tmpdir(), `sango-missing-${Date.now()}.json`);
  const warned = t.mock.method(console, 'warn', () => undefined);

  const service = new SangoService({ questionFile: missingFile });

  assert.equal(service.questionCount, 0);
  assert.ok(warned.mock.calls.length > 0);
});

test('load: SANGO_QUESTION_FILE 环境变量生效', (t) => {
  const file = writeQuestionFile(VALID_ENTRIES);
  t.after(() => cleanupQuestionFile(file));
  const previous = process.env.SANGO_QUESTION_FILE;
  process.env.SANGO_QUESTION_FILE = file;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.SANGO_QUESTION_FILE;
    } else {
      process.env.SANGO_QUESTION_FILE = previous;
    }
  });

  const service = new SangoService();
  assert.equal(service.questionCount, 2);
});

test('normalize: 全角→半角、小写、去空白与标点', () => {
  assert.equal(normalize('Ａ．ＢＣ！'), 'abc');
  assert.equal(normalize(' 元让，。！ '), '元让');
  assert.equal(normalize('这题选什么？'), '这题选什么');
  assert.equal(normalize('《孟德新书》'), '孟德新书');
});
test('search: 归一化精确优先，包含兜底，未命中返回 null', (t) => {
  const service = makeFixtureService(t);

  assert.equal(service.search('夏侯惇的字是什么？')?.answer, '元让');
  assert.equal(service.search(' 夏侯惇的字是什么 ')?.answer, '元让');
  assert.equal(service.search('夏侯惇的字是什么？！')?.answer, '元让');
  assert.equal(service.search('吕布的字')?.answer, '奉先');
  assert.equal(service.search('完全不存在的问题'), null);
  assert.equal(service.search(''), null);
});

test('judge: 选项字母（半角/全角/大小写）判题', (t) => {
  const service = makeFixtureService(t);
  const question = XIAHOU_DUN_QUESTION;

  assert.deepEqual(service.judge('A', question), {
    correct: true,
    answer: { key: 'A', text: '元让' },
  });
  assert.deepEqual(service.judge('a', question), {
    correct: true,
    answer: { key: 'A', text: '元让' },
  });
  assert.deepEqual(service.judge('ａ', question), {
    correct: true,
    answer: { key: 'A', text: '元让' },
  });
  const wrong = service.judge('C', question);
  assert.equal(wrong?.correct, false);
  assert.deepEqual(wrong?.answer, { key: 'A', text: '元让' });
});

test('judge: 选项文本（含空白/标点）判题，无法识别返回 null', (t) => {
  const service = makeFixtureService(t);
  const question = XIAHOU_DUN_QUESTION;

  assert.equal(service.judge('元让', question)?.correct, true);
  assert.equal(service.judge(' 元让 ', question)?.correct, true);
  assert.equal(service.judge('元让！', question)?.correct, true);
  assert.equal(service.judge('妙才', question)?.correct, false);
  assert.equal(service.judge('不存在的答案', question), null);
});
test('randomQuestion: 出题只含题干与 A-D 选项，不含答案标注', (t) => {
  const service = makeFixtureService(t);
  for (let i = 0; i < 20; i++) {
    const out = service.handleRandom('随机一题', `sid-${i}`);
    assert.match(out, /^题目：.+\nA\. .+\nB\. .+\nC\. .+\nD\. .+$/);
    assert.ok(!out.includes('正确答案'), '出题不应包含答案标注');
  }
  assert.match(service.handleRandom('来一题', 'sid-alias'), /^题目：/);
});

test('random 指令流：随机一题 → 判对 → 判错附正确答案 → 答案指令', (t) => {
  const service = makeFixtureService(t);
  const out = service.handleRandom('随机一题', 'sid-flow');
  assert.match(out, /^题目：/);

  const current = service.getCurrentQuestion('sid-flow');
  assert.ok(current);
  const answer = service.answerOf(current!);

  assert.equal(
    service.handleRandom(answer.key, 'sid-flow'),
    `答对了！正确答案：${answer.text}（${answer.key}）`
  );

  const wrongKey = (['A', 'B', 'C', 'D'] as SangoOptionKey[]).find(
    (key) => key !== answer.key
  )!;
  assert.equal(
    service.handleRandom(current!.options[wrongKey], 'sid-flow'),
    `答错了，正确答案：${answer.text}（${answer.key}）`
  );

  assert.equal(
    service.handleRandom('答案', 'sid-flow'),
    `正确答案：${answer.text}（${answer.key}）`
  );
  assert.equal(
    service.handleRandom('这题选什么？', 'sid-flow'),
    `正确答案：${answer.text}（${answer.key}）`
  );
});

test('会话: 无有效会话时判题与查答案返回提示', (t) => {
  const service = makeFixtureService(t);

  assert.equal(service.handleRandom('答案'), SANGO_NO_SESSION_PROMPT);
  assert.equal(service.handleRandom('A'), SANGO_NO_SESSION_PROMPT);
  assert.equal(service.handleRandom('这题选什么'), SANGO_NO_SESSION_PROMPT);
});

test('会话 TTL: 过期后会话失效，判题与查答案返回无会话提示', async (t) => {
  const file = writeQuestionFile(VALID_ENTRIES);
  t.after(() => cleanupQuestionFile(file));
  const service = new SangoService({ questionFile: file, ttlMs: 20 });

  const out = service.handleRandom('随机一题', 'sid-ttl');
  assert.match(out, /^题目：/);
  assert.ok(service.getCurrentQuestion('sid-ttl'));

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(service.getCurrentQuestion('sid-ttl'), null);
  assert.equal(service.handleRandom('答案', 'sid-ttl'), SANGO_NO_SESSION_PROMPT);
  assert.equal(service.handleRandom('A', 'sid-ttl'), SANGO_NO_SESSION_PROMPT);
});
function makeConfig(provider: LLMProvider = 'deepseek'): LLMConfig {
  return {
    provider,
    model: 'mock-model',
    apiKey: 'mock-key',
    apiBaseUrl: 'https://mock.local',
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }] };
}

/** 记录调用、只回文本、不发起真实 MCP 连接的 Transport（同 agent.test.ts 思路） */
class MockTransport extends MCPTransport {
  constructor(private tools: MCPToolDefinition[] = []) {
    super('mock-server');
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `transport-result:${name}` }] };
  }
}

interface StartServerOptions {
  generalError?: Error;
  weatherError?: Error;
}

async function startChatServer(
  t: TestContext,
  options: StartServerOptions = {}
): Promise<{ baseUrl: string; seen: string[] }> {
  const seen: string[] = [];
  const config = makeConfig();
  const transport = new MockTransport([
    { name: 'get_weather', description: '查询美国城市天气', inputSchema: {} },
  ]);

  const general = new Agent(transport, config, {
    tools: [],
    modelCaller: async () => {
      seen.push('general');
      if (options.generalError) {
        throw options.generalError;
      }
      return textResponse('general 回复');
    },
  });

  const weather = new Agent(transport, config, {
    modelCaller: async () => {
      seen.push('weather');
      if (options.weatherError) {
        throw options.weatherError;
      }
      return textResponse('weather 回复');
    },
  });

  const sangoKnowledge = new Agent(transport, config, {
    systemPrompt: '你是风云三国知识问答助手',
    tools: [
      {
        name: 'sango_query',
        description: '风云三国知识问答：查题库',
        inputSchema: {},
      },
    ],
    localTools: {
      sango_query: async () => ({ content: [{ type: 'text', text: '命中' }] }),
    },
    modelCaller: async () => {
      seen.push('knowledge');
      return textResponse('knowledge 回复');
    },
  });

  const sangoService = makeFixtureService(t);
  const app = createServer({ general, weather, sangoKnowledge }, sangoService, {
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
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

async function postChat(
  baseUrl: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
test('server: general 场景走 general Agent（缺省 scenario，无工具）', async (t) => {
  const { baseUrl, seen } = await startChatServer(t);

  const res = await postChat(baseUrl, { message: '你好吗' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    code: 200,
    data: { answer: 'general 回复' },
    message: '',
  });
  assert.deepEqual(seen, ['general']);
});

test('server: weather 场景走 weather Agent（MCP 工具链路）', async (t) => {
  const { baseUrl, seen } = await startChatServer(t);

  const res = await postChat(baseUrl, {
    message: '纽约天气怎么样',
    scenario: 'weather',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.answer, 'weather 回复');
  assert.deepEqual(seen, ['weather']);
});

test('server: sango+knowledge 场景走 sangoKnowledge Agent（本地题库工具）', async (t) => {
  const { baseUrl, seen } = await startChatServer(t);

  const res = await postChat(baseUrl, {
    message: '夏侯惇的字是什么？',
    scenario: 'sango',
    service: 'knowledge',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.answer, 'knowledge 回复');
  assert.deepEqual(seen, ['knowledge']);
});

test('server: sango+random 场景走 SangoService 本地规则，不调用任何 Agent', async (t) => {
  const { baseUrl, seen } = await startChatServer(t);

  const issue = await postChat(baseUrl, {
    message: '随机一题',
    scenario: 'sango',
    service: 'random',
    sessionId: 'sid-http',
  });
  assert.equal(issue.status, 200);
  assert.match(issue.body.data.answer, /^题目：/);

  const reveal = await postChat(baseUrl, {
    message: '答案',
    scenario: 'sango',
    service: 'random',
    sessionId: 'sid-http',
  });
  assert.equal(reveal.status, 200);
  assert.match(reveal.body.data.answer, /^正确答案：.+（[ABCD]）$/);

  assert.deepEqual(seen, []);
});
test('server: 校验——空消息 400、超长 413、非法 scenario 400、sango 缺/错 service 400', async (t) => {
  const { baseUrl } = await startChatServer(t);

  const empty = await postChat(baseUrl, { message: '   ' });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, {
    code: 400,
    data: null,
    message: 'message 不能为空',
  });

  const long = await postChat(baseUrl, { message: 'a'.repeat(301) });
  assert.equal(long.status, 413);
  assert.deepEqual(long.body, {
    code: 413,
    data: null,
    message: '消息不能超过 300 字符',
  });

  const badScenario = await postChat(baseUrl, {
    message: '你好',
    scenario: 'travel',
  });
  assert.equal(badScenario.status, 400);
  assert.deepEqual(badScenario.body, {
    code: 400,
    data: null,
    message: 'scenario 不合法',
  });

  const missingService = await postChat(baseUrl, {
    message: '你好',
    scenario: 'sango',
  });
  assert.equal(missingService.status, 400);
  assert.deepEqual(missingService.body, {
    code: 400,
    data: null,
    message: 'service 不合法',
  });

  const badService = await postChat(baseUrl, {
    message: '你好',
    scenario: 'sango',
    service: 'quiz',
  });
  assert.equal(badService.status, 400);
  assert.deepEqual(badService.body, {
    code: 400,
    data: null,
    message: 'service 不合法',
  });
});

test('server: weather 链路失败返回 503 天气服务暂不可用', async (t) => {
  const { baseUrl } = await startChatServer(t, {
    weatherError: new Error('MCP down'),
  });

  const res = await postChat(baseUrl, { message: '纽约天气', scenario: 'weather' });

  assert.equal(res.status, 503);
  assert.deepEqual(res.body, {
    code: 503,
    data: null,
    message: '天气服务暂不可用',
  });
});

test('server: general 处理失败返回 500', async (t) => {
  const { baseUrl } = await startChatServer(t, {
    generalError: new Error('LLM down'),
  });

  const res = await postChat(baseUrl, { message: '你好' });

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, {
    code: 500,
    data: null,
    message: '处理请求失败，请稍后重试',
  });
});
test('server: /health 与 /api/tools 保持可用', async (t) => {
  const { baseUrl } = await startChatServer(t);

  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), {
    code: 200,
    data: { status: 'ok', service: 'mcp-orchestrator' },
    message: '',
  });

  const tools = await fetch(`${baseUrl}/api/tools`);
  const toolsBody = await tools.json();
  assert.equal(toolsBody.code, 200);
  assert.deepEqual(toolsBody.data.tools, [
    { name: 'get_weather', description: '查询美国城市天气', inputSchema: {} },
  ]);
});
