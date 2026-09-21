// feat-A009 编排侧诊断回填测试（story-A009-03，测试即文档）：
// 覆盖：候选进注入视图 → injected 标记 / 被引用 → cited 标记 / 未进 top-N 不标记 /
// 落库失败旁路不影响响应 / LLM 自主 tool-use 路径 injected=0（§3.2 预期）与 cited 正常回填 /
// 无诊断检索不登记不落库。全部用既有 FakeModel（modelCaller）+ mock transport，不调用任何 LLM。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../agent.js';
import { MCPTransport } from '../../transport.js';
import { loadAliasTable } from '../../citation.js';
import { runWithTraceId } from '../../trace.js';
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from '../../types.js';

const TRACE_ID = '9f7c0000-0000-4000-8000-000000000009';

/** Mock Transport：不发起真实 MCP 连接（本组用例全部走 localTools / options.tools） */
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
    return { content: [{ type: 'text', text: 'transport-result' }] };
  }
}

const NOVEL_TOOL: MCPToolDefinition = {
  name: 'sango_novel_search',
  description: '《三国演义》原著检索',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
    },
  },
};

function makeConfig(provider: LLMProvider = 'deepseek'): LLMConfig {
  return {
    provider,
    model: 'mock-model',
    apiKey: 'mock-key',
    apiBaseUrl: 'https://mock.local',
  };
}

/** 读取诊断 funnel 字段（funnel 为 unknown，安全访问） */
function funnelField(
  diag: Record<string, unknown>,
  key: 'injected' | 'cited'
): unknown {
  const funnel = diag.funnel as Record<string, unknown> | undefined;
  return funnel?.[key];
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }] };
}

function toolUseResponse(name: string, input: Record<string, unknown>): ModelResponse {
  return { content: [{ type: 'tool_use', id: 'call_1', name, input }] };
}

const ALIAS_TABLE = loadAliasTable('a009-not-exist'); // stub 别名表（关羽=P002、华雄=P013）

const F1_QUOTE = '云长提刀出阵，斩华雄于帐前！';
const F1_BODY = `众皆大惊曰：“${F1_QUOTE}”`;
const TITLE = '发矫诏诸镇应曹公　破关兵三英战吕布';
const CHUNK_1 = 'sanguo-yanyi:0005:c0001';
const CHUNK_2 = 'sanguo-yanyi:0005:c0002';
const CHUNK_3 = 'sanguo-yanyi:0005:c0003';
const CHUNK_4 = 'sanguo-yanyi:0005:c0004';

/** 工具出参条目（C4 定稿：裸 JSON 数组，逐条带 id=chunkId）：top-3 命中 */
const ENTRIES = [
  {
    id: CHUNK_1,
    text: F1_BODY,
    chapter: 5,
    title: TITLE,
    type: 'narration',
    segFrom: 4,
    segTo: 4,
    quoteBalanced: true,
    quotes: [{ offset: 7, len: F1_QUOTE.length }],
  },
  {
    id: CHUNK_2,
    text: '玄德与云长、翼德出帐，共议破关之策。',
    chapter: 5,
    title: TITLE,
    type: 'narration',
    quotes: [],
  },
  {
    id: CHUNK_3,
    text: '华雄连斩数将，诸侯莫敢当。',
    chapter: 5,
    title: TITLE,
    type: 'narration',
    quotes: [],
  },
];

function candidate(rank: number, chunkId: string): Record<string, unknown> {
  return {
    rank,
    chunkId,
    chapter: 5,
    title: TITLE,
    bm25: 12.34 - rank,
    cosine: 0.8 - rank * 0.01,
    labelHit: rank === 1,
    finalScore: 0.9 - rank * 0.01,
    sources: ['lexical', 'vector'],
    injected: null,
    cited: null,
  };
}

function makeDiagnostics(
  topN: number,
  candidates: Array<Record<string, unknown>>
): Record<string, unknown> {
  return {
    truncated: false,
    truncatedCount: 0,
    query: { raw: '谁斩了华雄？', normalized: '谁 斩 华雄', tokens: ['谁', '斩', '华雄'] },
    env: { vectorScheme: 'bge-m3', degradedBm25Only: false, corpusChunks: 2344, aliasCount: 87, vectorDim: 1024 },
    funnel: { corpusChunks: 2344, lexicalHits: 42, vectorTop50: 50, labelHits: 3, mergedCandidates: 45, topN, injected: null, cited: null },
    candidates,
    nextRank: null,
    deathIntent: { detected: false, pinned: false, chunkIds: [] },
  };
}

