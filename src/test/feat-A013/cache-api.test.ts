// feat-A013 缓存后台接口测试（测试即文档）：覆盖接口文档 §3.1~3.9 全部端点，
// 统一信封 { code, data, message }、错误码 400 / 404 / 500、分页 / 时间参数校验、
// 命中线等运行时状态走 CacheManager（本测试用假实现）、cache_logs 数据源走注入的 LogStore。
// 另验证 server.ts 挂载：注入 cacheManager 时 /api/v1/cache* 可用、未注入时不挂载；本组接口不落日志。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import type { ToolCallResult } from '../../types.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import {
  createCacheApi,
  type CacheEntryDetail,
  type CacheManager,
  type CacheOverview,
  type CacheStatus,
} from '../../api/v1/cache.js';

const TRACE_A = '9f7c0000-0000-4000-8000-0000000000a1';
const TRACE_B = '9f7c0000-0000-4000-8000-0000000000b2';
const HIT_LINE = 0.92;

/** 缓存池假实现：仅支撑后台接口形状（池子真实 LRU / 判定逻辑在小胡 src/cache.ts，不在本测试范围） */
class FakeCacheManager implements CacheManager {
  enabled = true;
  hitLine = HIT_LINE;
  maxEntries = 500;
  readonly entries = new Map<number, CacheEntryDetail>();
  private nextId = 1;

  constructor(seed: Array<Partial<CacheEntryDetail> & { queryText: string }> = []) {
    for (const item of seed) {
      const id = this.nextId++;
      this.entries.set(id, {
        id,
        answerBytes: 128,
        embeddingBytes: 4096,
        hitCount: 0,
        lastAccessAt: id * 1000,
        createdAt: id * 1000,
        ...item,
      });
    }
  }

  getStatus(): CacheStatus {
    return { enabled: this.enabled, hitLine: this.hitLine, maxEntries: this.maxEntries, entryCount: this.entries.size };
  }

  setEnabled(enabled: boolean): CacheStatus {
    this.enabled = enabled;
    return this.getStatus();
  }

  clearAll(): { cleared: number } {
    const cleared = this.entries.size;
    this.entries.clear();
    return { cleared };
  }

  deleteEntry(id: number): boolean {
    return this.entries.delete(id);
  }

  listEntries(options: { pageNo: number; pageSize: number; sortBy: 'lastAccessAt' | 'hitCount'; order: 'asc' | 'desc' }): {
    list: CacheEntryDetail[];
    total: number;
  } {
    const all = Array.from(this.entries.values());
    const column = options.sortBy === 'hitCount' ? 'hitCount' : 'lastAccessAt';
    all.sort((a, b) => {
      const diff = a[column] - b[column];
      return options.order === 'asc' ? diff : -diff;
    });
    const start = (options.pageNo - 1) * options.pageSize;
    return { list: all.slice(start, start + options.pageSize), total: all.length };
  }

  getOverview(): CacheOverview {
    const entryCount = this.entries.size;
    const answerBytesTotal = Array.from(this.entries.values()).reduce((sum, e) => sum + e.answerBytes, 0);
    const embeddingBytesTotal = entryCount * 4096;
    return {
      enabled: this.enabled,
      hitLine: this.hitLine,
      maxEntries: this.maxEntries,
      entryCount,
      answerBytesTotal,
      embeddingBytesTotal,
      approximateBytes: answerBytesTotal + embeddingBytesTotal + entryCount * 256,
      avgAnswerBytes: entryCount === 0 ? 0 : answerBytesTotal / entryCount,
    };
  }
}

class StubAgent {
  async processQueryData(query: string): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }

  async listTools(): Promise<unknown[]> {
    return [];
  }
}

class QuizSimTransport {
  async fengyunsanguo_quiz_command(message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `模拟回复：${message}` }] };
  }
}

