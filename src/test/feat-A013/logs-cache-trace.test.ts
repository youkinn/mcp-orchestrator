// feat-A013 §3.10 日志接口接线测试（测试即文档）：
// 详情 GET /api/v1/logs/:traceId 增 data.cache（无判定行 null / 有行全字段 + reason 派生）；
// 列表 GET /api/v1/logs 每行增 cacheHit（1=命中 / 0=未命中 / null=无行，LEFT JOIN 派生口径）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createLogsApi } from '../../api/v1/logs.js';
import { createLogStore, type CacheLogPayload, type LogStore } from '../../storage/logs.js';

const TRACE_HIT = '9f7c0000-0000-4000-8000-0000000000a1';
const TRACE_MISS_LOW_EMPTY = '9f7c0000-0000-4000-8000-0000000000a2';
const TRACE_MISS_LOW = '9f7c0000-0000-4000-8000-0000000000a3';
const TRACE_GRAY = '9f7c0000-0000-4000-8000-0000000000a4';
const TRACE_TIE = '9f7c0000-0000-4000-8000-0000000000a5';
const TRACE_FOCUS = '9f7c0000-0000-4000-8000-0000000000a6';
const TRACE_NO_CACHE = '9f7c0000-0000-4000-8000-0000000000a7';
const HIT_LINE = 0.92;

function cachePayload(overrides: Partial<CacheLogPayload> = {}): CacheLogPayload {
  return {
    userQuery: '义释严颜是怎么回事',
    nearestQuery: '义释严颜的经过',
    similarity: 0.9821,
    hitLine: HIT_LINE,
    hit: true,
    tieHits: 1,
    // 验收第七批：缓存判定耗时默认采集值（权重就绪后 ~175ms，参考 trace 2631c162）
    lookupMs: 175,
    ...overrides,
  };
}

function seedTrace(store: LogStore, traceId: string, payload?: CacheLogPayload): void {
  store.ensureSkeleton('chat', traceId, `问题-${traceId.slice(-4)}`, 'sango-novel', Date.now());
  if (payload !== undefined) {
    store.appendCacheLog(traceId, payload);
  }
}

async function startLogsApi(t: TestContext, logStore: LogStore): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/logs', createLogsApi(logStore));
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

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

test('① 详情 data.cache：无判定行 → null（非 sango / 开关关 / 降级 / A013 前历史行统一口径，验收 16）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  seedTrace(store, TRACE_NO_CACHE);
  store.flush(); // 纯骨架行走写缓冲，读取前落盘
  const baseUrl = await startLogsApi(t, store);

  const { status, body } = await get(baseUrl, `/api/v1/logs/${TRACE_NO_CACHE}`);
  assert.equal(status, 200);
  assert.equal(body.data.cache, null, 'cache_logs 无行返回 null');
  assert.equal(body.data.log.traceId, TRACE_NO_CACHE, '明细原有字段不受影响');
});

test('② 详情 data.cache：命中行全字段形状 + reason=hit + cacheLogId（§3.10 / 契约补充）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  seedTrace(store, TRACE_HIT, cachePayload());
  const baseUrl = await startLogsApi(t, store);

  const { status, body } = await get(baseUrl, `/api/v1/logs/${TRACE_HIT}`);
  assert.equal(status, 200);
  const cache = body.data.cache;
  assert.deepEqual(cache, {
    cacheLogId: 1,
    hit: true,
    hitLine: HIT_LINE,
    similarity: 0.9821,
    tieHits: 1,
    userQuery: '义释严颜是怎么回事',
    nearestQuery: '义释严颜的经过',
    reason: 'hit',
    marked: false,
    createdAt: cache.createdAt,
    lookupMs: 175,
  });
  assert.equal(typeof cache.cacheLogId, 'number', 'cacheLogId = cache_logs.id');
  assert.equal(typeof cache.createdAt, 'number');
});