/** 带诊断 + retrievalSeq 的检索结果（localTools 注入，模拟 transport 透传后的形态） */
function recallResult(
  diagnostics: Record<string, unknown>,
  seq: number,
  entries: unknown[] = ENTRIES
): ToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(entries) }],
    _meta: { diagnostics, retrievalSeq: seq },
  };
}

test('① 快路径：候选进注入视图 → candidates[].injected=true + funnel.injected 计数', async () => {
  const recorded: Array<{ traceId: string; seq: number; diagnostics: Record<string, unknown> }> = [];
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () =>
        recallResult(makeDiagnostics(3, [candidate(1, CHUNK_1), candidate(2, CHUNK_2), candidate(3, CHUNK_3)]), 1),
    },
    fallbackConcluder: async () => '斩华雄者系关羽',
    modelCaller: async () => textResponse('斩华雄者。[片段3]'),
    retrievalDiagnosticsPersister: (traceId, seq, diagnostics) => {
      recorded.push({ traceId, seq, diagnostics: diagnostics as Record<string, unknown> });
    },
  });

  const data = await runWithTraceId(TRACE_ID, () =>
    agent.processQueryData('谁斩了华雄？', 'sango-novel')
  );
  assert.equal(recorded.length, 1, '本次请求登记一条检索诊断');
  assert.equal(recorded[0].traceId, TRACE_ID);
  assert.equal(recorded[0].seq, 1, 'seq=tool_call_logs 行号');

  const diag = recorded[0].diagnostics;
  assert.equal(funnelField(diag, 'injected'), 3, '3 条候选全部进注入视图（前 5 段整段保底）');
  const byChunk = new Map(
    (diag.candidates as Array<{ chunkId: string; injected: boolean; cited: boolean }>).map((c) => [c.chunkId, c])
  );
  for (const chunkId of [CHUNK_1, CHUNK_2, CHUNK_3]) {
    assert.equal(byChunk.get(chunkId)?.injected, true, `${chunkId} 进注入视图应被标记 injected`);
  }
  assert.equal(byChunk.get(CHUNK_2)?.cited, false, '未引用片段 cited=false（进视图但未引用）');
  assert.equal(data.citations.length, 1, '[片段3] 指针 → 恰一条 citation');
  assert.equal(data.citations[0].text, ENTRIES[2].text);
});

test('② 被引用片段 → candidates[].cited=true + funnel.cited 计数', async () => {
  const recorded: Array<{ diagnostics: Record<string, unknown> }> = [];
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () =>
        recallResult(makeDiagnostics(3, [candidate(1, CHUNK_1), candidate(2, CHUNK_2), candidate(3, CHUNK_3)]), 1),
    },
    fallbackConcluder: async () => '斩华雄者系关羽',
    modelCaller: async () => textResponse('按原文，斩华雄者系关羽。[Q1]'),
    retrievalDiagnosticsPersister: (_traceId, _seq, diagnostics) => {
      recorded.push({ diagnostics: diagnostics as Record<string, unknown> });
    },
  });

  await runWithTraceId(TRACE_ID, () => agent.processQueryData('谁斩了华雄？', 'sango-novel'));
  const diag = recorded[0].diagnostics;
  assert.equal(funnelField(diag, 'cited'), 1, 'funnel.cited=引用去重后的 chunk 数');
  const byChunk = new Map(
    (diag.candidates as Array<{ chunkId: string; cited: boolean }>).map((c) => [c.chunkId, c])
  );
  assert.equal(byChunk.get(CHUNK_1)?.cited, true, '被 [Q1] 引用的 c0001 应 cited=true');
  assert.equal(byChunk.get(CHUNK_2)?.cited, false, '未引用片段 cited=false');
  assert.equal(byChunk.get(CHUNK_3)?.cited, false);
});