async function listen(app: express.Express, t: TestContext): Promise<string> {
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function send(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const get = (baseUrl: string, path: string) => send(baseUrl, 'GET', path);

function startCacheApi(t: TestContext, manager: CacheManager, logStore: LogStore): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/cache', createCacheApi(manager, logStore));
  return listen(app, t);
}

function seedCacheLog(store: LogStore, traceId: string, overrides: Record<string, unknown> = {}): void {
  store.ensureSkeleton('chat', traceId, '问题', 'sango-novel', Date.now());
  store.appendCacheLog(traceId, {
    userQuery: '义释严颜是怎么回事',
    nearestQuery: '义释严颜的经过',
    similarity: 0.9821,
    hitLine: HIT_LINE,
    hit: true,
    tieHits: 1,
    ...(overrides as object),
  } as never);
}

test('① GET /status：开关与配置状态（§3.1 形状）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager([{ queryText: '问题一' }, { queryText: '问题二' }]);
  const baseUrl = await startCacheApi(t, manager, store);

  const { status, body } = await get(baseUrl, '/api/v1/cache/status');
  assert.equal(status, 200);
  assert.deepEqual(body, {
    code: 200,
    data: { enabled: true, hitLine: HIT_LINE, maxEntries: 500, entryCount: 2 },
    message: '',
  });
});

test('② PUT /status：开关切换立即生效；enabled 非布尔 → 400（§3.2）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager();
  const baseUrl = await startCacheApi(t, manager, store);

  const off = await send(baseUrl, 'PUT', '/api/v1/cache/status', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.data.enabled, false);
  assert.equal(off.body.data.entryCount, 0);
  const on = await send(baseUrl, 'PUT', '/api/v1/cache/status', { enabled: true });
  assert.equal(on.body.data.enabled, true, '再次开启恢复');

  for (const bad of [{ enabled: 'yes' }, {}, { enabled: 1 }, { enabled: null }]) {
    const res = await send(baseUrl, 'PUT', '/api/v1/cache/status', bad);
    assert.equal(res.status, 400, `enabled=${JSON.stringify(bad)} 应 400`);
    assert.equal(res.body.message, 'enabled 必须为布尔值');
  }
});

test('③ POST /clear：全量清除返回清除前条数（§3.3）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager([{ queryText: '问题一' }, { queryText: '问题二' }, { queryText: '问题三' }]);
  const baseUrl = await startCacheApi(t, manager, store);

  const { status, body } = await send(baseUrl, 'POST', '/api/v1/cache/clear');
  assert.equal(status, 200);
  assert.deepEqual(body, { code: 200, data: { cleared: 3 }, message: '' }, 'cleared = 清除前条目数');
});

test('④ DELETE /entries/:id：成功 / 不存在 404 / id 非法 400（§3.4）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager([{ queryText: '问题一' }]);
  const baseUrl = await startCacheApi(t, manager, store);

  const del = await send(baseUrl, 'DELETE', '/api/v1/cache/entries/1');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.data, { deleted: true });
  // 已删 → 404
  const gone = await send(baseUrl, 'DELETE', '/api/v1/cache/entries/1');
  assert.equal(gone.status, 404);
  assert.equal(gone.body.message, '缓存条目不存在');
  // 不存在 id → 404
  const nope = await send(baseUrl, 'DELETE', '/api/v1/cache/entries/42');
  assert.equal(nope.status, 404);
  // 非法 id → 400
  for (const bad of ['0', 'abc', '-1', '1.5']) {
    const res = await send(baseUrl, 'DELETE', `/api/v1/cache/entries/${bad}`);
    assert.equal(res.status, 400, `id=${bad} 应 400`);
    assert.equal(res.body.message, 'id 非法');
  }
});

