// feat-A013 缓存后台接口（/api/v1/cache*）：开关 / 清除 / 条目明细 / 概览 / 三色分布 / 分布桶明细 / 灰色区 / 误判标记与误判率。
// 契约：api/feat-A013-query-cache.md §3.1~3.11；统一信封 { code, data, message }，错误码 400 / 404 / 500。
// 本组接口自身不落日志（防递归，同 /api/v1/logs*，server.ts 只在 /api/chat 埋点）。
// cache_logs 读写直走 LogStore（§2.4 落库点：mark 更新 / 分布 / 灰色区 / 误判率数据源）；
// 池子状态（status / clear / entries / overview）走 CacheManager（小胡 src/cache.ts 实现，本文件只调用）。
import { Router, type Request, type Response } from 'express';
import {
  getLogStore,
  CACHE_DISTRIBUTION_BUCKET_WIDTH,
  CACHE_DISTRIBUTION_BUCKET_COUNT,
  type LogStore,
} from '../../storage/logs.js';

const MARK_DEFAULT_USER = '控制台';
const QUERY_ERROR_MESSAGE = '查询缓存失败，请稍后重试';
const OPERATE_ERROR_MESSAGE = '操作缓存失败，请稍后重试';
const STATS_ERROR_MESSAGE = '查询统计失败，请稍后重试';
const MISJUDGE_NOTE =
  '误判率 = 区间标记误判数 / 区间命中总数；未标记不计为正确；hitTotal=0 时 rate 为 null';

/** feat-A013：缓存池状态（§3.1 / §3.2 返回形状）。 */
export interface CacheStatus {
  enabled: boolean;
  hitLine: number;
  maxEntries: number;
  entryCount: number;
}

/** feat-A013：条目明细行（§3.5 载荷纪律：不含 embedding 与答案全文）。 */
export interface CacheEntryDetail {
  id: number;
  queryText: string;
  answerBytes: number;
  embeddingBytes: number;
  hitCount: number;
  lastAccessAt: number;
  createdAt: number;
}

/** feat-A013：缓存概览（§3.6 口径可复算）。 */
export interface CacheOverview {
  enabled: boolean;
  hitLine: number;
  maxEntries: number;
  entryCount: number;
  answerBytesTotal: number;
  embeddingBytesTotal: number;
  approximateBytes: number;
  avgAnswerBytes: number;
}

/**
 * feat-A013：CacheManager 统一接口（src/cache.ts 由小胡实现，本文件只调用、不实现）。
 * 形状为唯一契约（接口文档 §2.4 / 任务分工）；实现侧结构兼容即可，无需 import 本类型。
 */
export interface CacheManager {
  getStatus(): CacheStatus;
  setEnabled(enabled: boolean): CacheStatus;
  /** 命中线（§1.3 / §3.2 PUT hit-line）：0 < value ≤ 1；非法返回 NaN（调用方 400） */
  setHitLine(value: number): number;
  clearAll(): { cleared: number };
  deleteEntry(id: number): boolean;
  listEntries(options: {
    pageNo: number;
    pageSize: number;
    sortBy: 'lastAccessAt' | 'hitCount';
    order: 'asc' | 'desc';
  }): { list: CacheEntryDetail[]; total: number };
  getOverview(): CacheOverview;
}

function sendError(response: Response, code: number, message: string): void {
  response.status(code).json({ code, data: null, message });
}

/** 合法非负整数 → number；参数缺失 → undefined；非法 → null（同 logs.ts 口径） */
function parseQueryInteger(raw: unknown): number | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return null;
  }
  const num = Number(raw.trim());
  return Number.isSafeInteger(num) ? num : null;
}

function parseQueryString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** §3.8 灰色区区间过滤：similarityMin / similarityMax（可选、可单传）。合法数字且 0~1 → number；缺失 / 空串 → undefined；非法 → null（400 点名参数） */
function parseSimilarityValue(raw: unknown): number | undefined | null {
  const text = parseQueryString(raw);
  if (text === undefined) {
    return undefined;
  }
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return null;
  }
  const num = Number(text);
  return num >= 0 && num <= 1 ? num : null;
}

/** §3.7 / §3.8 / §3.9 / §3.11：startAt / endAt 必填毫秒时间戳且 startAt ≤ endAt（校验同 token-stats）；否则 null（400） */
function parseRange(query: Request['query']): { startAt: number; endAt: number } | null {
  const startAt = parseQueryInteger(query.startAt);
  const endAt = parseQueryInteger(query.endAt);
  if (startAt === undefined || endAt === undefined || startAt === null || endAt === null) {
    return null;
  }
  if (startAt > endAt) {
    return null;
  }
  return { startAt, endAt };
}

