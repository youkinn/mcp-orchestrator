// feat-A017 草稿台存储测试（测试即文档）：
// 覆盖：request_logs 来源列（生产 NULL / 草稿台 'draftbench'，列表 / 详情 / token-stats 同口径筛选）、
// 草稿台记录表 round-trip（params/chunks/result 快照 + cited_indexes 解析）、生成温度读取、
// 30 天轮转同周期清理（§10 决策 5）、迁移幂等（重复建库 ALTER 忽略）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogStore } from '../../storage/logs.js';

const TRACE_PROD = '9f7c0000-0000-4000-8000-00000000000a';
const TRACE_DRAFT = '9f7c0000-0000-4000-8000-00000000000b';

test('storage: request_source 落库 + 列表 / 详情 / token-stats 来源筛选同口径', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  store.ensureSkeleton('chat', TRACE_PROD, '生产问题', 'sango-novel', 1789884000000, null);
  store.ensureSkeleton('chat', TRACE_DRAFT, '草稿台问题', 'sango-novel', 1789884009000, null, 'draftbench');
  store.appendLlmCall(TRACE_PROD, {
    stage: 'generation',
    model: 'm',
    requestAt: 1789884001000,
    status: 'success',
    promptTokens: 100,
    completionTokens: 5,
    errorMessage: '',
  });
  store.appendLlmCall(TRACE_DRAFT, {
    stage: 'generation',
    model: 'm',
    requestAt: 1789884001000,
    status: 'success',
    promptTokens: 900,
    completionTokens: 5,
    errorMessage: '',
  });
  store.markResponded(TRACE_PROD, 1789884002000, 'success', 200, '', 'a', '[]');
  store.markResponded(TRACE_DRAFT, 1789884010000, 'success', 200, '', 'b', '[]');
  store.flush();

  // 缺省（undefined）按 production（仅生产 / 历史行，不混入草稿台）
  const defaultList = store.queryList({ pageNo: 1, pageSize: 20 });
  assert.deepEqual(defaultList.list.map((row) => row.traceId), [TRACE_PROD]);
  assert.equal(defaultList.list[0].source, 'production');

  const prodOnly = store.queryList({ pageNo: 1, pageSize: 20, source: 'production' });
  assert.deepEqual(prodOnly.list.map((row) => row.traceId), [TRACE_PROD]);
  const draftOnly = store.queryList({ pageNo: 1, pageSize: 20, source: 'draftbench' });
  assert.deepEqual(draftOnly.list.map((row) => row.traceId), [TRACE_DRAFT]);

  const detail = store.queryDetail(TRACE_DRAFT);
  assert.equal(detail?.log.source, 'draftbench');
  assert.equal(store.queryDetail(TRACE_PROD)?.log.source, 'production');

  const prodStats = store.queryTokenStats({
    startAt: 1789884000000,
    endAt: 1789884009999,
    granularity: 'day',
  });
  assert.equal(prodStats.buckets[0].inputTokens, 100);
  const draftStats = store.queryTokenStats({
    startAt: 1789884000000,
    endAt: 1789884009999,
    granularity: 'day',
    source: 'draftbench',
  });
  assert.equal(draftStats.buckets[0].inputTokens, 900);
  store.close();
});