test('⑤ GET /entries：分页 / 排序 / 载荷纪律 / 参数校验（§3.5）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager([
    { queryText: 'Q1', hitCount: 1, lastAccessAt: 100 },
    { queryText: 'Q2', hitCount: 5, lastAccessAt: 300 },
    { queryText: 'Q3', hitCount: 3, lastAccessAt: 200 },
  ]);
  const baseUrl = await startCacheApi(t, manager, store);

  // 默认：pageNo=1 / pageSize=20 / lastAccessAt desc
  const all = await get(baseUrl, '/api/v1/cache/entries');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.data.list.map((e: { queryText: string }) => e.queryText), ['Q2', 'Q3', 'Q1']);
  assert.equal(all.body.data.total, 3);
  assert.equal(all.body.data.pageNo, 1);
  assert.equal(all.body.data.pageSize, 20);
  // 载荷纪律：不含 embedding / 答案全文
  assert.deepEqual(Object.keys(all.body.data.list[0]).sort(), ['answerBytes', 'createdAt', 'embeddingBytes', 'hitCount', 'id', 'lastAccessAt', 'queryText']);

  const sorted = await get(baseUrl, '/api/v1/cache/entries?sortBy=hitCount&order=asc&pageSize=2&pageNo=2');
  assert.deepEqual(sorted.body.data.list.map((e: { queryText: string }) => e.queryText), ['Q2'], 'hitCount asc = Q1(1)/Q3(3)/Q2(5)，第 2 页取 Q2');
  assert.equal(sorted.body.data.total, 3);

  for (const bad of ['?pageNo=0', '?pageNo=abc', '?pageSize=0', '?pageSize=101', '?sortBy=text', '?order=up']) {
    const res = await get(baseUrl, `/api/v1/cache/entries${bad}`);
    assert.equal(res.status, 400, `参数 ${bad} 应 400`);
  }
});

test('⑥ GET /overview：概览形状（§3.6 口径由 CacheManager 产出，此处校验信封与字段）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager([{ queryText: 'Q1', answerBytes: 100 }, { queryText: 'Q2', answerBytes: 200 }]);
  const baseUrl = await startCacheApi(t, manager, store);

  const { status, body } = await get(baseUrl, '/api/v1/cache/overview');
  assert.equal(status, 200);
  assert.deepEqual(body.data, {
    enabled: true,
    hitLine: HIT_LINE,
    maxEntries: 500,
    entryCount: 2,
    answerBytesTotal: 300,
    embeddingBytesTotal: 8192,
    approximateBytes: 300 + 8192 + 2 * 256,
    avgAnswerBytes: 150,
  });
});

