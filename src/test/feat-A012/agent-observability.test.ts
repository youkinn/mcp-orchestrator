// feat-A012 编排侧埋点测试（测试即文档）：
// 覆盖 attempt 两轮各自成行 / 单轮 attempt=1 / route_source 五分支各一例
// （label / keyword / vector / classify / free）/ input_breakdown 分段与折算口径 /
// max_tokens 落库 / reasoning_tokens 的 null 语义。
// 走真实 Agent.callModel 代码路径（fake OpenAI 客户端），日志经 runWithTraceId 落临时库；
// route_source 经 processQueryData 真实组合 + reportRouteSource 回填。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  FENGYUNSANGUO_QUERY_TOOL,
} from '../../agent.js';
import { runWithTraceId } from '../../trace.js';
import { getLogStore, type LogStore } from '../../storage/logs.js';
import { MCPTransport } from '../../transport.js';
import type {
  LLMConfig,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from '../../types.js';

const cwd = process.cwd();
let store: LogStore;
let dir: string;

/** 文件级隔离：把共享日志库（getLogStore）重定向到临时目录，不污染工作树 data/logs.db */
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'a012-agent-obs-'));
  process.chdir(dir);
  store = getLogStore();
});

after(() => {
  store.close();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(): LLMConfig {
  return {
    provider: 'deepseek',
    model: 'mock-model',
    apiKey: 'mock-key',
    apiBaseUrl: 'https://mock.local',
  };
}

class MockTransport extends MCPTransport {
  constructor(private tools: MCPToolDefinition[] = []) {
    super('mock-server');
  }
  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }
  override async callTool(
    name: string,
    _args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `transport:${name}` }] };
  }
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }] };
}

/** 脚本化 fake OpenAI：按调用顺序返回预设响应，并捕获每次请求体 */
function scriptedOpenAI(
  script: Array<{
    content: string | null;
    finishReason: string;
    usage?: unknown;
  }>
): { openai: unknown; requests: any[] } {
  const requests: any[] = [];
  const openai = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          const step = script[requests.length - 1] ?? script[script.length - 1];
          return {
            choices: [
              {
                message: { role: 'assistant', content: step.content },
                finish_reason: step.finishReason,
              },
            ],
            usage: step.usage ?? { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  };
  return { openai, requests };
}

function injectOpenAI(agent: Agent, openai: unknown): void {
  (agent as unknown as { openai: unknown }).openai = openai;
}

type CallModelCaller = {
  callModel(
    messages: unknown[],
    tools: unknown[],
    stage: string
  ): Promise<unknown>;
};

/** 走真实 callModel 代码路径（fake OpenAI），traceId 上下文落库 */
async function runCallModel(
  trace: string,
  agent: Agent,
  messages: unknown[]
): Promise<{ detail: NonNullable<ReturnType<LogStore['queryDetail']>> }> {
  const caller = agent as unknown as CallModelCaller;
  store.ensureSkeleton('chat', trace, '埋点用例', null, Date.now());
  await runWithTraceId(trace, () =>
    caller.callModel(messages, [], 'generation')
  );
  store.flush();
  return { detail: store.queryDetail(trace)! };
}

/** 走真实 processQueryData 组合 + reportRouteSource 回填 */
async function runProcess(
  trace: string,
  agent: Agent,
  query: string,
  domain?: string
): Promise<{ detail: NonNullable<ReturnType<LogStore['queryDetail']>> }> {
  store.ensureSkeleton('chat', trace, query, domain ?? null, Date.now());
  await runWithTraceId(trace, () => agent.processQueryData(query, domain));
  store.flush();
  return { detail: store.queryDetail(trace)! };
}

test('attempt：首轮空答案 → failed attempt=1 + 重试成功 attempt=2 各自成行（首轮失败行不被覆盖）', async () => {
  const { openai } = scriptedOpenAI([
    { content: '', finishReason: 'length' },
    { content: '你好呀', finishReason: 'stop' },
  ]);
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(agent, openai);
  const { detail } = await runCallModel(
    '9f7c0000-0000-4000-8000-0000000000a1',
    agent,
    [{ role: 'user', content: '虎牢关之战' }]
  );

  assert.equal(detail.llmCalls.length, 2, '首轮 + 重试轮各记一条');
  assert.equal(detail.llmCalls[0]!.attempt, 1, '首轮失败行 attempt=1');
  assert.equal(detail.llmCalls[0]!.status, 'failed', '首轮空答案行状态 failed');
  assert.equal(detail.llmCalls[1]!.attempt, 2, '重试成功行 attempt=2');
  assert.equal(detail.llmCalls[1]!.status, 'success', '重试行状态 success');
});

test('attempt：无重试成功仅一条 attempt=1', async () => {
  const { openai } = scriptedOpenAI([
    { content: '正常回复', finishReason: 'stop' },
  ]);
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(agent, openai);
  const { detail } = await runCallModel(
    '9f7c0000-0000-4000-8000-0000000000a2',
    agent,
    [{ role: 'user', content: '你好' }]
  );

  assert.equal(detail.llmCalls.length, 1, '无重试用例仅一条');
  assert.equal(detail.llmCalls[0]!.attempt, 1);
  assert.equal(detail.llmCalls[0]!.status, 'success');
});

test('reasoningTokens：provider 返回 completion_tokens_details.reasoning_tokens → 落库数值；未返回 → null', async () => {
  const { openai: hitOpenai } = scriptedOpenAI([
    {
      content: '你好',
      finishReason: 'stop',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 42 },
      },
    },
  ]);
  const hitAgent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(hitAgent, hitOpenai);
  const { detail: hitDetail } = await runCallModel(
    '9f7c0000-0000-4000-8000-0000000000b1',
    hitAgent,
    [{ role: 'user', content: '你好' }]
  );
  assert.equal(
    hitDetail.llmCalls[0]!.reasoningTokens,
    42,
    'provider 返回 reasoning_tokens 时落库数值'
  );

  const { openai: noHitOpenai } = scriptedOpenAI([
    {
      content: '你好',
      finishReason: 'stop',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
  ]);
  const noHitAgent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(noHitAgent, noHitOpenai);
  const { detail: noHitDetail } = await runCallModel(
    '9f7c0000-0000-4000-8000-0000000000b2',
    noHitAgent,
    [{ role: 'user', content: '你好' }]
  );
  assert.equal(
    noHitDetail.llmCalls[0]!.reasoningTokens,
    null,
    'provider 未返回 completion_tokens_details → null'
  );
});

