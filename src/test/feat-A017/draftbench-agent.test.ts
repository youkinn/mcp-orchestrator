// feat-A017 草稿台 Agent 管线测试（测试即文档，LLM 全部 mock）：
// 覆盖：清单 → buildInjectionView（请求级 topK/guarantee/budget 覆盖）→ 生成轮（temperature 覆盖 /
// 有注入即 disableThinking）；硬规则——不检索（toolCalls 恒空）、不查 / 不写语义缓存（连续零调用）；
// diff 三态：引用一致 / 拒答全缺失 / 兜底引用归属；空注入边界（guarantee=0 + 极小预算 → 无注入不关思考）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Agent,
  type DraftbenchChunk,
  type DraftbenchParams,
} from '../../agent.js';
import type { MCPTransport } from '../../transport.js';
import { runWithTraceId } from '../../trace.js';
import type {
  CacheManager,
} from '../../cache.js';
import type {
  LLMConfig,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from '../../types.js';

const LLM: LLMConfig = {
  provider: 'deepseek',
  model: 'mock-model',
  apiKey: 'mock-key',
  apiBaseUrl: 'http://mock',
};
const TRACE = '9f7c0000-0000-4000-8000-00000000000e';

const CHUNK_A: DraftbenchChunk = {
  chunkId: 'sanguo-yanyi:0005:c0001',
  text: '关羽引兵而走，败走麦城。',
  chapter: 5,
  title: '回目一',
};
const CHUNK_B: DraftbenchChunk = {
  chunkId: 'sanguo-yanyi:0005:c0002',
  text: '却说吕蒙白衣渡江，袭取荆州。',
  chapter: 5,
  title: '回目一',
};
const CHUNK_C: DraftbenchChunk = {
  chunkId: 'sanguo-yanyi:0005:c0003',
  text: '麦城守将王甫苦劝关羽回兵。',
  chapter: 5,
  title: '回目一',
};

/** 只报工具调用、不落检索（草稿台不检索，断言 toolCalls 恒空） */
class NoRetrievalTransport {
  toolCalls: string[] = [];

  async callTool(name: string): Promise<ToolCallResult> {
    this.toolCalls.push(name);
    return { content: [] };
  }
}

/** 缓存哨兵：lookup / record 任一被调用即测试失败 */
class SpyCacheManager {
  lookupCalls = 0;
  recordCalls = 0;

  async lookup(): Promise<null> {
    this.lookupCalls++;
    return null;
  }

  record(): void {
    this.recordCalls++;
  }
}

interface SpyCall {
  messages: Array<{ role: string; content: string }>;
  options: { temperature?: number; disableThinking?: boolean };
}

function spyCallModel(agent: Agent): {
  calls: SpyCall[];
  response: ModelResponse;
} {
  const spy = {
    calls: [] as SpyCall[],
    response: { content: [{ type: 'text' as const, text: '占位' }] },
  };
  (agent as unknown as { callModel: unknown }).callModel = async (
    messages: any[],
    _tools: MCPToolDefinition[],
    _stage: unknown,
    options?: Record<string, unknown>
  ): Promise<ModelResponse> => {
    spy.calls.push({
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      options: {
        temperature: options?.temperature as number | undefined,
        disableThinking: options?.disableThinking as boolean | undefined,
      },
    });
    return spy.response;
  };
  return spy;
}

function makeAgent(): {
  agent: Agent;
  transport: NoRetrievalTransport;
  cache: SpyCacheManager;
  spy: ReturnType<typeof spyCallModel>;
} {
  const transport = new NoRetrievalTransport();
  const cache = new SpyCacheManager();
  const agent = new Agent(transport as unknown as MCPTransport, LLM, {
    aliasTable: new Map([['关羽', 'guan-yu']]),
    cacheManager: cache as unknown as CacheManager,
    // 兜底结论轮注入：指针非法时走本地归纳，不损耗真正 LLM（保持「生成轮恰好一次」断言稳定）
    fallbackConcluder: async () => '关羽败走麦城，为吕蒙所擒。',
  });
  const spy = spyCallModel(agent);
  return { agent, transport, cache, spy };
}

const DEFAULT_PARAMS: DraftbenchParams = {
  temperature: 0.7,
  topK: 10,
  guarantee: 5,
  budget: 2000,
};

test('draftbench 管线：默认参数注入视图 + 生成轮覆盖 + 不检索 + 零缓存 + 一致 diff', async () => {
  const { agent, transport, cache, spy } = makeAgent();
  spy.response = {
    content: [{ type: 'text', text: '关羽引兵而走，败走麦城[片段1]' }],
  };
  const result = await runWithTraceId(TRACE, () =>
    agent.processDraftbench('关羽为何败走麦城？', [CHUNK_A, CHUNK_B, CHUNK_C], DEFAULT_PARAMS)
  );

  // 恰好一次生成轮：temperature 覆盖 + 有注入即关闭思考
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0];
  assert.equal(call.options.temperature, 0.7);
  assert.equal(call.options.disableThinking, true);
  const joined = call.messages.map((message) => message.content).join('\n');
  assert.ok(joined.includes('三国演义原著解读'), '应使用 sango-novel 域提示');
  assert.ok(joined.includes('[片段1]'), '注入视图应带服务端编号');
  assert.ok(joined.includes('[片段2]'));
  assert.ok(joined.includes('[片段3]'));

  // 硬规则：不检索（无任何工具调用）、不查 / 不写缓存
  assert.deepEqual(transport.toolCalls, []);
  assert.equal(cache.lookupCalls, 0);
  assert.equal(cache.recordCalls, 0);

  // diff：片段1 被引用 → 一致 [1]、缺失其余、无多余
  assert.equal(result.data.citations.length, 1);
  assert.deepEqual(result.diff, { consistent: [1], missing: [2, 3], extra: [] });
  assert.deepEqual(result.citedIndexes, [0]);
  assert.deepEqual(result.params, DEFAULT_PARAMS);
});

