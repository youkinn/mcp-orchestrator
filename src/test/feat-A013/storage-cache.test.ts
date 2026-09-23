// feat-A013 缓存存储层测试（测试即文档）：覆盖接口文档 §2（两新表全列 / 启动清镜像 / 旧库幂等）、
// §2.4（LogStore 增方法：cache_logs 审计、cache_entries 镜像、灰色区清单、分布桶、误判统计与标记）、
// 验收 10（图表对账）/ 14（误判口径）/ 16（旧库兼容）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createLogStore,
  deriveCacheReason,
  CACHE_DISTRIBUTION_BUCKET_COUNT,
  CACHE_EMBEDDING_BYTES,
  type CacheEntryPayload,
  type CacheLogPayload,
  type CacheLogRecord,
  type LogStore,
} from '../../storage/logs.js';

const TRACE_A = '9f7c0000-0000-4000-8000-0000000000a1';
const TRACE_B = '9f7c0000-0000-4000-8000-0000000000b2';
const TRACE_C = '9f7c0000-0000-4000-8000-0000000000c3';
const TRACE_D = '9f7c0000-0000-4000-8000-0000000000d4';
const TRACE_E = '9f7c0000-0000-4000-8000-0000000000e5';

const HIT_LINE = 0.92;

function cacheLogPayload(overrides: Partial<CacheLogPayload> = {}): CacheLogPayload {
  return {
    userQuery: '义释严颜是怎么回事',
    nearestQuery: '义释严颜的经过',
    similarity: 0.9821,
    hitLine: HIT_LINE,
    hit: true,
    tieHits: 1,
    ...overrides,
  };
}

function entryPayload(overrides: Partial<CacheEntryPayload> = {}): CacheEntryPayload {
  return {
    queryText: '义释严颜是怎么回事',
    embeddingB64: 'aW52YWxpZA==',
    answerJson: '{"answer":"严颜被义释的经过……","citations":[]}',
    answerBytes: 64,
    hitCount: 0,
    lastAccessAt: 3000,
    createdAt: 1000,
    versionTag: 'v1',
    ...overrides,
  };
}

/** 造父行（cache_logs.trace_id 有 FK 引用；appendCacheLog 前的骨架） */
function ensureSkeleton(store: LogStore, traceId: string, at: number): void {
  store.ensureSkeleton('chat', traceId, '问题', 'sango-novel', at);
}

