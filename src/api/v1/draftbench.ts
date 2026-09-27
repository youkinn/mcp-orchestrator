// feat-A017 草稿台接口（/api/v1/draftbench*，与 /api/v1/logs* 同级挂载，同一 Express 进程）：
// GET /trace/:traceId —— 反查该请求候选 / 注入 chunks（tool_retrieval_logs.diagnostics + request_logs 链路）；
//   preview / segFrom / segTo 由本文按 chunkId 经既有 sango_novel_chapter 通道合成（§10 决策 2，多回合并
//   多次通道调用属实现细节；通道失败按 best-effort 回 null，不因预览降级拖垮拉取主数据）；params 默认带出
//   线上实际值（temperature = llm_call_logs 生成轮末次成功值，缺省 0.7；topK/guarantee/budget = 注入常量；
//   tailFallback 只读）。
// GET /records —— 草稿台发送记录列表（仅 source=draftbench，时间倒序，分页口径同 /api/v1/logs）。
// GET /records/:traceId —— 记录详情（载入 + diff 按 §4.4 重算，单一实现点 computeDraftbenchDiff）。
// DELETE /records/:traceId —— 物理删除该条草稿台记录（仅删 draftbench_records 行；request_logs / llm_call_logs
//   等日志链路保留，删除后日志页仍按正常日志展示该 traceId）。
// 本组接口自身不落日志（防递归，同 /api/v1/logs*）。
import { Router, type Request, type Response } from 'express';
import type { MCPTransport } from '../../transport.js';
import type { ToolCallResult } from '../../types.js';
import {
  INJECT_FRAGMENT_LIMIT,
  INJECT_HEAD_GUARANTEE,
  INJECT_TAIL_FALLBACK_ENABLED,
  INJECT_TOTAL_BUDGET,
  SANGO_NOVEL_SEARCH_TOOL,
  computeDraftbenchDiff,
} from '../../citation.js';
import type {
  DraftbenchRecordChunk,
  DraftbenchRecordParams,
  LogStore,
} from '../../storage/logs.js';
import { SANGO_NOVEL_CHAPTER_TOOL } from './sango.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRACE_NOT_FOUND_MESSAGE = '请求记录不存在';
const RECORD_NOT_FOUND_MESSAGE = '草稿台记录不存在';
const QUERY_ERROR_MESSAGE = '查询草稿台记录失败，请稍后重试';
const DELETE_ERROR_MESSAGE = '删除草稿台记录失败，请稍后重试';
const PREVIEW_MAX_LENGTH = 120;
const DEFAULT_TEMPERATURE = 0.7;
/** §4.2 参数缺省（与生产注入常量同值；记录 / 校验失败行 params 快照缺失时展示用） */
const DEFAULT_PARAMS: DraftbenchRecordParams = {
  temperature: DEFAULT_TEMPERATURE,
  topK: INJECT_FRAGMENT_LIMIT,
  guarantee: INJECT_HEAD_GUARANTEE,
  budget: INJECT_TOTAL_BUDGET,
};

function sendError(response: Response, code: number, message: string): void {
  response.status(code).json({ code, data: null, message });
}

/** 合法非负整数 → number；参数缺失 → undefined；非法 → null（同 logs.ts parseQueryInteger 口径） */
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

interface ChapterEntry {
  chunkId?: unknown;
  text?: unknown;
  segFrom?: unknown;
  segTo?: unknown;
}

interface ChapterPayload {
  chapter: number;
  title: string;
  chunks: ChapterEntry[];
}

/** trace 拉取响应的候选行（§3.1 chunks.candidates；缺失字段一律 null / false 兜底，前端不推断） */
interface TraceCandidateRow {
  chunkId: string | null;
  rank: number;
  chapter: number | null;
  title: string | null;
  segFrom: number | null;
  segTo: number | null;
  preview: string | null;
  injected: boolean;
  cited: boolean;
  sources: string[];
  finalScore: number | null;
}