test('⑦ GET /stats/similarity-distribution：聚合形状与时间参数校验（§3.7）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager();
  const baseUrl = await startCacheApi(t, manager, store);
  const now = Date.now();
  seedCacheLog(store, TRACE_A);
  seedCacheLog(store, TRACE_B);

  const res = await get(baseUrl, `/api/v1/cache/stats/similarity-distribution?startAt=${now - 60000}&endAt=${now + 60000}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.hitLine, HIT_LINE, 'hitLine 来自 CacheManager 当前生效值');
  assert.equal(res.body.data.bucketWidth, 0.02);
  assert.equal(res.body.data.bucketCount, 50);
  assert.equal(res.body.data.buckets.length, 50);
  assert.equal(res.body.data.buckets[49].upper, 1);
  assert.equal(res.body.data.totals.totalCount, 2);
  assert.equal(res.body.data.totals.highConfidence, 2, '命中行 sim=0.9821 ≥ 0.92');
  assert.equal(res.body.data.totals.lowSimilar, 0);
  assert.equal(res.body.data.totals.grayZone, 0);
  assert.equal(res.body.data.startAt, now - 60000);

  for (const bad of ['', '?startAt=abc&endAt=2000', '?startAt=2000', '?endAt=2000', '?startAt=2000&endAt=1000']) {
    const res2 = await get(baseUrl, `/api/v1/cache/stats/similarity-distribution${bad}`);
    assert.equal(res2.status, 400, `参数「${bad}」应 400`);
    assert.equal(res2.body.message, 'startAt/endAt 必填且为毫秒时间戳');
  }
});

test('⑧ GET /grayzone：灰色区 query 对明细 / marked 过滤 / 分页（§3.8）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager();
  const baseUrl = await startCacheApi(t, manager, store);
  const now = Date.now();
  seedCacheLog(store, TRACE_A, { hit: false, similarity: 0.79 } as never);
  seedCacheLog(store, TRACE_B, { hit: false, similarity: 0.8512, userQuery: '严颜被义释是哪一回', nearestQuery: '义释严颜的经过' } as never);

  const range = `startAt=${now - 60000}&endAt=${now + 60000}`;
  const all = await get(baseUrl, `/api/v1/cache/grayzone?${range}`);
  assert.equal(all.status, 200);
  assert.equal(all.body.data.total, 1, 'sim=0.79 不在灰色区（< 0.80）');
  const item = all.body.data.list[0];
  assert.deepEqual(Object.keys(item).sort(), ['cacheLogId', 'createdAt', 'hitLine', 'marked', 'nearestQuery', 'similarity', 'traceId', 'userQuery']);
  assert.equal(item.traceId, TRACE_B);
  assert.equal(item.userQuery, '严颜被义释是哪一回');
  assert.equal(item.nearestQuery, '义释严颜的经过');
  assert.equal(item.similarity, 0.8512);
  assert.equal(item.hitLine, HIT_LINE);
  assert.equal(item.marked, false);

  // marked 过滤：先标记再查
  const cacheLogId = item.cacheLogId;
  await send(baseUrl, 'POST', `/api/v1/cache/records/${cacheLogId}/mark`, { markedBy: '巡检' });
  const marked = await get(baseUrl, `/api/v1/cache/grayzone?${range}&marked=marked`);
  assert.equal(marked.body.data.total, 1);
  const unmarked = await get(baseUrl, `/api/v1/cache/grayzone?${range}&marked=unmarked`);
  assert.equal(unmarked.body.data.total, 0);
  // 非法 marked → 400
  const badMarked = await get(baseUrl, `/api/v1/cache/grayzone?${range}&marked=yes`);
  assert.equal(badMarked.status, 400);
  assert.equal(badMarked.body.message, 'marked 只支持 all/marked/unmarked');
  // 缺时间参数 → 400
  const noRange = await get(baseUrl, '/api/v1/cache/grayzone');
  assert.equal(noRange.status, 400);
  // 分页参数非法 → 400
  const badPage = await get(baseUrl, `/api/v1/cache/grayzone?${range}&pageNo=0`);
  assert.equal(badPage.status, 400);
});

test('⑨ POST /records/:id/mark|unmark：默认标记人 / 幂等 200 / 不存在 404 / id 非法 400（§3.9）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager();
  const baseUrl = await startCacheApi(t, manager, store);
  seedCacheLog(store, TRACE_A);
  const id = store.queryCacheLogByTrace(TRACE_A)!.id;
  const id2 = 9999;

  // mark（缺省标记人「控制台」）
  const marked = await send(baseUrl, 'POST', `/api/v1/cache/records/${id}/mark`, {});
  assert.equal(marked.status, 200);
  assert.deepEqual(marked.body.data, { marked: true });
  let record = store.queryCacheLogByTrace(TRACE_A)!;
  assert.equal(record.marked, true);
  assert.equal(record.markedBy, '控制台');
  // 已标记再标记：幂等 200
  const remark = await send(baseUrl, 'POST', `/api/v1/cache/records/${id}/mark`, { markedBy: '巡检员' });
  assert.equal(remark.status, 200);
  record = store.queryCacheLogByTrace(TRACE_A)!;
  assert.equal(record.markedBy, '巡检员', '重标记更新标记人');
  // unmark：取消并清 marked_by / marked_at
  const unmarked = await send(baseUrl, 'POST', `/api/v1/cache/records/${id}/unmark`);
  assert.equal(unmarked.status, 200);
  assert.deepEqual(unmarked.body.data, { marked: false });
  record = store.queryCacheLogByTrace(TRACE_A)!;
  assert.equal(record.marked, false);
  assert.equal(record.markedBy, null);
  assert.equal(record.markedAt, null);
  // 未标记再取消：幂等 200
  assert.equal((await send(baseUrl, 'POST', `/api/v1/cache/records/${id}/unmark`)).status, 200);
  // 不存在 → 404
  assert.equal((await send(baseUrl, 'POST', `/api/v1/cache/records/${id2}/mark`, {})).status, 404);
  assert.equal((await send(baseUrl, 'POST', `/api/v1/cache/records/${id2}/unmark`)).status, 404);
  // id 非法 → 400
  for (const bad of ['abc', '0', '-2']) {
    assert.equal((await send(baseUrl, 'POST', `/api/v1/cache/records/${bad}/mark`, {})).status, 400);
  }
  // markedBy 非字符串 → 400
  const badBy = await send(baseUrl, 'POST', `/api/v1/cache/records/${id}/mark`, { markedBy: 123 });
  assert.equal(badBy.status, 400);
  assert.equal(badBy.body.message, 'markedBy 必须为字符串');
});

test('⑩ GET /misjudge：误判率口径与 note（§3.9；hitTotal=0 → rate null）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager();
  const baseUrl = await startCacheApi(t, manager, store);
  const now = Date.now();
  seedCacheLog(store, TRACE_A); // hit=1
  seedCacheLog(store, TRACE_B); // hit=1 → 标记
  const second = store.queryCacheLogByTrace(TRACE_B)!;
  store.updateCacheLogMark(second.id, true, '控制台');
  seedCacheLog(store, '9f7c0000-0000-4000-8000-0000000000c3', { hit: false, similarity: 0.85 } as never);

  const res = await get(baseUrl, `/api/v1/cache/misjudge?startAt=${now - 60000}&endAt=${now + 60000}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.hitTotal, 2);
  assert.equal(res.body.data.markedMisjudge, 1);
  assert.equal(res.body.data.misjudgeRate, 0.5);
  assert.ok(res.body.data.note.startsWith('误判率 = 区间标记误判命中数'));

  const empty = await get(baseUrl, `/api/v1/cache/misjudge?startAt=${now - 60000}&endAt=${now - 59999}`);
  assert.equal(empty.body.data.hitTotal, 0);
  assert.equal(empty.body.data.misjudgeRate, null, 'hitTotal=0 → rate null');
  const badRange = await get(baseUrl, '/api/v1/cache/misjudge');
  assert.equal(badRange.status, 400);
});