test('① 新库建两表且全列齐（§2.1 / §2.2，列名按 DDL 照抄）；分布桶常量口径', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  // 通过 :memory: 无法另开连接，改走文件库核查表结构
  const dir = mkdtempSync(join(tmpdir(), 'a013-struct-'));
  const dbPath = join(dir, 'logs.db');
  const fileStore = createLogStore({ dbPath });
  fileStore.close();
  const db = new Database(dbPath);
  try {
    const entriesCols = db.prepare(`PRAGMA table_info(cache_entries)`).all() as Array<{ name: string }>;
    const logsCols = db.prepare(`PRAGMA table_info(cache_logs)`).all() as Array<{ name: string }>;
    assert.deepEqual(
      entriesCols.map((c) => c.name),
      ['id', 'query_text', 'embedding_b64', 'answer_json', 'answer_bytes', 'hit_count', 'last_access_at', 'created_at', 'version_tag']
    );
    assert.deepEqual(
      logsCols.map((c) => c.name),
      ['id', 'trace_id', 'user_query', 'nearest_query', 'similarity', 'hit_line', 'hit', 'tie_hits', 'marked', 'marked_by', 'marked_at', 'created_at']
    );
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_cache%' ORDER BY name`).all() as Array<{ name: string }>;
    assert.deepEqual(
      indexes.map((i) => i.name),
      ['idx_cache_entries_last_access', 'idx_cache_logs_created', 'idx_cache_logs_hit_created']
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(CACHE_DISTRIBUTION_BUCKET_COUNT, 50);
  assert.equal(CACHE_EMBEDDING_BYTES, 4096);
});

test('② 启动清镜像：残留 cache_entries 行在打开 store 时被清空（§2.3 启动清镜像，验收 9 / 16）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a013-clear-'));
  const dbPath = join(dir, 'logs.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_text TEXT NOT NULL, embedding_b64 TEXT NOT NULL, answer_json TEXT NOT NULL,
      answer_bytes INTEGER NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0,
      last_access_at INTEGER NOT NULL, created_at INTEGER NOT NULL, version_tag TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO cache_entries
    (query_text, embedding_b64, answer_json, answer_bytes, hit_count, last_access_at, created_at, version_tag)
    VALUES ('残影', 'x', '{}', 2, 1, 1, 1, 'v1')`).run();
  db.close();

  const store = createLogStore({ dbPath });
  assert.equal(store.countCacheEntries(), 0, '启动即清空镜像，防残留展示陈旧数据');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('③ appendCacheLog + queryCacheLogByTrace：全字段读写 / 池空 null 形态 / 重复 trace 幂等 / FK 缺失旁路', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  ensureSkeleton(store, TRACE_A, 1000);
  store.appendCacheLog(TRACE_A, cacheLogPayload());

  const record = store.queryCacheLogByTrace(TRACE_A)!;
  assert.equal(record.traceId, TRACE_A);
  assert.equal(record.userQuery, '义释严颜是怎么回事');
  assert.equal(record.nearestQuery, '义释严颜的经过');
  assert.equal(record.similarity, 0.9821);
  assert.equal(record.hitLine, HIT_LINE);
  assert.equal(record.hit, true);
  assert.equal(record.tieHits, 1);
  assert.equal(record.marked, false);
  assert.equal(record.markedBy, null);
  assert.equal(record.markedAt, null);
  assert.equal(typeof record.createdAt, 'number');

  // 同 trace 二次落库：trace_id 唯一，OR IGNORE 幂等（一个请求至多一行）
  store.appendCacheLog(TRACE_A, cacheLogPayload({ similarity: 0.9911 }));
  const dist = store.queryCacheDistribution(0, Date.now() + 1000);
  assert.equal(dist.totals.totalCount, 1, '重复 trace 不产生第二行');
  assert.equal(store.queryCacheLogByTrace(TRACE_A)!.similarity, 0.9821, '首行保留');

  // 池空形态：similarity / nearestQuery / tieHits = null
  ensureSkeleton(store, TRACE_B, 2000);
  store.appendCacheLog(TRACE_B, cacheLogPayload({ hit: false, similarity: null, nearestQuery: null, tieHits: null }));
  const miss = store.queryCacheLogByTrace(TRACE_B)!;
  assert.equal(miss.hit, false);
  assert.equal(miss.similarity, null);
  assert.equal(miss.nearestQuery, null);
  assert.equal(miss.tieHits, null);

  // FK 父行缺失：旁路静默（不抛异常、不落行）
  store.appendCacheLog('no-such-trace', cacheLogPayload());
  assert.equal(store.queryCacheLogByTrace('no-such-trace'), null);
});

test('④ cache_logs 随 request_logs 级联删除（ON DELETE CASCADE，保留清理口径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a013-cascade-'));
  const dbPath = join(dir, 'logs.db');
  const store = createLogStore({ dbPath });
  ensureSkeleton(store, TRACE_A, 1000);
  store.appendCacheLog(TRACE_A, cacheLogPayload());
  assert.ok(store.queryCacheLogByTrace(TRACE_A));
  // 同库另开连接删父行 → cache_logs 行级联消失
  const db = new Database(dbPath);
  db.prepare(`DELETE FROM request_logs WHERE trace_id = ?`).run(TRACE_A);
  db.close();
  assert.equal(store.queryCacheLogByTrace(TRACE_A), null, '父行删除级联清掉判定审计行');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('⑤ cache_entries 写入 / 局部更新 / 删除 / 计数 / 全量清除（§2.4 镜像方法）', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  const id1 = store.insertCacheEntry(entryPayload({ queryText: '问题一' }));
  const id2 = store.insertCacheEntry(entryPayload({ queryText: '问题二' }));
  assert.equal(id1, 1);
  assert.equal(id2, 2);
  assert.equal(store.countCacheEntries(), 2);

  // 命中计数 + 最后访问刷新（COALESCE 缺省字段保持）
  assert.equal(store.updateCacheEntry(id1!, { hitCount: 3, lastAccessAt: 9999 }), true);
  assert.equal(store.updateCacheEntry(id1!, { hitCount: 4 }), true);
  let list = store.listCacheEntries({ pageNo: 1, pageSize: 20, sortBy: 'lastAccessAt', order: 'desc' });
  const row1 = list.list.find((e) => e.id === id1)!;
  assert.equal(row1.hitCount, 4);
  assert.equal(row1.lastAccessAt, 9999, '未更新的列保持原值');
  assert.equal(row1.answerBytes, 64);
  assert.equal(row1.embeddingBytes, 4096, 'embeddingBytes 常量（1024×4B）');

  // 删除：存在 true / 不存在 false / 重复删 false
  assert.equal(store.deleteCacheEntry(id2!), true);
  assert.equal(store.deleteCacheEntry(id2!), false);
  assert.equal(store.deleteCacheEntry(9999), false);

  // 全量清除返回清除前条数（§3.3 cleared 口径）
  assert.equal(store.countCacheEntries(), 1);
  assert.equal(store.clearCacheEntries(), 1);
  assert.equal(store.countCacheEntries(), 0);
});

test('⑥ listCacheEntries 排序 / 分页（sortBy lastAccessAt|hitCount × asc|desc，§3.5）', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  store.insertCacheEntry(entryPayload({ queryText: 'Q1', hitCount: 1, lastAccessAt: 100 }));
  store.insertCacheEntry(entryPayload({ queryText: 'Q2', hitCount: 5, lastAccessAt: 300 }));
  store.insertCacheEntry(entryPayload({ queryText: 'Q3', hitCount: 3, lastAccessAt: 200 }));

  const byHitsDesc = store.listCacheEntries({ pageNo: 1, pageSize: 20, sortBy: 'hitCount', order: 'desc' });
  assert.deepEqual(byHitsDesc.list.map((e) => e.queryText), ['Q2', 'Q3', 'Q1']);
  const byAccessAsc = store.listCacheEntries({ pageNo: 1, pageSize: 20, sortBy: 'lastAccessAt', order: 'asc' });
  assert.deepEqual(byAccessAsc.list.map((e) => e.queryText), ['Q1', 'Q3', 'Q2']);
  const page = store.listCacheEntries({ pageNo: 2, pageSize: 2, sortBy: 'lastAccessAt', order: 'desc' });
  assert.equal(page.total, 3);
  assert.deepEqual(page.list.map((e) => e.queryText), ['Q1'], '第 2 页只剩 1 条');
});

test('⑦ queryCacheLogs 灰色区清单（§3.8 口径：hit=0 AND 0.80 ≤ sim < hit_line）+ marked 过滤 + 分页', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  const cases: Array<{ trace: string; sim: number | null; hit: boolean; hitLine?: number }> = [
    { trace: TRACE_A, sim: 0.79, hit: false },
    { trace: TRACE_B, sim: 0.8, hit: false },
    { trace: TRACE_C, sim: 0.85, hit: false },
    { trace: TRACE_D, sim: 0.91, hit: false },
    { trace: TRACE_E, sim: 0.95, hit: false },
    { trace: '9f7c0000-0000-4000-8000-0000000000f6', sim: null, hit: false },
    { trace: '9f7c0000-0000-4000-8000-0000000000f7', sim: 0.98, hit: true, hitLine: 0.95 },
  ];
  let at = 1000;
  for (const c of cases) {
    ensureSkeleton(store, c.trace, at);
    store.appendCacheLog(c.trace, cacheLogPayload({ similarity: c.sim, hit: c.hit, hitLine: c.hitLine ?? HIT_LINE, tieHits: c.hit ? 1 : null }));
    at += 1000;
  }

  const all = store.queryCacheLogs({ startAt: 0, endAt: Date.now() + 1000 });
  assert.deepEqual(
    all.list.map((i) => i.traceId),
    [TRACE_D, TRACE_C, TRACE_B],
    '灰色区 = hit=0 且 0.80 ≤ sim < hit_line；0.79 / 0.95 / 池空 / 命中行均排除'
  );
  assert.equal(all.total, 3);
  const item = all.list[0];
  assert.deepEqual(Object.keys(item).sort(), ['cacheLogId', 'createdAt', 'hitLine', 'marked', 'nearestQuery', 'similarity', 'traceId', 'userQuery']);
  assert.equal(item.similarity, 0.91);
  assert.equal(item.marked, false);

  // marked 过滤
  const grayId = store.queryCacheLogs({ startAt: 0, endAt: Date.now() + 1000 }).list[0].cacheLogId;
  store.updateCacheLogMark(grayId, true, '控制台');
  const marked = store.queryCacheLogs({ startAt: 0, endAt: Date.now() + 1000, marked: 'marked' });
  assert.deepEqual(marked.list.map((i) => i.traceId), [TRACE_D]);
  const unmarked = store.queryCacheLogs({ startAt: 0, endAt: Date.now() + 1000, marked: 'unmarked' });
  assert.deepEqual(unmarked.list.map((i) => i.traceId), [TRACE_C, TRACE_B]);

  // 分页
  const page = store.queryCacheLogs({ startAt: 0, endAt: Date.now() + 1000, pageNo: 2, pageSize: 2 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.list.map((i) => i.traceId), [TRACE_B], '第 2 页 1 条');
});

test('⑧ queryCacheDistribution 桶聚合（§3.7：50 桶 / sim=null 落桶 0 / 第 49 桶含 1.0 / Σbuckets == totalCount）', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  const sims: Array<number | null> = [null, 0.019, 0.79, 0.8, 0.85, 0.91, 0.92, 0.98, 1.0];
  sims.forEach((sim, i) => {
    const trace = `9f7c0000-0000-4000-8000-00000000${String(100 + i).padStart(4, '0')}`;
    ensureSkeleton(store, trace, (i + 1) * 1000);
    store.appendCacheLog(trace, cacheLogPayload({ similarity: sim, hit: sim !== null && sim >= HIT_LINE, tieHits: sim !== null && sim >= HIT_LINE ? 1 : null }));
  });

  const result = store.queryCacheDistribution(0, Date.now() + 1000);
  assert.equal(result.buckets.length, 50);
  assert.equal(result.buckets[0].lower, 0);
  assert.equal(result.buckets[0].upper, 0.02);
  assert.equal(result.buckets[45].lower, 0.9);
  assert.equal(result.buckets[49].lower, 0.98);
  assert.equal(result.buckets[49].upper, 1);
  const counts = (i: number) => result.buckets[i].count;
  assert.equal(counts(0), 2, 'sim=null 落桶 0（池空行）+ 0.019');
  assert.equal(counts(39), 1);
  assert.equal(counts(40), 1);
  assert.equal(counts(42), 1);
  assert.equal(counts(45), 1);
  assert.equal(counts(46), 1);
  assert.equal(counts(49), 2, '0.98 与 1.0 均落第 49 桶（含 1.0）');
  const sum = result.buckets.reduce((acc, b) => acc + b.count, 0);
  assert.equal(sum, 9, 'Σ buckets[].count == 区间行数（验收 10 对账）');
  assert.deepEqual(result.totals, {
    lowSimilar: 3,
    grayZone: 3,
    highConfidence: 3,
    totalCount: 9,
  });

  // created_at = 写入时刻（Date.now，存储层落库），区间过滤按 created_at 裁剪；
  // 用未来窗口断言「空」（避免与写入时刻的毫秒级竞态）
  assert.equal(store.queryCacheDistribution(Date.now() + 60000, Date.now() + 120000).totals.totalCount, 0, '未来窗口无行');
  assert.equal(store.queryCacheDistribution(0, Date.now() + 1000).totals.totalCount, 9, '全区间 → 9 行');
});

test('⑨ queryMisjudgeStats 误判口径（§3.9：命中行总数 / 标记误判 / 4 位小数；hitTotal=0 → rate null）', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  const at = (n: number) => 1000 + n;
  ensureSkeleton(store, TRACE_A, at(1));
  store.appendCacheLog(TRACE_A, cacheLogPayload()); // hit=1
  ensureSkeleton(store, TRACE_B, at(2));
  store.appendCacheLog(TRACE_B, cacheLogPayload()); // hit=1
  ensureSkeleton(store, TRACE_C, at(3));
  store.appendCacheLog(TRACE_C, cacheLogPayload()); // hit=1
  ensureSkeleton(store, TRACE_D, at(4));
  store.appendCacheLog(TRACE_D, cacheLogPayload()); // hit=1，随后标记
  ensureSkeleton(store, TRACE_E, at(5));
  store.appendCacheLog(TRACE_E, cacheLogPayload({ hit: false, similarity: 0.85 })); // hit=0（不计入）

  const first = store.queryCacheLogByTrace(TRACE_A)!;
  const fourth = store.queryCacheLogByTrace(TRACE_D)!;
  store.updateCacheLogMark(fourth.id, true, '测试员');

  const stats = store.queryMisjudgeStats(0, Date.now() + 1000);
  assert.equal(stats.hitTotal, 4);
  assert.equal(stats.markedMisjudge, 1);
  assert.equal(stats.misjudgeRate, 0.25);

  // 时间窗口裁剪 → 空命中
  const empty = store.queryMisjudgeStats(1, first.createdAt - 1);
  assert.deepEqual(empty, { hitTotal: 0, markedMisjudge: 0, misjudgeRate: null }, 'hitTotal=0 → rate null');
});

test('⑩ updateCacheLogMark 标记 / 取消（幂等；不存在 → false 供 404）', () => {
  const store = createLogStore({ dbPath: ':memory:' });
  t_after(store);
  ensureSkeleton(store, TRACE_A, 1000);
  store.appendCacheLog(TRACE_A, cacheLogPayload());
  const id = store.queryCacheLogByTrace(TRACE_A)!.id;

  assert.equal(store.updateCacheLogMark(id, true, '控制台'), true);
  let record = store.queryCacheLogByTrace(TRACE_A)!;
  assert.equal(record.marked, true);
  assert.equal(record.markedBy, '控制台');
  assert.equal(typeof record.markedAt, 'number');
  // 已标记再标记：幂等 200（行存在 → true）
  assert.equal(store.updateCacheLogMark(id, true, 'admin'), true);

  assert.equal(store.updateCacheLogMark(id, false, null), true);
  record = store.queryCacheLogByTrace(TRACE_A)!;
  assert.equal(record.marked, false);
  assert.equal(record.markedBy, null, '取消标记同时清 marked_by');
  assert.equal(record.markedAt, null, '取消标记同时清 marked_at');
  // 未标记再取消：幂等 200
  assert.equal(store.updateCacheLogMark(id, false, null), true);
  // 不存在 id → false（404 依据）
  assert.equal(store.updateCacheLogMark(9999, true, 'x'), false);
});

test('⑪ 旧库兼容：无 cache 表的存量库打开幂等建表（验收 16），既有接口不受影响', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a013-legacy-'));
  const dbPath = join(dir, 'logs.db');
  const db = new Database(dbPath);
  // feat-A012 之前的旧 schema（无 cache 两表 / 无 A012 新列）
  db.exec(`
    CREATE TABLE request_logs (
      trace_id TEXT PRIMARY KEY, log_type TEXT NOT NULL, user_input TEXT, domain TEXT,
      status TEXT NOT NULL, response_code INTEGER NOT NULL, error_message TEXT NOT NULL DEFAULT '',
      client_sent_at INTEGER, server_received_at INTEGER NOT NULL, handle_started_at INTEGER,
      server_responded_at INTEGER, client_received_at INTEGER, answer TEXT, citations TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE llm_call_logs (
      trace_id TEXT NOT NULL REFERENCES request_logs(trace_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, stage TEXT NOT NULL, model TEXT NOT NULL,
      request_at INTEGER NOT NULL, response_at INTEGER, request_summary TEXT, response_summary TEXT,
      tool_calls TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER,
      finish_reason TEXT, status TEXT NOT NULL, error_message TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (trace_id, seq)
    );
  `);
  // created_at 用最近时间，避免启动保留清理（30 天）把种子行删掉
  db.prepare(`INSERT INTO request_logs
    (trace_id, log_type, user_input, domain, status, response_code, error_message,
     server_received_at, created_at)
    VALUES ('9f7c0000-0000-4000-8000-0000000000aa', 'chat', '历史问题', 'sango-novel', 'success', 200, '', ?, ?)`)
    .run(Date.now(), Date.now());
  db.close();

  const store = createLogStore({ dbPath });
  assert.equal(store.queryList({}).total, 1, '既有列表接口照常');
  assert.equal(store.queryCacheLogByTrace('9f7c0000-0000-4000-8000-0000000000aa'), null, '历史行无 cache_logs');
  const id = store.insertCacheEntry(entryPayload());
  assert.equal(id, 1, '新表幂等创建后可用');
  store.close();
  // 再次打开幂等（重复建表 / 迁移不报错）
  const reopen = createLogStore({ dbPath });
  assert.equal(reopen.countCacheEntries(), 0, '再次打开启动清镜像又一次生效');
  reopen.close();
  rmSync(dir, { recursive: true, force: true });
});

test('⑫ deriveCacheReason 区间归类（§2.2 / §3.10 枚举：hit / miss-low / miss-gray / miss-tie / miss-focus）', () => {
  const base: Pick<CacheLogRecord, 'hit' | 'similarity' | 'hitLine' | 'tieHits'> = {
    hit: false,
    similarity: null,
    hitLine: HIT_LINE,
    tieHits: null,
  };
  assert.equal(deriveCacheReason({ ...base, hit: true, similarity: 0.9821, tieHits: 1 }), 'hit');
  assert.equal(deriveCacheReason({ ...base, similarity: null }), 'miss-low', '池空（sim=null）');
  assert.equal(deriveCacheReason({ ...base, similarity: 0.716 }), 'miss-low', '< 0.80 低相似');
  assert.equal(deriveCacheReason({ ...base, similarity: 0.8512 }), 'miss-gray', '灰色区');
  assert.equal(deriveCacheReason({ ...base, similarity: 0.955, tieHits: 2 }), 'miss-tie', '歧义');
  assert.equal(deriveCacheReason({ ...base, similarity: 0.955, tieHits: 1 }), 'miss-focus', '焦点拒判');
});

function t_after(store: LogStore): void {
  test.after(() => store.close());
}
