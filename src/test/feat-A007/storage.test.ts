// feat-A007 存储层测试（测试即文档）：
// 覆盖：骨架幂等 / 回填覆盖 / 截断 / 明细 seq / 列表过滤分页 / 派生耗时与 token 聚合 /
// token-stats 日界与降级 / 补报静默 / 保留清理级联 / 故障注入旁路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
  createLogStore,
  truncate,
  type LogStore,
} from '../../storage/logs.js';

const TRACE_A = '9f7c0000-0000-4000-8000-00000000000a';
const TRACE_B = '9f7c0000-0000-4000-8000-00000000000b';
const TRACE_C = '9f7c0000-0000-4000-8000-00000000000c';
const TRUNCATE_MARKER = '…（已截断）';
const DAY_MS = 24 * 3600 * 1000;

test('截断：≤max 原样；超长取前 max 字符 + 标记（标记不计入上限）；非字符串原样返回', () => {
  assert.equal(truncate('abc'), 'abc');
  assert.equal(truncate('ab', 3), 'ab');
  assert.equal(truncate('abcd', 3), `abc${TRUNCATE_MARKER}`);
  assert.equal(truncate('abcd', 4), 'abcd');
  assert.equal(truncate('x'.repeat(8000)), 'x'.repeat(8000));
  const truncated = truncate('x'.repeat(8001));
  assert.equal(truncated, 'x'.repeat(8000) + TRUNCATE_MARKER);
  assert.equal(truncated!.length, 8000 + TRUNCATE_MARKER.length);
  assert.equal(truncate(null), null);
  assert.equal(truncate(undefined), undefined);
});

test('骨架幂等：同 traceId 重复 ensureSkeleton 只保留一行（INSERT OR IGNORE），骨架初值 failed/500/中断', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, '第一问', 'sango-novel', 100, 10);
  store.ensureSkeleton('chat', TRACE_A, '第二问', 'sango-novel', 200, 20);
  store.flush();

  const result = store.queryList({});
  assert.equal(result.total, 1);
  const item = result.list[0];
  assert.equal(item.traceId, TRACE_A);
  assert.equal(item.userInput, '第一问', '重复骨架不得覆盖首条 user_input');
  assert.equal(item.serverReceivedAt, 100);
  assert.equal(item.status, 'failed');
  assert.equal(item.responseCode, 500);
  assert.equal(item.errorMessage, '请求中断未完成回填');
  assert.equal(item.tokens, null);
});

test('回填：markHandled / markResponded 覆盖骨架初值，重复回填以最后一次为准', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, '问题', 'sango-novel', 1000, 900);
  store.markHandled(TRACE_A, 1200);
  store.markResponded(TRACE_A, 2000, 'success', 200, '', '答案文本', '[{"a":1}]');
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.log.status, 'success');
  assert.equal(detail.log.responseCode, 200);
  assert.equal(detail.log.errorMessage, '');
  assert.equal(detail.log.clientSentAt, 900);
  assert.equal(detail.log.handleStartedAt, 1200);
  assert.equal(detail.log.serverRespondedAt, 2000);
  assert.equal(detail.log.answer, '答案文本');
  assert.equal(detail.log.citations, '[{"a":1}]');

  store.markResponded(TRACE_A, 3000, 'failed', 500, '处理失败', null, null);
  store.flush();
  const after = store.queryDetail(TRACE_A)!;
  assert.equal(after.log.status, 'failed');
  assert.equal(after.log.responseCode, 500);
  assert.equal(after.log.errorMessage, '处理失败');
  assert.equal(after.log.answer, null);
  assert.equal(after.log.citations, null);
  assert.equal(after.log.serverRespondedAt, 3000);
});

test('回填内容截断：answer 超 8000 带「…（已截断）」落库；成功 citations 恒为数组 JSON 字符串', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.markResponded(TRACE_A, 2000, 'success', 200, '', '答'.repeat(8001), '[]');
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.log.answer, '答'.repeat(8000) + TRUNCATE_MARKER);
  assert.equal(detail.log.citations, '[]');
});

test('明细 seq：同 trace 内 LLM / 工具各自从 1 自增，明细按 seq 升序返回', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.appendLlmCall(TRACE_A, { stage: 'routing', model: 'deepseek', requestAt: 1100, status: 'success', promptTokens: 1, completionTokens: 1 });
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'deepseek', requestAt: 1200, responseAt: 1800, status: 'success', promptTokens: 2, completionTokens: 2 });
  store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 'sango_novel_search', callSentAt: 1300, status: 'success' });
  store.appendToolCall(TRACE_A, { mcpServer: 'fengyunsanguo', toolName: 'fengyunsanguo_query', argsSummary: '{"text":"夏侯惇"}', callSentAt: 1400, status: 'failed', errorMessage: '工具超时' });
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.deepEqual(detail.llmCalls.map((call) => call.seq), [1, 2]);
  assert.deepEqual(detail.llmCalls.map((call) => call.stage), ['routing', 'generation']);
  assert.equal(detail.llmCalls[0].responseAt, null, '未返回的调用 response_at 为 null');
  assert.deepEqual(detail.toolCalls.map((call) => call.seq), [1, 2]);
  assert.equal(detail.toolCalls[1].status, 'failed');
  assert.equal(detail.toolCalls[1].errorMessage, '工具超时');
  assert.equal(detail.toolCalls[1].argsSummary, '{"text":"夏侯惇"}');
});

