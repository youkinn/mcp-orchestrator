// feat-A009 存储层测试（测试即文档）：
// 覆盖：tool_retrieval_logs 新表写入/查询（trace_id+seq 复合主键）/ 明细附解析后 diagnostics /
// 未写诊断 → null / seq 自增返回与缓冲正确性（同秒连续调用不撞号）/ FK 级联删除 / 落库失败旁路（行缺失静默）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createLogStore, type LogStore } from '../../storage/logs.js';

const TRACE_A = '9f7c0000-0000-4000-8000-00000000000a';
const TRACE_B = '9f7c0000-0000-4000-8000-00000000000b';

const SAMPLE_DIAGNOSTICS = {
  truncated: false,
  truncatedCount: 0,
  query: { raw: '关羽千里走单骑', normalized: '关羽 千里走单骑', tokens: ['关羽', '千里走单骑'] },
  env: { vectorScheme: 'bge-m3', degradedBm25Only: false, corpusChunks: 2344, aliasCount: 87, vectorDim: 1024 },
  funnel: { corpusChunks: 2344, lexicalHits: 42, vectorTop50: 50, labelHits: 3, mergedCandidates: 45, topN: 10, injected: 5, cited: 3 },
  candidates: [
    { rank: 1, chunkId: 'sanguo-yanyi:0073:c0007', chapter: 73, title: '玄德进位汉中王', bm25: 12.34, cosine: 0.812, labelHit: true, finalScore: 0.92, sources: ['lexical', 'vector'], injected: true, cited: true },
  ],
  nextRank: null,
  deathIntent: { detected: false, pinned: false, chunkIds: [] },
};

test('① 新表写入/查询：appendToolCall 返回 seq，appendRetrievalLog 后明细 toolCalls[].diagnostics 为解析后对象', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', 'sango-novel', 1000);
  const seq = store.appendToolCall(TRACE_A, {
    mcpServer: 'sango',
    toolName: 'sango_novel_search',
    argsSummary: '{"query":"关羽"}',
    callSentAt: 1100,
    callReturnedAt: 1200,
    resultSummary: '[{"id":"sango-yanyi:0073:c0007"}]',
    status: 'success',
  });
  assert.equal(seq, 1, 'appendToolCall 返回自增 seq');
  store.appendRetrievalLog(TRACE_A, seq, SAMPLE_DIAGNOSTICS);
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.toolCalls.length, 1);
  const tool = detail.toolCalls[0];
  assert.equal(tool.seq, 1);
  assert.deepEqual(tool.diagnostics, SAMPLE_DIAGNOSTICS, '查询接口返回解析后完整对象（含回填的 injected/cited）');
  assert.equal(tool.resultSummary, '[{"id":"sango-yanyi:0073:c0007"}]');
});

test('② 未写诊断 → toolCalls[].diagnostics=null；非检索工具同样为 null', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.appendToolCall(TRACE_A, { mcpServer: 'weather', toolName: 'get-forecast', callSentAt: 1100, status: 'success' });
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.toolCalls[0].diagnostics, null);
});

test('③ seq 自增 + 缓冲正确性：未落盘前连续多次 appendToolCall 不撞号（1,2,3）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  const seq1 = store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 'a', callSentAt: 1, status: 'success' });
  const seq2 = store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 'b', callSentAt: 2, status: 'success' });
  const seq3 = store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 'c', callSentAt: 3, status: 'success' });
  store.flush();

  assert.deepEqual([seq1, seq2, seq3], [1, 2, 3], '同秒连续调用 seq 依次递增（不撞号）');
  const detail = store.queryDetail(TRACE_A)!;
  assert.deepEqual(detail.toolCalls.map((tool) => tool.seq), [1, 2, 3]);
});

test('④ 复合主键 + FK 级联：request_logs 过期清理经 tool_call_logs 双重级联删 tool_retrieval_logs', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1);
  const seq = store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 't', callSentAt: 2, status: 'success' });
  assert.ok(seq !== null, 'appendToolCall 应返回自增 seq（非 null）');
  store.appendRetrievalLog(TRACE_A, seq, SAMPLE_DIAGNOSTICS);
  store.flush();
  store.runRetentionCleanup();
  store.flush();

  assert.equal(store.queryDetail(TRACE_A), null, '过期 trace 整体级联清除');
});

test('⑤ 落库失败旁路：retrieval seq 无对应 tool_call 行（FK 缺失）时静默跳过，不抛错、不影响其他写入', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 'a', callSentAt: 1, status: 'success' });
  // seq=99 无对应 tool_call_logs 行 → INSERT OR IGNORE 静默跳过（旁路），flush 不抛错
  store.appendRetrievalLog(TRACE_A, 99, SAMPLE_DIAGNOSTICS);
  store.flush();
  assert.doesNotThrow(() => store.flush());

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.toolCalls[0].diagnostics, null, 'FK 缺失的诊断不落库 → 查询 null');
  assert.equal(detail.toolCalls[0].seq, 1, 'tool_call_logs 正常写入不受影响');
});

test('⑥ 同 trace 重复工具调用各持独立诊断行（seq 递增），互不覆盖', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  const seq1 = store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 't1', callSentAt: 1, status: 'success' });
  const seq2 = store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 't2', callSentAt: 2, status: 'success' });
  assert.ok(seq1 !== null && seq2 !== null, 'appendToolCall 应返回自增 seq（非 null）');
  store.appendRetrievalLog(TRACE_A, seq1, { ...SAMPLE_DIAGNOSTICS, truncated: true });
  store.appendRetrievalLog(TRACE_A, seq2, { ...SAMPLE_DIAGNOSTICS, truncated: false });
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.toolCalls[0].diagnostics?.truncated, true);
  assert.equal(detail.toolCalls[1].diagnostics?.truncated, false);
});

test('⑦ 旁路：DB 不可用（路径为目录）no-op store，appendRetrievalLog 不抛错、查询为空', (t) => {
  const store = createLogStore({ dbPath: tmpdir() });
  t.after(() => store.close());

  assert.doesNotThrow(() => {
    store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 't', callSentAt: 1, status: 'success' });
    store.appendRetrievalLog(TRACE_A, 1, SAMPLE_DIAGNOSTICS);
    store.flush();
  });
  assert.equal(store.queryDetail(TRACE_A), null);
});