/** §3.5 / §3.8 分页参数：pageNo ≥ 1、pageSize 1~100（默认 1 / 20）；非法 null（400） */
function parsePaging(query: Request['query']): { pageNo: number; pageSize: number } | null {
  const pageNoRaw = parseQueryInteger(query.pageNo);
  const pageSizeRaw = parseQueryInteger(query.pageSize);
  if (
    pageNoRaw === null ||
    pageSizeRaw === null ||
    (pageNoRaw !== undefined && pageNoRaw < 1) ||
    (pageSizeRaw !== undefined && (pageSizeRaw < 1 || pageSizeRaw > 100))
  ) {
    return null;
  }
  return { pageNo: pageNoRaw ?? 1, pageSize: pageSizeRaw ?? 20 };
}

/** §3.4 / §3.9：:id 必须正整数；非法（含 Express 5 数组型 params）→ null（400） */
function parseId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * 创建缓存后台路由。cacheManager 为缓存池（src/cache.ts，小胡实现）；
 * logStore 缺省进程级共享实例（测试可注入 :memory: 隔离 store）。
 */
export function createCacheApi(cacheManager: CacheManager, logStore?: LogStore): Router {
  const store = logStore ?? getLogStore();
  const router = Router();

  // GET /api/v1/cache/status —— 开关与配置状态（§3.1）
  router.get('/status', (_request: Request, response: Response) => {
    try {
      response.json({ code: 200, data: cacheManager.getStatus(), message: '' });
    } catch (error) {
      console.error('Failed to get cache status:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // PUT /api/v1/cache/status —— 开关切换（§3.2；必须 boolean，立即生效，重启回 CACHE_ENABLED 初始值）
  router.put('/status', (request: Request, response: Response) => {
    try {
      const enabled = (request.body ?? {}) as { enabled?: unknown };
      if (typeof enabled.enabled !== 'boolean') {
        sendError(response, 400, 'enabled 必须为布尔值');
        return;
      }
      response.json({ code: 200, data: cacheManager.setEnabled(enabled.enabled), message: '' });
    } catch (error) {
      console.error('Failed to set cache status:', error);
      sendError(response, 500, OPERATE_ERROR_MESSAGE);
    }
  });

  // PUT /api/v1/cache/hit-line —— 命中线调整（§3.2 同等风格；0 < hitLine ≤ 1，立即生效，重启回 CACHE_HIT_LINE 初始值；历史 hit_line 不漂移）
  router.put('/hit-line', (request: Request, response: Response) => {
    try {
      const hitLine = (request.body ?? {}) as { hitLine?: unknown };
      const value = hitLine.hitLine;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
        sendError(response, 400, 'hitLine 必须为 0~1 的数字（0 < hitLine ≤ 1）');
        return;
      }
      const updated = cacheManager.setHitLine(value);
      if (Number.isNaN(updated)) {
        sendError(response, 400, 'hitLine 必须为 0~1 的数字（0 < hitLine ≤ 1）');
        return;
      }
      response.json({ code: 200, data: { hitLine: updated }, message: '' });
    } catch (error) {
      console.error('Failed to set cache hit line:', error);
      sendError(response, 500, OPERATE_ERROR_MESSAGE);
    }
  });

  // POST /api/v1/cache/clear —— 全量清除（§3.3；cleared = 清除前条目数；cache_logs 不动）
  router.post('/clear', (_request: Request, response: Response) => {
    try {
      response.json({ code: 200, data: cacheManager.clearAll(), message: '' });
    } catch (error) {
      console.error('Failed to clear cache:', error);
      sendError(response, 500, OPERATE_ERROR_MESSAGE);
    }
  });

  // DELETE /api/v1/cache/entries/:id —— 单条删除（§3.4；立即生效，仅该条目失效）
  router.delete('/entries/:id', (request: Request, response: Response) => {
    try {
      const id = parseId(request.params.id);
      if (id === null) {
        sendError(response, 400, 'id 非法');
        return;
      }
      if (!cacheManager.deleteEntry(id)) {
        sendError(response, 404, '缓存条目不存在');
        return;
      }
      response.json({ code: 200, data: { deleted: true }, message: '' });
    } catch (error) {
      console.error('Failed to delete cache entry:', error);
      sendError(response, 500, OPERATE_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/entries/:id/hits —— 缓存条目命中记录（§3.12；命中该条目的请求 = hit=1 且 nearest_query = 条目 query_text）
  router.get('/entries/:id/hits', (request: Request, response: Response) => {
    try {
      const id = parseId(request.params.id);
      if (id === null) {
        sendError(response, 400, 'id 非法');
        return;
      }
      const paging = parsePaging(request.query);
      if (paging === null) {
        sendError(response, 400, '分页参数非法');
        return;
      }
      const result = store.queryEntryHits(id, paging.pageNo, paging.pageSize);
      if (result === null) {
        sendError(response, 404, '缓存条目不存在');
        return;
      }
      response.json({
        code: 200,
        data: {
          list: result.list,
          total: result.total,
          pageNo: paging.pageNo,
          pageSize: paging.pageSize,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query entry hits:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/entries —— 条目明细（分页，§3.5）
  router.get('/entries', (request: Request, response: Response) => {
    try {
      const paging = parsePaging(request.query);
      if (paging === null) {
        sendError(response, 400, '分页参数非法');
        return;
      }
      const sortByRaw = parseQueryString(request.query.sortBy) ?? 'lastAccessAt';
      const orderRaw = parseQueryString(request.query.order) ?? 'desc';
      if (sortByRaw !== 'lastAccessAt' && sortByRaw !== 'hitCount') {
        sendError(response, 400, 'sortBy 只支持 lastAccessAt/hitCount');
        return;
      }
      if (orderRaw !== 'asc' && orderRaw !== 'desc') {
        sendError(response, 400, 'order 只支持 asc/desc');
        return;
      }
      const result = cacheManager.listEntries({
        pageNo: paging.pageNo,
        pageSize: paging.pageSize,
        sortBy: sortByRaw,
        order: orderRaw,
      });
      response.json({
        code: 200,
        data: {
          list: result.list,
          total: result.total,
          pageNo: paging.pageNo,
          pageSize: paging.pageSize,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to list cache entries:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/overview —— 缓存概览（§3.6；口径可复算）
  router.get('/overview', (_request: Request, response: Response) => {
    try {
      response.json({ code: 200, data: cacheManager.getOverview(), message: '' });
    } catch (error) {
      console.error('Failed to get cache overview:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/stats/similarity-distribution —— 三色分布图表（§3.7；数据源恒为 cache_logs）
  router.get('/stats/similarity-distribution', (request: Request, response: Response) => {
    try {
      const range = parseRange(request.query);
      if (range === null) {
        sendError(response, 400, 'startAt/endAt 必填且为毫秒时间戳');
        return;
      }
      const distribution = store.queryCacheDistribution(range.startAt, range.endAt);
      response.json({
        code: 200,
        data: {
          hitLine: cacheManager.getStatus().hitLine,
          bucketWidth: CACHE_DISTRIBUTION_BUCKET_WIDTH,
          bucketCount: CACHE_DISTRIBUTION_BUCKET_COUNT,
          buckets: distribution.buckets,
          totals: distribution.totals,
          startAt: range.startAt,
          endAt: range.endAt,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query cache distribution:', error);
      sendError(response, 500, STATS_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/stats/similarity-rows —— 分布桶明细（§3.11；柱形点击下钻数据源，同本组接口不落日志）
  router.get('/stats/similarity-rows', (request: Request, response: Response) => {
    try {
      const range = parseRange(request.query);
      if (range === null) {
        sendError(response, 400, 'startAt/endAt 必填且为毫秒时间戳');
        return;
      }
      const paging = parsePaging(request.query);
      if (paging === null) {
        sendError(response, 400, '分页参数非法');
        return;
      }
      const bucketIndexRaw = parseQueryInteger(request.query.bucketIndex);
      if (
        bucketIndexRaw === null ||
        (bucketIndexRaw !== undefined &&
          (bucketIndexRaw < 0 || bucketIndexRaw > CACHE_DISTRIBUTION_BUCKET_COUNT - 1))
      ) {
        sendError(response, 400, 'bucketIndex 必须为 0~49 的整数');
        return;
      }
      const bucketIndex = bucketIndexRaw ?? 0;
      const result = store.querySimilarityRows({
        startAt: range.startAt,
        endAt: range.endAt,
        bucketIndex,
        pageNo: paging.pageNo,
        pageSize: paging.pageSize,
      });
      response.json({
        code: 200,
        data: {
          list: result.list,
          total: result.total,
          pageNo: paging.pageNo,
          pageSize: paging.pageSize,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query similarity rows:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/grayzone —— 灰色区 query 对明细（§3.8；hit=0 AND 0.80 ≤ sim < hit_line）
  router.get('/grayzone', (request: Request, response: Response) => {
    try {
      const range = parseRange(request.query);
      if (range === null) {
        sendError(response, 400, 'startAt/endAt 必填且为毫秒时间戳');
        return;
      }
      const paging = parsePaging(request.query);
      if (paging === null) {
        sendError(response, 400, '分页参数非法');
        return;
      }
      const markedRaw = parseQueryString(request.query.marked) ?? 'all';
      if (markedRaw !== 'all' && markedRaw !== 'marked' && markedRaw !== 'unmarked') {
        sendError(response, 400, 'marked 只支持 all/marked/unmarked');
        return;
      }
      const similarityMin = parseSimilarityValue(request.query.similarityMin);
      if (similarityMin === null) {
        sendError(response, 400, 'similarityMin 须为 0~1 的数字');
        return;
      }
      const similarityMax = parseSimilarityValue(request.query.similarityMax);
      if (similarityMax === null) {
        sendError(response, 400, 'similarityMax 须为 0~1 的数字');
        return;
      }
      if (similarityMin !== undefined && similarityMax !== undefined && similarityMin > similarityMax) {
        sendError(response, 400, 'similarityMin 不能大于 similarityMax');
        return;
      }
      const result = store.queryCacheLogs({
        startAt: range.startAt,
        endAt: range.endAt,
        marked: markedRaw,
        similarityMin,
        similarityMax,
        pageNo: paging.pageNo,
        pageSize: paging.pageSize,
      });
      response.json({
        code: 200,
        data: {
          list: result.list,
          total: result.total,
          pageNo: paging.pageNo,
          pageSize: paging.pageSize,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query grayzone list:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // POST /api/v1/cache/records/:id/mark —— 标记误判（§3.9；缺省「控制台」；已标记幂等 200）
  router.post('/records/:id/mark', (request: Request, response: Response) => {
    try {
      const id = parseId(request.params.id);
      if (id === null) {
        sendError(response, 400, 'id 非法');
        return;
      }
      const body = (request.body ?? {}) as { markedBy?: unknown };
      if (body.markedBy !== undefined && typeof body.markedBy !== 'string') {
        sendError(response, 400, 'markedBy 必须为字符串');
        return;
      }
      const markedBy =
        typeof body.markedBy === 'string' && body.markedBy.trim() !== ''
          ? body.markedBy.trim()
          : MARK_DEFAULT_USER;
      if (!store.updateCacheLogMark(id, true, markedBy)) {
        sendError(response, 404, '缓存记录不存在');
        return;
      }
      response.json({ code: 200, data: { marked: true }, message: '' });
    } catch (error) {
      console.error('Failed to mark cache misjudge:', error);
      sendError(response, 500, OPERATE_ERROR_MESSAGE);
    }
  });

  // POST /api/v1/cache/records/:id/unmark —— 取消误判标记（§3.9；未标记幂等 200）
  router.post('/records/:id/unmark', (request: Request, response: Response) => {
    try {
      const id = parseId(request.params.id);
      if (id === null) {
        sendError(response, 400, 'id 非法');
        return;
      }
      if (!store.updateCacheLogMark(id, false, null)) {
        sendError(response, 404, '缓存记录不存在');
        return;
      }
      response.json({ code: 200, data: { marked: false }, message: '' });
    } catch (error) {
      console.error('Failed to unmark cache misjudge:', error);
      sendError(response, 500, OPERATE_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/cache/misjudge —— 误判率（§3.9；hitTotal=0 → rate null）
  router.get('/misjudge', (request: Request, response: Response) => {
    try {
      const range = parseRange(request.query);
      if (range === null) {
        sendError(response, 400, 'startAt/endAt 必填且为毫秒时间戳');
        return;
      }
      const stats = store.queryMisjudgeStats(range.startAt, range.endAt);
      response.json({
        code: 200,
        data: { ...stats, note: MISJUDGE_NOTE },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query misjudge stats:', error);
      sendError(response, 500, STATS_ERROR_MESSAGE);
    }
  });

  return router;
}