test('⑪ server.ts 挂载：注入 cacheManager 后 /api/v1/cache* 可用；未注入不挂载；本组接口不落日志', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager([{ queryText: 'Q1' }]);
  const app = createServer(
    new StubAgent() as unknown as Agent,
    new QuizSimTransport() as unknown as MCPTransport,
    { port: 0, allowedOrigin: '*', logStore: store, cacheManager: manager }
  );
  const baseUrl = await listen(app, t);
  const status = await get(baseUrl, '/api/v1/cache/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.entryCount, 1, '注入实例经 server 挂载对外生效');
  // 本组接口自身不落日志（防递归）：打了一串接口后 request_logs 仍 0 行
  await send(baseUrl, 'PUT', '/api/v1/cache/status', { enabled: false });
  await send(baseUrl, 'POST', '/api/v1/cache/clear');
  await get(baseUrl, '/api/v1/cache/entries');
  await get(baseUrl, '/api/v1/cache/overview');
  await get(baseUrl, '/api/v1/cache/stats/similarity-rows?startAt=1&endAt=2&bucketIndex=0');
  assert.equal(store.queryList({}).total, 0, 'cache 接口不产生 request_logs 行');

  // 未注入 cacheManager → 不挂载（404）
  const app2 = createServer(
    new StubAgent() as unknown as Agent,
    new QuizSimTransport() as unknown as MCPTransport,
    { port: 0, allowedOrigin: '*', logStore: store }
  );
  const baseUrl2 = await listen(app2, t);
  const absent = await fetch(`${baseUrl2}/api/v1/cache/status`);
  assert.equal(absent.status, 404, '未注入实例时路由不挂载（Express 默认 404 页为 HTML，不做 JSON 解析）');
});