test('draftbench 管线：topK/guarantee/budget 请求级覆盖生效（topK=2 只注入前两段）', async () => {
  const { agent, spy } = makeAgent();
  spy.response = {
    content: [{ type: 'text', text: '关羽引兵而走，败走麦城[片段1]' }],
  };
  const params: DraftbenchParams = {
    temperature: 0.33,
    topK: 2,
    guarantee: 1,
    budget: 500,
  };
  await runWithTraceId(TRACE, () =>
    agent.processDraftbench('关羽为何败走麦城？', [CHUNK_A, CHUNK_B, CHUNK_C], params)
  );
  assert.equal(spy.calls.length, 1);
  const call = spy.calls[0];
  assert.equal(call.options.temperature, 0.33);
  assert.equal(call.options.disableThinking, true);
  const joined = call.messages.map((message) => message.content).join('\n');
  assert.ok(joined.includes('[片段1]'));
  assert.ok(joined.includes('[片段2]'));
  assert.ok(!joined.includes('[片段3]'), 'topK=2 截断后第 3 段不进注入视图');
  // 超出 topK 的清单条目不可被引用 → missing 应含 3
  const result = await runWithTraceId(TRACE, () =>
    agent.processDraftbench('关羽为何败走麦城？', [CHUNK_A, CHUNK_B, CHUNK_C], params)
  );
  assert.deepEqual(result.diff, { consistent: [1], missing: [2, 3], extra: [] });
});

test('draftbench 管线：guarantee=0 + 极小预算 → 无注入不关闭思考，温度覆盖仍生效', async () => {
  const { agent, spy } = makeAgent();
  spy.response = { content: [{ type: 'text', text: '无片段可用' }] };
  const params: DraftbenchParams = {
    temperature: 0.2,
    topK: 3,
    guarantee: 0,
    budget: 1,
  };
  const result = await runWithTraceId(TRACE, () =>
    agent.processDraftbench('关羽为何败走麦城？', [CHUNK_A, CHUNK_B, CHUNK_C], params)
  );
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].options.disableThinking, false);
  assert.equal(spy.calls[0].options.temperature, 0.2);
  assert.equal(spy.calls[0].messages.length, 2, '无注入时不追加注入消息');
  // 无注入 → 非原著形态答案原样返回，diff 空一致 / 全缺失
  assert.deepEqual(result.diff, { consistent: [], missing: [1, 2, 3], extra: [] });
});

test('draftbench 管线：拒答（演义中未涉及）→ consistent 空 / missing 全量 / extra 空', async () => {
  const { agent, spy } = makeAgent();
  spy.response = { content: [{ type: 'text', text: '演义中未涉及' }] };
  const result = await runWithTraceId(TRACE, () =>
    agent.processDraftbench('演义里没写的事', [CHUNK_A, CHUNK_B, CHUNK_C], DEFAULT_PARAMS)
  );
  assert.equal(result.data.answer, '演义中未涉及');
  assert.deepEqual(result.data.citations, []);
  assert.deepEqual(result.diff, { consistent: [], missing: [1, 2, 3], extra: [] });
  assert.deepEqual(result.citedIndexes, []);
});

test('draftbench 管线：指针非法 → 兜底结论轮（0 次 LLM 注入）引用归属清单首位', async () => {
  const { agent, spy } = makeAgent();
  spy.response = { content: [{ type: 'text', text: '此事不确切[片段99]' }] };
  const result = await runWithTraceId(TRACE, () =>
    agent.processDraftbench('关羽为何败走麦城？', [CHUNK_A], DEFAULT_PARAMS)
  );
  assert.equal(spy.calls.length, 1, '兜底结论轮应走注入器，不产生第二次 LLM 调用');
  // 兜底路径：buildFallback 只引恰一条片段（清单第 1 条）
  assert.equal(result.data.citations.length, 1);
  assert.equal(result.data.citations[0].text, CHUNK_A.text);
  assert.deepEqual(result.diff, { consistent: [1], missing: [], extra: [] });
  assert.deepEqual(result.citedIndexes, [0]);
});
