// feat-A007 日志查询接口（/api/v1/logs*）：列表 / 明细 / 补报 / token 统计。
// 信封 { code, data, message }、分页、错误码与路由顺序以 api/feat-A007-log-tracking.md 为准。
// 本组接口自身不落日志（防递归，server.ts 只在 /api/chat 埋点）。
import { Router, type Request, type Response } from 'express';
import type { LogStore } from '../../storage/logs.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUERY_ERROR_MESSAGE = '查询日志失败，请稍后重试';
const STATS_ERROR_MESSAGE = '查询统计失败，请稍后重试';

function sendError(response: Response, code: number, message: string): void {
  response.status(code).json({ code, data: null, message });
}

/** 合法非负整数 → number；参数缺失 → undefined；非法 → null */
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

export function createLogsApi(logStore: LogStore): Router {
  const router = Router();

  // GET /api/v1/logs —— 列表（分页 + 过滤）
  router.get('/', (request: Request, response: Response) => {
    try {
      const pageNoRaw = parseQueryInteger(request.query.pageNo);
      const pageSizeRaw = parseQueryInteger(request.query.pageSize);
      const startAtRaw = parseQueryInteger(request.query.startAt);
      const endAtRaw = parseQueryInteger(request.query.endAt);
      const responseCodeRaw = parseQueryInteger(request.query.responseCode);

      if (
        pageNoRaw === null ||
        pageSizeRaw === null ||
        startAtRaw === null ||
        endAtRaw === null ||
        responseCodeRaw === null ||
        (pageNoRaw !== undefined && pageNoRaw < 1)
      ) {
        sendError(response, 400, '分页参数非法');
        return;
      }

      const status = parseQueryString(request.query.status);
      if (status !== undefined && status !== 'success' && status !== 'failed') {
        sendError(response, 400, 'status 只支持 success/failed');
        return;
      }

      const domain = parseQueryString(request.query.domain);
      if (domain !== undefined && domain !== 'weather' && domain !== 'fengyunsanguo' && domain !== 'sango-novel') {
        sendError(response, 400, 'domain 只支持 weather/fengyunsanguo/sango-novel');
        return;
      }

      const pageNo = pageNoRaw ?? 1;
      const pageSizeRawClamped = pageSizeRaw ?? 20;
      const pageSize = Math.min(100, Math.max(1, pageSizeRawClamped));

      const result = logStore.queryList({
        pageNo,
        pageSize,
        logType: parseQueryString(request.query.logType),
        traceId: parseQueryString(request.query.traceId),
        startAt: startAtRaw,
        endAt: endAtRaw,
        status,
        responseCode: responseCodeRaw,
        keyword: parseQueryString(request.query.keyword),
        domain,
      });

      response.json({
        code: 200,
        data: { list: result.list, total: result.total, pageNo, pageSize },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query logs:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/logs/token-stats —— Token 图表（必须在 /:traceId 之前注册，否则被通配参数吞掉）
  router.get('/token-stats', (request: Request, response: Response) => {
    try {
      const startAt = parseQueryInteger(request.query.startAt);
      const endAt = parseQueryInteger(request.query.endAt);
      if (startAt === undefined || endAt === undefined || startAt === null || endAt === null) {
        sendError(response, 400, 'startAt/endAt 必填且为毫秒时间戳');
        return;
      }
      if (startAt > endAt) {
        sendError(response, 400, 'startAt/endAt 必填且为毫秒时间戳');
        return;
      }

      const granularityRaw = parseQueryString(request.query.granularity) ?? 'day';
      if (granularityRaw !== 'day' && granularityRaw !== 'hour') {
        sendError(response, 400, 'granularity 只支持 day/hour');
        return;
      }

      const data = logStore.queryTokenStats({
        startAt,
        endAt,
        granularity: granularityRaw,
      });
      response.json({ code: 200, data, message: '' });
    } catch (error) {
      console.error('Failed to query token stats:', error);
      sendError(response, 500, STATS_ERROR_MESSAGE);
    }
  });

  // POST /api/v1/logs/:traceId/frontend-end —— 前端补报 t6（traceId 找不到静默 200）
  router.post('/:traceId/frontend-end', (request: Request, response: Response) => {
    try {
      const traceId = request.params.traceId;
      if (typeof traceId !== 'string') {
        sendError(response, 400, 'traceId 格式非法');
        return;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const clientReceivedAt = body.clientReceivedAt;
      if (
        typeof clientReceivedAt !== 'number' ||
        !Number.isSafeInteger(clientReceivedAt) ||
        clientReceivedAt < 0
      ) {
        sendError(response, 400, 'clientReceivedAt 必填且为毫秒时间戳');
        return;
      }
      logStore.reportFrontendEnd(traceId, clientReceivedAt);
      response.json({ code: 200, data: null, message: '' });
    } catch (error) {
      console.error('Failed to report frontend end:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/logs/:traceId —— 明细（主表 + LLM 明细 + 工具明细），最后注册
  router.get('/:traceId', (request: Request, response: Response) => {
    try {
      const traceId = request.params.traceId;
      if (typeof traceId !== 'string' || !UUID_PATTERN.test(traceId)) {
        sendError(response, 400, 'traceId 格式非法');
        return;
      }
      const data = logStore.queryDetail(traceId);
      if (data === null) {
        sendError(response, 404, '日志不存在');
        return;
      }
      response.json({ code: 200, data, message: '' });
    } catch (error) {
      console.error('Failed to query log detail:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  return router;
}