test('③ 未进 top-N 候选不标记：诊断含第 4 条候选、工具仅返回 3 → injected/cited 均 false', async () => {
  const recorded: Array<{ diagnostics: Record<string, unknown> }> = [];
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () =>
        recallResult(
          makeDiagnostics(3, [
            candidate(1, CHUNK_1),
            candidate(2, CHUNK_2),
            candidate(3, CHUNK_3),
            candidate(4, CHUNK_4), // 仅诊断里有、工具未返回（未进 top-N）
          ]),
          1
        ),
    },
    fallbackConcluder: async () => '斩华雄者系关羽',
    modelCaller: async () => textResponse('斩华雄者。[片段3]'),
    retrievalDiagnosticsPersister: (_traceId, _seq, diagnostics) => {
      recorded.push({ diagnostics: diagnostics as Record<string, unknown> });
    },
  });

  await runWithTraceId(TRACE_ID, () => agent.processQueryData('谁斩了华雄？', 'sango-novel'));
  const diag = recorded[0].diagnostics;
  assert.equal(funnelField(diag, 'injected'), 3, '仅返回的 3 条计入 injected');
  const c4 = (diag.candidates as Array<{ chunkId: string; injected: boolean; cited: boolean }>).find(
    (c) => c.chunkId === CHUNK_4
  );
  assert.ok(c4, '第 4 条候选仍在诊断中');
  assert.equal(c4?.injected, false, '未进 top-N（未返回）不标记 injected');
  assert.equal(c4?.cited, false, '未进 top-N 不标记 cited');
});

test('④ 落库失败旁路：persister 抛错不影响 /api/chat 响应与 data 形状', async () => {
  let persisted = 0;
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () =>
        recallResult(makeDiagnostics(3, [candidate(1, CHUNK_1), candidate(2, CHUNK_2), candidate(3, CHUNK_3)]), 1),
    },
    fallbackConcluder: async () => '斩华雄者系关羽',
    modelCaller: async () => textResponse('按原文，斩华雄者系关羽。[Q1]'),
    retrievalDiagnosticsPersister: () => {
      persisted += 1;
      throw new Error('db down');
    },
  });

  const data = await runWithTraceId(TRACE_ID, () =>
    agent.processQueryData('谁斩了华雄？', 'sango-novel')
  );
  assert.equal(persisted, 1, '落库被触发，抛错被旁路吞掉');
  assert.ok(data.answer.includes('按原文'), '响应正常返回');
  assert.deepEqual(Object.keys(data).sort(), ['answer', 'citations'], 'data 形状不变');
  assert.equal(data.citations.length, 1);
});

test('⑤ LLM 自主 tool-use 路径：funnel.injected=0（§3.2 预期）+ cited 正常回填', async () => {
  const recorded: Array<{ diagnostics: Record<string, unknown> }> = [];
  let callCount = 0;
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () =>
        recallResult(makeDiagnostics(3, [candidate(1, CHUNK_1), candidate(2, CHUNK_2), candidate(3, CHUNK_3)]), 1),
    },
    fallbackConcluder: async () => '斩华雄者系关羽',
    modelCaller: async () => {
      callCount += 1;
      return callCount === 1
        ? toolUseResponse('sango_novel_search', { source: 'sanguo-yanyi', query: '谁斩了华雄？', limit: 10 })
        : textResponse('按原文，斩华雄者系关羽。[Q1]');
    },
    retrievalDiagnosticsPersister: (_traceId, _seq, diagnostics) => {
      recorded.push({ diagnostics: diagnostics as Record<string, unknown> });
    },
  });

  const data = await runWithTraceId(TRACE_ID, () => agent.processQueryData('谁斩了华雄？'));
  const diag = recorded[0].diagnostics;
  assert.equal(funnelField(diag, 'injected'), 0, 'LLM 自主 tool-use 路径无确定性注入视图 → injected=0（§3.2 预期）');
  assert.equal(funnelField(diag, 'cited'), 1, 'citations 仍由总台渲染，cited 正常回填');
  const c1 = (diag.candidates as Array<{ chunkId: string; injected: boolean; cited: boolean }>).find(
    (c) => c.chunkId === CHUNK_1
  );
  assert.equal(c1?.injected, false, 'tool-use 路径候选 injected=false');
  assert.equal(c1?.cited, true, '被引用候选 cited=true');
  assert.ok(data.answer.includes('云长提刀出阵'), 'tool-use 路径引用渲染正常');
});

test('⑥ 无诊断检索：不登记调用、persister 不被触发（旁路）', async () => {
  let persisted = 0;
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({ content: [{ type: 'text', text: JSON.stringify(ENTRIES) }] }), // 无 _meta.diagnostics
    },
    fallbackConcluder: async () => '斩华雄者系关羽',
    modelCaller: async () => textResponse('斩华雄者。'),
    retrievalDiagnosticsPersister: () => {
      persisted += 1;
    },
  });

  const data = await runWithTraceId(TRACE_ID, () =>
    agent.processQueryData('谁斩了华雄？', 'sango-novel')
  );
  assert.equal(persisted, 0, '无诊断不落库');
  assert.ok(data.answer.length > 0, '响应正常');
});