test('明细插入：调用方传 seq 时按给定序号，同 (trace, seq) 重复插入被忽略（幂等）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.appendLlmCall(TRACE_A, { seq: 1, stage: 'generation', model: 'm1', requestAt: 1000, status: 'success' });
  store.appendLlmCall(TRACE_A, { seq: 1, stage: 'generation', model: 'm2', requestAt: 1000, status: 'success' });
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.llmCalls.length, 1);
  assert.equal(detail.llmCalls[0].model, 'm1');
});

test('明细内容字段 8000 截断：requestSummary / argsSummary / resultSummary 均带标记', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: 1000, requestSummary: 'x'.repeat(8001), status: 'success' });
  store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 't', argsSummary: 'y'.repeat(8001), resultSummary: 'z'.repeat(8001), callSentAt: 1000, status: 'success' });
  store.flush();

  const detail = store.queryDetail(TRACE_A)!;
  assert.equal(detail.llmCalls[0].requestSummary, 'x'.repeat(8000) + TRUNCATE_MARKER);
  assert.equal(detail.toolCalls[0].argsSummary, 'y'.repeat(8000) + TRUNCATE_MARKER);
  assert.equal(detail.toolCalls[0].resultSummary, 'z'.repeat(8000) + TRUNCATE_MARKER);
});

test('列表：排序 server_received_at DESC + 分页（pageNo/pageSize/total）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'a', null, 1000);
  store.ensureSkeleton('chat', TRACE_B, 'b', null, 2000);
  store.ensureSkeleton('chat', TRACE_C, 'c', null, 3000);
  store.flush();

  const all = store.queryList({});
  assert.equal(all.total, 3);
  assert.deepEqual(all.list.map((item) => item.serverReceivedAt), [3000, 2000, 1000]);
  assert.deepEqual(all.list.map((item) => item.traceId), [TRACE_C, TRACE_B, TRACE_A]);

  const page1 = store.queryList({ pageNo: 1, pageSize: 2 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.list.map((item) => item.traceId), [TRACE_C, TRACE_B]);

  const page2 = store.queryList({ pageNo: 2, pageSize: 2 });
  assert.deepEqual(page2.list.map((item) => item.traceId), [TRACE_A]);

  // 越界裁剪：pageSize 超 100 收窄、pageNo < 1 按 1
  const clamped = store.queryList({ pageNo: 0, pageSize: 500 });
  assert.equal(clamped.list.length, 3);
});

test('列表：全部过滤参数（logType / traceId / startAt / endAt / status / responseCode / keyword）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, '关羽千里走单骑经过', 'sango-novel', 1000);
  store.markResponded(TRACE_A, 2000, 'success', 200, '', 'ok', '[]');
  store.ensureSkeleton('chat', TRACE_B, '今天天气怎么样', null, 2000);
  store.markResponded(TRACE_B, 3000, 'failed', 500, '处理失败，请稍后重试', null, null);
  store.ensureSkeleton('chat', TRACE_C, '三国演义开篇', 'sango-novel', 3000);
  store.markResponded(TRACE_C, 4000, 'success', 200, '', 'ok', '[]');
  store.flush();

  assert.equal(store.queryList({ logType: 'chat' }).total, 3);
  assert.equal(store.queryList({ traceId: TRACE_B }).total, 1);
  assert.equal(store.queryList({ traceId: TRACE_B }).list[0].status, 'failed');
  assert.equal(store.queryList({ startAt: 1500, endAt: 2500 }).total, 1);
  assert.equal(store.queryList({ startAt: 1500, endAt: 2500 }).list[0].traceId, TRACE_B);
  assert.equal(store.queryList({ status: 'success' }).total, 2);
  assert.equal(store.queryList({ responseCode: 500 }).total, 1);
  assert.equal(store.queryList({ keyword: '千里' }).total, 1);
  assert.equal(store.queryList({ keyword: '不存在的词' }).total, 0);
});

test('列表 userInput 摘要 ≤200 字符，超长带「…（已截断）」标记', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, '问'.repeat(300), null, 1000);
  store.flush();

  const item = store.queryList({}).list[0];
  assert.equal(item.userInput, '问'.repeat(200) + TRUNCATE_MARKER);
});