test('⑫ GET /stats/similarity-rows：桶明细字段 / 三档边界 / 分页 total / 对账与参数校验（§3.11）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const manager = new FakeCacheManager();
  const baseUrl = await startCacheApi(t, manager, store);
  const now = Date.now();
  // 边界用例（桶口径与 §3.7 bucketIndex(sim) 同源）：sim=null 池空 / 0.0199 落桶 0；0.02 恰入桶 1；0.98 与 1.0 落桶 49
  seedCacheLog(store, TRACE_A, { similarity: null, userQuery: '池空无候选' } as never);
  seedCacheLog(store, TRACE_B, { similarity: 0.0199, userQuery: '低相似下沿' } as never);
  seedCacheLog(store, '9f7c0000-0000-4000-8000-0000000000c3', { similarity: 0.02, userQuery: '桶边界 0.02' } as never);
  seedCacheLog(store, '9f7c0000-0000-4000-8000-0000000000c4', { similarity: 0.98, userQuery: '高置信下沿' } as never);
  seedCacheLog(store, '9f7c0000-0000-4000-8000-0000000000c5', { similarity: 1, userQuery: '相似度顶点' } as never);
  const range = `startAt=${now - 60000}&endAt=${now + 60000}`;

  // 正常查询：桶 49 两行，返回字段形状符合契约
  const rows = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&bucketIndex=49`);
  assert.equal(rows.status, 200);
  assert.equal(rows.body.data.total, 2);
  assert.deepEqual(
    rows.body.data.list.map((r: { userQuery: string }) => r.userQuery).sort(),
    ['高置信下沿', '相似度顶点'].sort(),
    '桶 49 只含 0.98 与 1.0 两行'
  );
  const item = rows.body.data.list[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'cacheLogId',
    'createdAt',
    'hit',
    'hitLine',
    'marked',
    'nearestQuery',
    'similarity',
    'tieHits',
    'traceId',
    'userQuery',
  ]);
  assert.equal(typeof item.cacheLogId, 'number');
  assert.equal(typeof item.traceId, 'string');
  assert.equal(typeof item.hit, 'boolean');
  assert.deepEqual(
    rows.body.data.list.map((r: { traceId: string }) => r.traceId).sort(),
    ['9f7c0000-0000-4000-8000-0000000000c4', '9f7c0000-0000-4000-8000-0000000000c5'],
    '桶 49 行为 0.98 / 1.0 两行'
  );

  // 三档边界：sim=null 与 0.0199 落桶 0；0.02 恰入桶 1（下界含、上界不含）
  const bucket0 = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&bucketIndex=0`);
  assert.equal(bucket0.status, 200);
  assert.equal(bucket0.body.data.total, 2, 'sim=null + 0.0199 落桶 0');
  const bucket1 = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&bucketIndex=1`);
  assert.equal(bucket1.body.data.total, 1, '0.02 恰入桶 1');
  assert.equal(bucket1.body.data.list[0].similarity, 0.02);

  // 分页：桶 49 共 2 行，pageSize=1 翻到第 2 页 total 仍为 2
  const paged = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&bucketIndex=49&pageNo=2&pageSize=1`);
  assert.equal(paged.status, 200);
  assert.equal(paged.body.data.total, 2);
  assert.equal(paged.body.data.list.length, 1);
  assert.equal(paged.body.data.pageNo, 2);
  assert.equal(paged.body.data.pageSize, 1);

  // 对账：同时间窗无筛选时，每桶 total === 分布图该柱 count（新增验收第 18 行）
  const dist = await get(baseUrl, `/api/v1/cache/stats/similarity-distribution?${range}`);
  assert.equal(dist.body.data.totals.totalCount, 5);
  for (let i = 0; i < 50; i += 1) {
    const res = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&bucketIndex=${i}`);
    assert.equal(res.body.data.total, dist.body.data.buckets[i].count, `桶 ${i} total === 分布图 count`);
  }

  // 非法 bucketIndex / 缺 startAt → 400
  for (const bad of ['-1', '50', 'abc', '1.5']) {
    const res = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&bucketIndex=${bad}`);
    assert.equal(res.status, 400, `bucketIndex=${bad} 应 400`);
  }
  const noRange = await get(baseUrl, '/api/v1/cache/stats/similarity-rows?bucketIndex=0');
  assert.equal(noRange.status, 400);
  const badPage = await get(baseUrl, `/api/v1/cache/stats/similarity-rows?${range}&pageNo=0`);
  assert.equal(badPage.status, 400);
});
