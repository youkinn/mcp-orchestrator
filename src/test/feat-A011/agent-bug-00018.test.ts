// bug-00018 空答案兜底与关思考口径测试（测试即文档）：
// ① 负向——模型返回空 content + finish_reason=length → 变参重试 1 次（temperature=0 且关思考），
//    仍空则报错（走既有 500 映射），日志不得记 success（空答案轮记 failed + error_message）；
// ② 口径——分类轮 / 兜底结论轮 / 有注入生成轮请求体带 thinking:{type:'disabled'}，
//    自由模式 99 生成轮不带（保留思考）。
// 走真实 Agent.callModel 代码路径（fake OpenAI 客户端捕获请求体），日志经 runWithTraceId 落临时库。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../../agent.js';
import { runWithTraceId } from '../../trace.js';
import { getLogStore, type LogStore } from '../../storage/logs.js';
import { MCPTransport } from '../../transport.js';
import { loadAliasTable } from '../../citation.js';
import type { LLMConfig, MCPToolDefinition, ToolCallResult } from '../../types.js';

const TRACE = '9f7c0000-0000-4000-8000-0000000000e1';
const cwd = process.cwd();

let store: LogStore;
let dir: string;

/** 文件级隔离：把共享日志库（getLogStore）重定向到临时目录，不污染工作树 data/logs.db */
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'a011-bug18-'));
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
    _name: string,
    _args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

const NOVEL_TOOL: MCPToolDefinition = {
  name: 'sango_novel_search',
  description: '《三国演义》原著检索',
  inputSchema: {},
};

const ALIAS_TABLE = loadAliasTable('a004-not-exist'); // stub 别名表（关羽=P002 等）

const RECALL_TEXT = JSON.stringify([
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

/** 脚本化 fake OpenAI：按调用顺序返回预设响应，并捕获每次请求体（含 thinking / temperature） */
function scriptedOpenAI(
  script: Array<{ content: string | null; finishReason: string }>
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
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  };
  return { openai, requests };
}

/** 注入 fake openai 的便捷方法 */
function injectOpenAI(agent: Agent, openai: unknown): void {
  (agent as unknown as { openai: unknown }).openai = openai;
}

test('① 负向：content 空 + finish_reason=length → 变参重试 1 次（temperature=0、关思考），仍空报错且日志不记 success', async () => {
  const { openai, requests } = scriptedOpenAI([
    { content: '', finishReason: 'length' },
    { content: '', finishReason: 'length' },
  ]);
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  injectOpenAI(agent, openai);
  const caller = agent as unknown as {
    callModel(messages: unknown[], tools: unknown[], stage: string): Promise<unknown>;
  };
  store.ensureSkeleton('chat', TRACE, '虎牢关之战', null, Date.now());

  await assert.rejects(
    runWithTraceId(TRACE, () =>
      caller.callModel([{ role: 'user', content: '虎牢关之战' }], [], 'generation')
    ),
    /空答案/,
    '仍为空应抛错（走既有 500 映射）'
  );

  assert.equal(requests.length, 2, '发生 1 次变参重试');
  assert.equal(requests[0].temperature, 0.7, '首轮保持默认温度');
  assert.equal(requests[0].thinking, undefined, '首轮未要求关思考时不带 thinking');
  assert.equal(requests[1].temperature, 0, '重试轮 temperature=0');
  assert.deepEqual(requests[1].thinking, { type: 'disabled' }, '重试轮关闭思考');

  store.flush();
  const detail = store.queryDetail(TRACE)!;
  assert.equal(detail.llmCalls.length, 2, '首轮 + 重试轮各记一条');
  assert.ok(
    detail.llmCalls.every((call) => call.status === 'failed'),
    '空答案轮不得记 success'
  );
  assert.ok(
    detail.llmCalls.every((call) => (call.errorMessage ?? '') !== ''),
    '失败轮带 error_message'
  );
});

test('② 口径：分类轮请求体带 thinking disabled，自由模式 99 生成轮不带', async () => {
  const { openai, requests } = scriptedOpenAI([
    { content: '99', finishReason: 'stop' },
    { content: '你好呀', finishReason: 'stop' },
  ]);
  const agent = new Agent(new MockTransport([]), makeConfig(), {});
  injectOpenAI(agent, openai);

  const data = await agent.processQueryData('你好');
  assert.equal(data.answer, '你好呀');
  assert.equal(requests.length, 2, '分类轮 + 生成轮');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' }, '分类轮关闭思考');
  assert.equal(requests[1].thinking, undefined, '自由模式 99 生成轮保留思考');
});

test('② 口径：域锁定快路径有注入生成轮请求体带 thinking disabled（单轮生成）', async () => {
  const { openai, requests } = scriptedOpenAI([
    { content: '这是测试回复。', finishReason: 'stop' },
  ]);
  const agent = new Agent(new MockTransport([]), makeConfig(), {
    tools: [NOVEL_TOOL],
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: 'text', text: RECALL_TEXT }],
      }),
    },
  });
  injectOpenAI(agent, openai);

  const data = await agent.processQueryData('谁斩了华雄？', 'sango-novel');
  assert.equal(data.answer, '这是测试回复。');
  assert.equal(requests.length, 1, '域锁定只走一轮生成');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' }, '有注入生成轮关闭思考');
});

test('② 口径：兜底结论轮请求体带 thinking disabled（生成轮校验失败触发）', async () => {
  const { openai, requests } = scriptedOpenAI([
    { content: '许褚斩华雄。', finishReason: 'stop' }, // 生成轮：许褚不在召回 → 校验失败
    { content: '按原文，斩华雄者系关羽', finishReason: 'stop' }, // 兜底结论轮
  ]);
  const agent = new Agent(new MockTransport([]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: 'text', text: RECALL_TEXT }],
      }),
    },
  });
  injectOpenAI(agent, openai);

  const data = await agent.processQueryData('谁斩了华雄？', 'sango-novel');
  assert.match(data.answer, /斩华雄者系关羽/, '兜底结论生效');
  assert.equal(requests.length, 2, '生成轮 + 兜底结论轮');
  assert.deepEqual(requests[0].thinking, { type: 'disabled' }, '有注入生成轮关闭思考');
  assert.deepEqual(requests[1].thinking, { type: 'disabled' }, '兜底结论轮关闭思考');
});