/** sango_novel_chapter 通道（与 /api/v1/sango 同源直调）；通道失败 / 解析失败 → null（best-effort） */
async function callChapterChannel(
  transport: MCPTransport,
  chapter: number
): Promise<ChapterPayload | null> {
  let result: ToolCallResult;
  try {
    result = await transport.callTool(
      SANGO_NOVEL_CHAPTER_TOOL,
      { chapter },
      { caller: 'server', stage: 'admin' }
    );
  } catch (error) {
    console.error(`Failed to call ${SANGO_NOVEL_CHAPTER_TOOL} (bypass):`, error);
    return null;
  }
  if ((result as { isError?: boolean }).isError === true) {
    return null;
  }
  try {
    const text = result.content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!Array.isArray(parsed.chunks)) {
      return null;
    }
    return {
      chapter: typeof parsed.chapter === 'number' ? parsed.chapter : chapter,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      chunks: parsed.chunks as ChapterEntry[],
    };
  } catch {
    return null;
  }
}

export function createDraftbenchApi(
  logStore: LogStore,
  transport: MCPTransport
): Router {
  const router = Router();

  // GET /api/v1/draftbench/trace/:traceId —— 该请求候选 / 注入 chunks（左栏只读源）
  router.get('/trace/:traceId', async (request: Request, response: Response) => {
    try {
      const traceId = request.params.traceId;
      if (typeof traceId !== 'string' || !UUID_PATTERN.test(traceId)) {
        sendError(response, 400, 'traceId 格式非法');
        return;
      }
      const detail = logStore.queryDetail(traceId);
      if (detail === null) {
        sendError(response, 404, TRACE_NOT_FOUND_MESSAGE);
        return;
      }
      const log = detail.log;
      // 检索诊断：取工具明细内 sango_novel_search 的诊断（历史无诊断行 → null）
      const retrieval = detail.toolCalls.find(
        (call) => call.toolName === SANGO_NOVEL_SEARCH_TOOL
      );
      const diagnostics = retrieval?.diagnostics ?? null;
      const rawCandidates = Array.isArray(diagnostics?.candidates)
        ? (diagnostics.candidates as unknown[])
        : [];
      const funnel = (diagnostics?.funnel ?? {}) as Record<string, unknown>;

      const baseCandidates = rawCandidates
        .map((raw, index) => {
          const record = (raw ?? {}) as Record<string, unknown>;
          return {
            chunkId: typeof record.chunkId === 'string' ? record.chunkId : null,
            // rank 缺失 / 非数字按位置序兜底（历史行无 rank 不炸）
            rank: typeof record.rank === 'number' ? record.rank : index + 1,
            chapter: typeof record.chapter === 'number' ? record.chapter : null,
            title: typeof record.title === 'string' ? record.title : null,
            segFrom: null,
            segTo: null,
            preview: null,
            injected: record.injected === true,
            cited: record.cited === true,
            sources: Array.isArray(record.sources)
              ? record.sources.filter(
                  (value): value is string => typeof value === 'string'
                )
              : [],
            finalScore:
              typeof record.finalScore === 'number' ? record.finalScore : null,
          };
        })
        .sort((a, b) => a.rank - b.rank);

      // §10 决策 2：preview / segFrom / segTo 服务端经 sango_novel_chapter 按 chunkId 合成（多回合并批量通道调用）
      const chapterCache = new Map<number, ChapterPayload | null>();
      const loadChapter = async (
        chapter: number
      ): Promise<ChapterPayload | null> => {
        if (chapterCache.has(chapter)) {
          return chapterCache.get(chapter) ?? null;
        }
        const payload = await callChapterChannel(transport, chapter);
        chapterCache.set(chapter, payload);
        return payload;
      };
      const candidates: TraceCandidateRow[] = [];
      for (const candidate of baseCandidates) {
        if (candidate.chapter === null) {
          candidates.push(candidate);
          continue;
        }
        const payload = await loadChapter(candidate.chapter);
        const entry =
          payload?.chunks.find((chunk) => chunk.chunkId === candidate.chunkId) ??
          null;
        const text = typeof entry?.text === 'string' ? entry.text : '';
        candidates.push({
          ...candidate,
          segFrom: typeof entry?.segFrom === 'number' ? entry.segFrom : null,
          segTo: typeof entry?.segTo === 'number' ? entry.segTo : null,
          preview: text
            ? text.slice(0, PREVIEW_MAX_LENGTH)
            : null,
        });
      }

      const funnelInjected =
        typeof funnel.injected === 'number' ? funnel.injected : 0;
      const funnelCited = typeof funnel.cited === 'number' ? funnel.cited : 0;
      const temperature =
        logStore.queryGenerationTemperature(traceId) ?? DEFAULT_TEMPERATURE;
      response.json({
        code: 200,
        data: {
          traceId,
          userQuery: log.userInput ?? '',
          routeSource: log.routeSource,
          serverReceivedAt: log.serverReceivedAt,
          params: {
            temperature,
            topK: INJECT_FRAGMENT_LIMIT,
            guarantee: INJECT_HEAD_GUARANTEE,
            budget: INJECT_TOTAL_BUDGET,
            tailFallback: INJECT_TAIL_FALLBACK_ENABLED,
          },
          chunks: {
            candidates,
            injectedCount: funnelInjected,
            citedCount: funnelCited,
          },
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query draftbench trace:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/draftbench/records —— 草稿台记录列表（天然只含草稿台，无来源参数）
  router.get('/records', (request: Request, response: Response) => {
    try {
      const pageNoRaw = parseQueryInteger(request.query.pageNo);
      if (pageNoRaw === null || (pageNoRaw !== undefined && pageNoRaw < 1)) {
        sendError(response, 400, '分页参数非法');
        return;
      }
      const pageSizeRaw = parseQueryInteger(request.query.pageSize);
      if (pageSizeRaw === null) {
        sendError(response, 400, '分页参数非法');
        return;
      }
      const pageNo = pageNoRaw ?? 1;
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 20));
      const result = logStore.queryDraftbenchRecords(pageNo, pageSize);
      response.json({
        code: 200,
        data: {
          list: result.list.map((item) => ({
            ...item,
            params: item.params ?? DEFAULT_PARAMS,
          })),
          total: result.total,
          pageNo,
          pageSize,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query draftbench records:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // GET /api/v1/draftbench/records/:traceId —— 记录详情（载入 + diff 重算，§3.4）
  router.get('/records/:traceId', (request: Request, response: Response) => {
    try {
      const traceId = request.params.traceId;
      if (typeof traceId !== 'string' || !UUID_PATTERN.test(traceId)) {
        sendError(response, 400, 'traceId 格式非法');
        return;
      }
      const record = logStore.queryDraftbenchRecord(traceId);
      if (record === null) {
        sendError(response, 404, RECORD_NOT_FOUND_MESSAGE);
        return;
      }
      const citations = record.result?.citations ?? [];
      // §4.4：服务端按引用归属片段单一实现点重算；failed 记录无生成结果，三态恒空
      const diff =
        record.status === 'success'
          ? computeDraftbenchDiff(
              record.citedIndexes,
              record.chunks.length,
              citations
            )
          : { consistent: [], missing: [], extra: [] };
      response.json({
        code: 200,
        data: {
          traceId: record.traceId,
          time: record.time,
          query: record.query,
          status: record.status,
          errorMessage: record.errorMessage,
          params: record.params ?? DEFAULT_PARAMS,
          chunks: record.chunks as DraftbenchRecordChunk[],
          result: record.result,
          diff,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to query draftbench record detail:', error);
      sendError(response, 500, QUERY_ERROR_MESSAGE);
    }
  });

  // DELETE /api/v1/draftbench/records/:traceId —— 物理删除发送记录（§3.6；仅草稿台行，日志链路保留）
  router.delete('/records/:traceId', (request: Request, response: Response) => {
    try {
      const traceId = request.params.traceId;
      if (typeof traceId !== 'string' || !UUID_PATTERN.test(traceId)) {
        sendError(response, 400, 'traceId 格式非法');
        return;
      }
      if (!logStore.deleteDraftbenchRecord(traceId)) {
        sendError(response, 404, RECORD_NOT_FOUND_MESSAGE);
        return;
      }
      response.json({ code: 200, data: { deleted: true }, message: '' });
    } catch (error) {
      console.error('Failed to delete draftbench record:', error);
      sendError(response, 500, DELETE_ERROR_MESSAGE);
    }
  });

  return router;
}