test('storage: 草稿台记录 round-trip（快照 + cited_indexes + 结果摘要）', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  store.saveDraftbenchRecord({
    traceId: TRACE_DRAFT,
    time: 1789884000000,
    query: '关羽为何败走麦城？',
    params: { temperature: 0.5, topK: 3, guarantee: 2, budget: 500 },
    chunks: [
      { chunkId: 'a', text: '片段甲', chapter: 5, title: '回目' },
      { chunkId: null, text: '片段乙', chapter: null, title: null },
    ],
    citedIndexes: [0, 1],
    status: 'success',
    errorMessage: '',
    result: { answer: '答案', citations: [{ text: '引用甲' }, { text: '引用乙' }] },
  });
  store.saveDraftbenchRecord({
    traceId: '9f7c0000-0000-4000-8000-0000000000c2',
    time: 1789884010000,
    query: '校验失败',
    params: null,
    chunks: null,
    citedIndexes: [],
    status: 'failed',
    errorMessage: '发送清单不能为空',
    result: null,
  });

  // 列表：倒序 + 结果摘要
  const list = store.queryDraftbenchRecords(1, 20);
  assert.equal(list.total, 2);
  assert.equal(list.list[0].traceId, '9f7c0000-0000-4000-8000-0000000000c2');
  assert.equal(list.list[0].params, null);
  assert.equal(list.list[0].result, null);
  assert.equal(list.list[1].chunkCount, 2);
  assert.equal(list.list[1].result?.citationCount, 2);
  assert.deepEqual(list.list[1].params, { temperature: 0.5, topK: 3, guarantee: 2, budget: 500 });

  // 详情：chunks 快照逐条 + cited_indexes 解析回读
  const detail = store.queryDraftbenchRecord(TRACE_DRAFT);
  assert.equal(detail?.chunks.length, 2);
  assert.deepEqual(detail.chunks, [
    { chunkId: 'a', text: '片段甲', chapter: 5, title: '回目' },
    { chunkId: null, text: '片段乙', chapter: null, title: null },
  ]);
  assert.deepEqual(detail.citedIndexes, [0, 1]);
  assert.equal(detail.result?.answer, '答案');
  assert.equal(store.queryDraftbenchRecord('9f7c0000-0000-4000-8000-000000000099'), null);
  store.close();
});

test('storage: 生成温度读生成轮末次成功值；无生成轮为 null', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  store.ensureSkeleton('chat', TRACE_PROD, 'q', 'sango-novel', 1789884000000, null);
  // 首轮失败（attempt=1 空答案）→ 变参重试成功（attempt=2, temperature=0），取末次成功值
  store.appendLlmCall(TRACE_PROD, {
    stage: 'generation',
    model: 'm',
    requestAt: 1789884000100,
    status: 'failed',
    attempt: 1,
    temperature: 0.7,
    errorMessage: '空答案',
  });
  store.appendLlmCall(TRACE_PROD, {
    stage: 'generation',
    model: 'm',
    requestAt: 1789884000200,
    status: 'success',
    attempt: 2,
    temperature: 0,
    errorMessage: '',
  });
  store.flush();
  assert.equal(store.queryGenerationTemperature(TRACE_PROD), 0);
  assert.equal(store.queryGenerationTemperature('9f7c0000-0000-4000-8000-000000000099'), null);
  store.close();
});

test('storage: 草稿台记录随 30 天轮转清理（与 request_logs 同周期）', () => {
  const store = createLogStore({ dbPath: ':memory:', retentionDays: 1 });
  const oldTime = Date.now() - 2 * 24 * 3600 * 1000;
  store.saveDraftbenchRecord({
    traceId: '9f7c0000-0000-4000-8000-0000000000e1',
    time: oldTime,
    query: '过期记录',
    params: null,
    chunks: null,
    citedIndexes: [],
    status: 'failed',
    errorMessage: 'x',
    result: null,
  });
  store.saveDraftbenchRecord({
    traceId: '9f7c0000-0000-4000-8000-0000000000e2',
    time: Date.now(),
    query: '新记录',
    params: null,
    chunks: null,
    citedIndexes: [],
    status: 'failed',
    errorMessage: 'x',
    result: null,
  });
  store.runRetentionCleanup();
  store.flush();
  const list = store.queryDraftbenchRecords(1, 20);
  assert.equal(list.total, 1);
  assert.equal(list.list[0].traceId, '9f7c0000-0000-4000-8000-0000000000e2');
  store.close();
});

test('storage: 迁移幂等（重复建库 ALTER 忽略，来源列可用）', () => {
  const first = createLogStore({ dbPath: ':memory:' });
  first.ensureSkeleton('chat', TRACE_PROD, 'q', 'sango-novel', 1789884000000, null, 'draftbench');
  first.flush();
  assert.equal(first.queryList({ pageNo: 1, pageSize: 20, source: 'draftbench' }).total, 1);
  first.close();
  // 二次建库（新库建表已含列，重复 ALTER 走 catch）→ 功能不回退
  const second = createLogStore({ dbPath: ':memory:' });
  second.ensureSkeleton('chat', '9f7c0000-0000-4000-8000-00000000000c', 'q2', 'sango-novel', 1789884000000, null, 'draftbench');
  second.flush();
  assert.equal(second.queryList({ pageNo: 1, pageSize: 20, source: 'draftbench' }).total, 1);
  second.close();
});