test('inputBreakdown：system=首条 system / user=user / injected=其余 system；CJK 1 token/字、其余 1 token/4 字符、四舍五入', async () => {
  const { openai } = scriptedOpenAI([
    { content: '回复', finishReason: 'stop' },
  ]);
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(agent, openai);
  const { detail } = await runCallModel(
    '9f7c0000-0000-4000-8000-0000000000c1',
    agent,
    [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '你好，abcde' },
      { role: 'system', content: '注入' },
    ]
  );

  // 折算口径：系统提示=4 CJK→4；你好，=3 CJK + abcde=5 其余→round(3+5/4)=4；注入=2 CJK→2
  assert.deepEqual(detail.llmCalls[0]!.inputBreakdown, {
    system: 4,
    user: 4,
    injected: 2,
    history: 0,
    tools: 0,
  });
});

test('maxTokens：落库 = 调用点 params.max_tokens 原值（MAX_TOKENS=1000）', async () => {
  const { openai, requests } = scriptedOpenAI([
    { content: '你好', finishReason: 'stop' },
  ]);
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(agent, openai);
  const { detail } = await runCallModel(
    '9f7c0000-0000-4000-8000-0000000000d1',
    agent,
    [{ role: 'user', content: '你好' }]
  );

  assert.equal(requests[0]!.max_tokens, 1000, '请求参数与落库同源');
  assert.equal(detail.llmCalls[0]!.maxTokens, 1000, '落库 max_tokens=1000');
});

test('route_source：L1 domain 参数命中 → label', async () => {
  const agent = new Agent(new MockTransport(), makeConfig(), {
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: 'text', text: JSON.stringify([{ text: '云长提刀出阵，斩华雄于帐前！' }]) }],
      }),
    },
    modelCaller: async () => textResponse('这是测试回复。'),
  });
  const { detail } = await runProcess(
    '9f7c0000-0000-4000-8000-0000000000e1',
    agent,
    '谁斩了华雄？',
    'sango-novel'
  );
  assert.equal(detail.log.routeSource, 'label');
});

test('route_source：L2 关键词硬匹配命中 → keyword', async () => {
  const agent = new Agent(new MockTransport(), makeConfig(), {
    localTools: {
      [FENGYUNSANGUO_QUERY_TOOL]: async () => ({
        content: [{ type: 'text', text: '1. 题库候选' }],
      }),
    },
    modelCaller: async () => textResponse('元让'),
  });
  const { detail } = await runProcess(
    '9f7c0000-0000-4000-8000-0000000000e2',
    agent,
    '风云三国答题'
  );
  assert.equal(detail.log.routeSource, 'keyword');
});

test('route_source：auto + L3 向量命中 → vector', async () => {
  const agent = new Agent(new MockTransport(), makeConfig(), {
    fengyunsanguoVectorMatcher: async () => true,
    localTools: {
      [FENGYUNSANGUO_QUERY_TOOL]: async () => ({
        content: [{ type: 'text', text: '1. 题库候选' }],
      }),
    },
    modelCaller: async () => textResponse('元让'),
  });
  const { detail } = await runProcess(
    '9f7c0000-0000-4000-8000-0000000000e3',
    agent,
    '夏侯惇的字是什么？'
  );
  assert.equal(detail.log.routeSource, 'vector');
});

test('route_source：auto 分类轮编号 2 → classify', async () => {
  let callCount = 0;
  const agent = new Agent(new MockTransport(), makeConfig(), {
    localTools: {
      [FENGYUNSANGUO_QUERY_TOOL]: async () => ({
        content: [{ type: 'text', text: '1. 题库候选' }],
      }),
    },
    modelCaller: async () => {
      callCount += 1;
      return callCount === 1 ? textResponse('2') : textResponse('元让');
    },
  });
  const { detail } = await runProcess(
    '9f7c0000-0000-4000-8000-0000000000e4',
    agent,
    '夏侯惇的字是什么？'
  );
  assert.equal(detail.log.routeSource, 'classify');
});

test('route_source：auto 分类轮编号 99 → free', async () => {
  let callCount = 0;
  const agent = new Agent(new MockTransport(), makeConfig(), {
    modelCaller: async () => {
      callCount += 1;
      return callCount === 1 ? textResponse('99') : textResponse('自由回答');
    },
  });
  const { detail } = await runProcess(
    '9f7c0000-0000-4000-8000-0000000000e5',
    agent,
    '今天天气怎么样'
  );
  assert.equal(detail.log.routeSource, 'free');
});