test('派生耗时：完整链路 durations 全部按公式计算（含队列等待 / LLM / 工具聚合）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  // t0=1000 t1=1010 t2=1022 t5=3000 t6=9000（毫秒）
  store.ensureSkeleton('chat', TRACE_A, 'q', 'sango-novel', 1010, 1000);
  store.markHandled(TRACE_A, 1022);
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: 1100, responseAt: 2800, promptTokens: 100, completionTokens: 50, status: 'success' });
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: 2850, responseAt: 2950, promptTokens: 200, completionTokens: 60, status: 'success' });
  store.appendLlmCall(TRACE_A, { stage: 'routing', model: 'm', requestAt: 1050, responseAt: 1090, promptTokens: null, completionTokens: null, status: 'success' });
  store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 'sango_novel_search', callSentAt: 2805, callReturnedAt: 2905, status: 'success' });
  store.markResponded(TRACE_A, 3000, 'success', 200, '', 'answer', '[]');
  store.reportFrontendEnd(TRACE_A, 9000);
  store.flush();

  const item = store.queryList({ traceId: TRACE_A }).list[0];
  // frontend = (t1-t0)+(t6-t5) = 10+6000；queueWait = t2-t1 = 12；
  // server = t5-t1 = 1990；llm = 1700+100+40 = 1840；tool = 100；total = t6-t0 = 8000
  assert.deepEqual(item.durations, {
    frontend: 6010,
    queueWait: 12,
    server: 1990,
    llm: 1840,
    tool: 100,
    total: 8000,
  });
  // tokens：usage 缺失（NULL）行忽略，SUM 有效行
  assert.deepEqual(item.tokens, { input: 300, output: 110 });
});

test('派生耗时：时间点缺失对应项为 null，不估算', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1010, 1000);
  store.flush();
  assert.deepEqual(store.queryList({}).list[0].durations, {
    frontend: null,
    queueWait: null,
    server: null,
    llm: null,
    tool: null,
    total: null,
  });

  // 补 t5：server 可算，其余仍为 null
  store.markResponded(TRACE_A, 3000, 'success', 200, '', 'a', '[]');
  store.flush();
  const item = store.queryList({ traceId: TRACE_A }).list[0];
  assert.equal(item.durations.server, 1990);
  assert.equal(item.durations.frontend, null);
  assert.equal(item.durations.queueWait, null);
  assert.equal(item.durations.total, null);
  assert.equal(item.durations.llm, null);
});

test('token 聚合：无 LLM 调用 → tokens 整体 null；有调用但 usage 全缺失 → input/output 为 null', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.markResponded(TRACE_A, 2000, 'success', 200, '', 'a', '[]');
  store.ensureSkeleton('chat', TRACE_B, 'q2', null, 2000);
  store.appendLlmCall(TRACE_B, { stage: 'generation', model: 'm', requestAt: 2100, responseAt: 2200, status: 'success' });
  store.flush();

  assert.equal(store.queryList({ traceId: TRACE_A }).list[0].tokens, null);
  assert.deepEqual(store.queryList({ traceId: TRACE_B }).list[0].tokens, { input: null, output: null });
});

