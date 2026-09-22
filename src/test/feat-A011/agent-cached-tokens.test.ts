
// feat-A011 cachedTokens 采集点测试（测试即文档）：走真实 Agent.callModel 代码路径，
// provider 返回 prompt_tokens_details.cached_tokens 时落库为数值；不返回（无 prompt_tokens_details）时
// 落库为 null（与 promptTokens 同口径）。通过 process.chdir 把共享日志库（getLogStore）隔离到临时目录，
// 不污染工作树 data/logs.db。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../../agent.js';
import { runWithTraceId } from '../../trace.js';
import { getLogStore, type LogStore } from '../../storage/logs.js';
import type { MCPTransport } from '../../transport.js';
import type { LLMConfig } from '../../types.js';

const TRACE_HIT = '9f7c0000-0000-4000-8000-0000000000c1';
const TRACE_NO_HIT = '9f7c0000-0000-4000-8000-0000000000d2';
const cwd = process.cwd();

let store: LogStore;
let dir: string;

/** 文件级隔离：把共享日志库（getLogStore）重定向到临时目录，不污染工作树 data/logs.db */
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'a011-agent-cache-'));
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

/** 假 OpenAI 客户端：chat.completions.create 返回带指定 usage 的响应（走真实 callModel 代码路径） */
function fakeOpenAI(usage: unknown): unknown {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [
            {
              message: { role: 'assistant', content: '你好' },
              finish_reason: 'stop',
            },
          ],
          usage,
        }),
      },
    },
  };
}

test('cachedTokens 采集：provider 返回 prompt_tokens_details.cached_tokens → 明细 cachedTokens 为数值', async () => {
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  (agent as unknown as { openai: unknown }).openai = fakeOpenAI({
    prompt_tokens: 1200,
    completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 800, reasoning_tokens: 0 },
  });
  const caller = agent as unknown as {
    callModel(messages: unknown[], tools: unknown[], stage: string): Promise<unknown>;
  };
  store.ensureSkeleton('chat', TRACE_HIT, '你好', null, Date.now());
  await runWithTraceId(TRACE_HIT, () => caller.callModel(
    [{ role: 'user', content: '你好' }],
    [],
    'generation'
  ));
  store.flush();

  const detail = store.queryDetail(TRACE_HIT)!;
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].cachedTokens, 800, 'cached_tokens 采集为数值');
  assert.equal(detail.llmCalls[0].promptTokens, 1200, '既有 promptTokens 采集不受影响');
  assert.equal(detail.llmCalls[0].completionTokens, 300);
  assert.equal(detail.llmCalls[0].status, 'success');
});

test('cachedTokens 采集：provider 未返回 prompt_tokens_details → 明细 cachedTokens 为 null（与 promptTokens 同口径）', async () => {
  const agent = new Agent({} as unknown as MCPTransport, makeConfig(), {});
  (agent as unknown as { openai: unknown }).openai = fakeOpenAI({
    prompt_tokens: 100,
    completion_tokens: 50,
  });
  const caller = agent as unknown as {
    callModel(messages: unknown[], tools: unknown[], stage: string): Promise<unknown>;
  };
  store.ensureSkeleton('chat', TRACE_NO_HIT, '你好', null, Date.now());
  await runWithTraceId(TRACE_NO_HIT, () => caller.callModel(
    [{ role: 'user', content: '你好' }],
    [],
    'generation'
  ));
  store.flush();

  const detail = store.queryDetail(TRACE_NO_HIT)!;
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].cachedTokens, null, '无 prompt_tokens_details → null');
  assert.equal(detail.llmCalls[0].promptTokens, 100);
});