test('③ 详情 data.cache：未命中 reason 四分支（miss-low 池空 / miss-low 低相似 / miss-gray / miss-tie / miss-focus）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  seedTrace(store, TRACE_MISS_LOW_EMPTY, cachePayload({ hit: false, similarity: null, nearestQuery: null, tieHits: null }));
  seedTrace(store, TRACE_MISS_LOW, cachePayload({ hit: false, similarity: 0.716 }));
  seedTrace(store, TRACE_GRAY, cachePayload({ hit: false, similarity: 0.8512 }));
  seedTrace(store, TRACE_TIE, cachePayload({ hit: false, similarity: 0.955, tieHits: 2 }));
  seedTrace(store, TRACE_FOCUS, cachePayload({ hit: false, similarity: 0.955, tieHits: 1 }));
  const baseUrl = await startLogsApi(t, store);

  const cases: Array<{ trace: string; expected: string; sim: number | null }> = [
    { trace: TRACE_MISS_LOW_EMPTY, expected: 'miss-low', sim: null },
    { trace: TRACE_MISS_LOW, expected: 'miss-low', sim: 0.716 },
    { trace: TRACE_GRAY, expected: 'miss-gray', sim: 0.8512 },
    { trace: TRACE_TIE, expected: 'miss-tie', sim: 0.955 },
    { trace: TRACE_FOCUS, expected: 'miss-focus', sim: 0.955 },
  ];
  for (const c of cases) {
    const { body } = await get(baseUrl, `/api/v1/logs/${c.trace}`);
    assert.equal(body.data.cache.reason, c.expected, `${c.trace} reason=${c.expected}`);
    assert.equal(body.data.cache.hit, false);
    assert.equal(body.data.cache.similarity, c.sim);
  }
});

test('④ 列表 cacheHit：1=命中 / 0=未命中 / null=无行（LEFT JOIN 派生口径，验收 15 旁路行归 null）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  seedTrace(store, TRACE_HIT, cachePayload());
  seedTrace(store, TRACE_GRAY, cachePayload({ hit: false, similarity: 0.8512 }));
  seedTrace(store, TRACE_NO_CACHE);
  store.flush();
  const baseUrl = await startLogsApi(t, store);

  const { body } = await get(baseUrl, '/api/v1/logs');
  assert.equal(body.data.total, 3);
  // TS7 下 Map 推断收窄为 unknown，显式类型实参（列表行含 cacheHit + 原列表字段）
  const byTrace = new Map<string, { traceId: string; cacheHit: 1 | 0 | null; domain?: string; durations: { cacheLookupMs: number | null } }>(
    body.data.list.map((row: { traceId: string; cacheHit: 1 | 0 | null; domain?: string; durations: { cacheLookupMs: number | null } }) => [row.traceId, row])
  );
  assert.equal(byTrace.get(TRACE_HIT)?.cacheHit, 1, '命中行 → 1');
  assert.equal(byTrace.get(TRACE_GRAY)?.cacheHit, 0, '未命中行 → 0');
  assert.equal(byTrace.get(TRACE_NO_CACHE)?.cacheHit, null, '无判定行 → null');
  assert.equal(byTrace.get(TRACE_HIT)?.durations.cacheLookupMs, 175, '命中行 cacheLookupMs 透出（验收第七批）');
  assert.equal(byTrace.get(TRACE_GRAY)?.durations.cacheLookupMs, 175, '未命中行 cacheLookupMs 同样透出');
  assert.equal(byTrace.get(TRACE_NO_CACHE)?.durations.cacheLookupMs, null, '无 cache_logs 行的历史请求 → null');
  assert.equal(byTrace.get(TRACE_HIT)?.domain, 'sango-novel', '列表原字段保留');
});

test('⑤ 详情 data.cache.marked：标记后 true（误判标记在命中解释可见，§3.9 / §3.10 联动）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  seedTrace(store, TRACE_HIT, cachePayload());
  const record = store.queryCacheLogByTrace(TRACE_HIT)!;
  store.updateCacheLogMark(record.id, true, '巡检员');
  const baseUrl = await startLogsApi(t, store);

  const { body } = await get(baseUrl, `/api/v1/logs/${TRACE_HIT}`);
  assert.equal(body.data.cache.marked, true, '命中解释带误判标记位');
  assert.equal(body.data.cache.reason, 'hit');
});

test('⑥ 详情 data.cache.lookupMs：落库值透出 / null（未采集）→ null（验收第七批：耗时归因拆「缓存判定」）', async (t) => {
  const store = createLogStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  seedTrace(store, TRACE_HIT, cachePayload({ lookupMs: 3427 }));
  seedTrace(store, TRACE_GRAY, cachePayload({ hit: false, similarity: 0.8512, lookupMs: null }));
  store.flush();
  const baseUrl = await startLogsApi(t, store);

  const hit = await get(baseUrl, `/api/v1/logs/${TRACE_HIT}`);
  assert.equal(hit.status, 200);
  assert.equal(hit.body.data.cache.lookupMs, 3427, '落库 lookupMs 原样透出');

  const noLookup = await get(baseUrl, `/api/v1/logs/${TRACE_GRAY}`);
  assert.equal(noLookup.body.data.cache.lookupMs, null, 'null（未采集）→ null');
  assert.equal(noLookup.body.data.cache.reason, 'miss-gray', '原有字段不受影响');
});