test('token-stats：Asia/Shanghai 日界分桶（UTC 同一天内跨上海日界）+ 空桶补零', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  const day1Start = Date.parse('2026-09-20T00:00:00+08:00');
  const day2Start = Date.parse('2026-09-21T00:00:00+08:00');
  store.ensureSkeleton('chat', TRACE_A, 'q', null, day1Start);
  // 20 日 23:30 与 21 日 00:30：UTC 均在 16:30 前后，但按 Asia/Shanghai 属两个日桶
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-20T23:30:00+08:00'), promptTokens: 100, completionTokens: 10, status: 'success' });
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-21T00:30:00+08:00'), promptTokens: 200, completionTokens: 20, status: 'success' });
  store.flush();

  const result = store.queryTokenStats({
    startAt: day1Start,
    endAt: Date.parse('2026-09-22T00:00:00+08:00'),
    granularity: 'day',
  });
  assert.equal(result.granularity, 'day');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.deepEqual(result.buckets, [
    { bucket: '2026-09-20', inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
    { bucket: '2026-09-21', inputTokens: 200, outputTokens: 20, cachedTokens: 0 },
    { bucket: '2026-09-22', inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  ]);

  const day2Only = store.queryTokenStats({
    startAt: day2Start,
    endAt: Date.parse('2026-09-22T00:00:00+08:00'),
    granularity: 'day',
  });
  assert.deepEqual(day2Only.buckets.map((bucket) => bucket.inputTokens), [200, 0]);
});

test('token-stats：hour 粒度整点分桶；恰好 7 天不降级，超过 7 天自动降级 day 并如实返回', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  const base = Date.parse('2026-09-20T00:00:00+08:00');
  store.ensureSkeleton('chat', TRACE_A, 'q', null, base);
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-20T10:15:00+08:00'), promptTokens: 1, completionTokens: 10, status: 'success' });
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-20T10:45:00+08:00'), promptTokens: 2, completionTokens: 20, status: 'success' });
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: Date.parse('2026-09-21T00:00:00+08:00'), promptTokens: 4, completionTokens: 40, status: 'success' });
  store.flush();

  const hourResult = store.queryTokenStats({
    startAt: base,
    endAt: Date.parse('2026-09-21T00:00:00+08:00'),
    granularity: 'hour',
  });
  assert.equal(hourResult.granularity, 'hour');
  const tenOClock = hourResult.buckets.find((bucket) => bucket.bucket === '2026-09-20T10:00');
  assert.deepEqual(tenOClock, { bucket: '2026-09-20T10:00', inputTokens: 3, outputTokens: 30, cachedTokens: 0 });
  const nextDay = hourResult.buckets.find((bucket) => bucket.bucket === '2026-09-21T00:00');
  assert.deepEqual(nextDay, { bucket: '2026-09-21T00:00', inputTokens: 4, outputTokens: 40, cachedTokens: 0 });

  const exactly7Days = store.queryTokenStats({
    startAt: base,
    endAt: base + 7 * DAY_MS,
    granularity: 'hour',
  });
  assert.equal(exactly7Days.granularity, 'hour');

  const over7Days = store.queryTokenStats({
    startAt: base,
    endAt: base + 7 * DAY_MS + 1,
    granularity: 'hour',
  });
  assert.equal(over7Days.granularity, 'day');
  assert.equal(over7Days.buckets[0].bucket, '2026-09-20');
});

test('补报：已知 traceId 回填 t6；未知 traceId 静默成功（不抛错、不产生记录）', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());

  store.ensureSkeleton('chat', TRACE_A, 'q', null, 1000);
  store.flush();
  store.reportFrontendEnd(TRACE_A, 9000);
  store.reportFrontendEnd('9f7c0000-0000-4000-8000-ffffffffffff', 12345);
  store.flush();

  assert.equal(store.queryDetail(TRACE_A)!.log.clientReceivedAt, 9000);
  const after = store.queryList({});
  assert.equal(after.total, 1, '未知 traceId 补报不产生新记录');
});

test('保留清理：created_at 超保留天数删除主表，明细随主表级联删除', (t) => {
  const store = createLogStore({ dbPath: ':memory:', retentionDays: 30 });
  t.after(() => store.close());

  const now = Date.now();
  const oldTime = now - 31 * DAY_MS;
  store.ensureSkeleton('chat', TRACE_A, '旧记录', null, oldTime);
  store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: oldTime, status: 'success' });
  store.ensureSkeleton('chat', TRACE_B, '新记录', null, now);
  store.flush();

  store.runRetentionCleanup();

  const result = store.queryList({});
  assert.equal(result.total, 1);
  assert.equal(result.list[0].traceId, TRACE_B);
  assert.equal(store.queryDetail(TRACE_A), null, '主表删除后明细级联清空');
});

test('旁路：DB 写失败（连接已关闭）时写入与 flush 均不抛错', (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  store.close();

  assert.doesNotThrow(() => {
    store.ensureSkeleton('chat', TRACE_A, 'q', null, 1);
    store.markHandled(TRACE_A, 2);
    store.markResponded(TRACE_A, 3, 'success', 200, '', 'a', '[]');
    store.appendLlmCall(TRACE_A, { stage: 'generation', model: 'm', requestAt: 1, status: 'success' });
    store.appendToolCall(TRACE_A, { mcpServer: 'sango', toolName: 't', callSentAt: 1, status: 'success' });
    store.reportFrontendEnd(TRACE_A, 4);
    store.flush();
    store.flush();
  });
});

test('旁路：数据库初始化失败（路径为目录）降级为 no-op store，查询返回空、写入不抛错', (t) => {
  // dbPath 指向一个已存在的目录，SQLite 无法作为数据库打开 → 初始化失败降级
  const store = createLogStore({ dbPath: tmpdir() });
  t.after(() => store.close());

  assert.doesNotThrow(() => {
    store.ensureSkeleton('chat', TRACE_A, 'q', null, 1);
    store.flush();
  });
  assert.deepEqual(store.queryList({}), { list: [], total: 0 });
  assert.equal(store.queryDetail(TRACE_A), null);
  const stats = store.queryTokenStats({ startAt: 0, endAt: 1000, granularity: 'day' });
  assert.deepEqual(stats.buckets, []);
});