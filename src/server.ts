import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type {
  Agent,
  ChatData,
  DraftbenchChunk,
  DraftbenchParams,
} from './agent.js';
import type { MCPTransport } from './transport.js';
import { ToolExecutionError, type ToolCallResult } from './types.js';
import { createLogsApi } from './api/v1/logs.js';
import { createDraftbenchApi } from './api/v1/draftbench.js';
import { createSangoApi } from './api/v1/sango.js';
import { createCacheApi, type CacheManager } from './api/v1/cache.js';
import {
  getLogStore,
  truncate,
  type DraftbenchRecordChunk,
  type LogStore,
} from './storage/logs.js';
import { runWithTraceId } from './trace.js';

const MAX_MESSAGE_LENGTH = 300;
// feat-A017 §3.2：白名单扩 source / chunks / params（草稿台请求级参数覆盖；生产字段不在其内）
const CHAT_ALLOWED_KEYS = ['message', 'domain', 'source', 'chunks', 'params'];
const CHAT_ALLOWED_LABEL = 'message、domain、source、chunks、params';
// feat-A011 天气下线：/api/chat 校验移除 weather（日志过滤枚举保留 weather，见 api/v1/logs.ts）
const CHAT_ALLOWED_DOMAINS = ['fengyunsanguo', 'sango-novel'];
const RANDOM_ALLOWED_KEYS = ['message', 'sessionId'];
const RANDOM_ALLOWED_LABEL = 'message、sessionId';
const CHAT_ALLOWED_SOURCES = ['production', 'draftbench'] as const;
const DRAFTBENCH_CHUNK_LIMIT = 20;
const DRAFTBENCH_CHUNK_TEXT_LIMIT = 2000;
const DRAFTBENCH_BUDGET_LIMIT = 20000;
const DEFAULT_TEMPERATURE = 0.1;

interface ParsedBody {
  message: string;
  sessionId?: string;
  domain?: string;
  /** feat-A017：发送来源（缺省 production；draftbench 走草稿台管线） */
  source?: 'production' | 'draftbench';
  /** feat-A017：草稿台发送清单（仅 source=draftbench 合法，§4.1） */
  chunks?: DraftbenchChunk[];
  /** feat-A017：本次请求级参数覆盖（仅 source=draftbench 合法，§4.2） */
  params?: DraftbenchParams;
}

type BodyParseResult =
  | { ok: true; value: ParsedBody }
  | { ok: false; code: number; message: string };

/** §4.1 发送清单校验：非数组 / 空数组 / 超 20 条 / 条目与字段类型 / 文本长度，全部 400 明细 */
function validateDraftbenchChunks(
  raw: unknown
): { ok: true; value: DraftbenchChunk[] } | { ok: false; code: number; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, code: 400, message: '发送清单不能为空' };
  }
  if (raw.length > DRAFTBENCH_CHUNK_LIMIT) {
    return { ok: false, code: 400, message: '发送清单最多 20 条' };
  }
  const chunks: DraftbenchChunk[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, code: 400, message: '清单条目格式非法' };
    }
    const record = entry as Record<string, unknown>;
    const text = record.text;
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, code: 400, message: '片段文本不能为空' };
    }
    if (text.length > DRAFTBENCH_CHUNK_TEXT_LIMIT) {
      return { ok: false, code: 400, message: '单条片段不能超过 2000 字' };
    }
    if (record.chunkId !== undefined && typeof record.chunkId !== 'string') {
      return { ok: false, code: 400, message: 'chunkId 格式非法' };
    }
    if (
      (record.chapter !== undefined && typeof record.chapter !== 'number') ||
      (record.title !== undefined && typeof record.title !== 'string')
    ) {
      return { ok: false, code: 400, message: '清单条目元数据格式非法' };
    }
    chunks.push({
      text,
      chunkId: typeof record.chunkId === 'string' ? record.chunkId : undefined,
      chapter: typeof record.chapter === 'number' ? record.chapter : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
    });
  }
  return { ok: true, value: chunks };
}

/** §4.2 本次参数校验：字段缺省 = 生产常量（temperature 0.1 / topK 10 / guarantee 5 / budget 2000；
 * guarantee 缺省在 topK 覆写小于 5 时按 min(5, topK) 收敛，避免 0~topK 自相矛盾）；
 * budget 上限 20000（§10 决策 4）。非法全部 400 明细。 */
function validateDraftbenchParams(
  raw: unknown
): { ok: true; value: DraftbenchParams } | { ok: false; code: number; message: string } {
  if (raw === undefined) {
    return {
      ok: true,
      value: {
        temperature: DEFAULT_TEMPERATURE,
        topK: 10,
        guarantee: 5,
        budget: 2000,
      },
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 400, message: 'params 需为对象' };
  }
  const record = raw as Record<string, unknown>;
  const rawTemperature = record.temperature;
  if (
    rawTemperature !== undefined &&
    (typeof rawTemperature !== 'number' ||
      !Number.isFinite(rawTemperature) ||
      rawTemperature < 0 ||
      rawTemperature > 1)
  ) {
    return { ok: false, code: 400, message: 'temperature 需为 0~1 的数字' };
  }
  const rawTopK = record.topK;
  if (
    rawTopK !== undefined &&
    (typeof rawTopK !== 'number' ||
      !Number.isInteger(rawTopK) ||
      rawTopK < 1 ||
      rawTopK > 20)
  ) {
    return { ok: false, code: 400, message: 'topK 需为 1~20 的整数' };
  }
  const topK = rawTopK === undefined ? 10 : rawTopK;
  const rawGuarantee = record.guarantee;
  if (
    rawGuarantee !== undefined &&
    (typeof rawGuarantee !== 'number' ||
      !Number.isInteger(rawGuarantee) ||
      rawGuarantee < 0 ||
      rawGuarantee > topK)
  ) {
    return { ok: false, code: 400, message: 'guarantee 需为 0~topK 的整数' };
  }
  const rawBudget = record.budget;
  if (
    rawBudget !== undefined &&
    (typeof rawBudget !== 'number' ||
      !Number.isInteger(rawBudget) ||
      rawBudget < 1 ||
      rawBudget > DRAFTBENCH_BUDGET_LIMIT)
  ) {
    return { ok: false, code: 400, message: 'budget 需为 1~20000 的整数' };
  }
  return {
    ok: true,
    value: {
      temperature:
        rawTemperature === undefined ? DEFAULT_TEMPERATURE : rawTemperature,
      topK,
      guarantee:
        rawGuarantee === undefined ? Math.min(5, topK) : rawGuarantee,
      budget: rawBudget === undefined ? 2000 : rawBudget,
    },
  };
}

/** 严格白名单 + message 规则，/api/chat 与 /api/sango/random 共用 */
function parseBody(
  body: Record<string, unknown>,
  allowedKeys: string[],
  allowedLabel: string
): BodyParseResult {
  const invalidKeys = Object.keys(body).filter(
    (key) => !allowedKeys.includes(key)
  );
  if (invalidKeys.length > 0) {
    return {
      ok: false,
      code: 400,
      message: `请求体只支持 ${allowedLabel} 字段，收到无效字段：${invalidKeys.join('、')}`,
    };
  }

  const raw = body.message;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, code: 400, message: 'message 不能为空' };
  }
  if (raw.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, code: 413, message: '消息不能超过 300 字符' };
  }

  // feat-A017 §3.2：来源校验（缺省 production；非法 400）
  const rawSource = body.source;
  if (
    rawSource !== undefined &&
    (typeof rawSource !== 'string' ||
      !CHAT_ALLOWED_SOURCES.includes(rawSource as 'production'))
  ) {
    return { ok: false, code: 400, message: 'source 只支持 production/draftbench' };
  }
  const source: 'production' | 'draftbench' =
    rawSource === 'draftbench' ? 'draftbench' : 'production';

  const rawDomain = body.domain;
  if (
    source === 'draftbench'
      ? rawDomain !== 'sango-novel'
      : rawDomain !== undefined &&
        (typeof rawDomain !== 'string' ||
          !CHAT_ALLOWED_DOMAINS.includes(rawDomain))
  ) {
    return {
      ok: false,
      code: 400,
      message:
        source === 'draftbench'
          ? 'domain 字段仅支持 sango-novel（草稿台发送锁定原著域）'
          : `domain 字段仅支持 ${CHAT_ALLOWED_DOMAINS.join('、')}`
    };
  }

  const session = body.sessionId;
  let chunks: DraftbenchChunk[] | undefined;
  let params: DraftbenchParams | undefined;
  if (source === 'draftbench') {
    // 草稿台：chunks 必填；chunks / params 非法 → 400 明细（§4.1 / §4.2）
    const chunksResult = validateDraftbenchChunks(body.chunks);
    if (!chunksResult.ok) {
      return chunksResult;
    }
    chunks = chunksResult.value;
    const paramsResult = validateDraftbenchParams(body.params);
    if (!paramsResult.ok) {
      return paramsResult;
    }
    params = paramsResult.value;
  } else if (body.chunks !== undefined || body.params !== undefined) {
    // 生产发送不得携带草稿台字段（契约：仅 source=draftbench 合法，否则 400）
    return {
      ok: false,
      code: 400,
      message: 'chunks/params 仅支持草稿台（source=draftbench）发送',
    };
  }

  return {
    ok: true,
    value: {
      message: raw.trim(),
      domain:
        typeof rawDomain === 'string' &&
        (source === 'draftbench'
          ? rawDomain === 'sango-novel'
          : CHAT_ALLOWED_DOMAINS.includes(rawDomain))
          ? rawDomain
          : undefined,
      source,
      chunks,
      params,
      sessionId:
        typeof session === 'string' && session.trim()
          ? session.trim()
          : undefined,
    },
  };
}

function sendError(response: Response, code: number, message: string) {
  response.status(code).json({ code, data: null, message });
}

/** 埋点旁路：日志写失败只告警，绝不影响 POST 路由主流程与响应 */
function trySafe(run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error('Log write failed (bypassed):', error);
  }
}

/** 请求体 → 主表 domain；/api/chat 取请求体 domain，/api/sango/random 固定 fengyunsanguo */
type TraceDomainResolver = (body: Record<string, unknown>) => string | null;
/** 请求体 → 主表来源标记（feat-A017；/api/chat 取请求体 source，其余不传 → null） */
type TraceSourceResolver = (body: Record<string, unknown>) => string | null;

/** 全链路埋点中间件（t1 骨架）：读 X-Trace-Id（缺失兜底生成并回写响应头）、
 * X-Client-Sent-At；ensureSkeleton 在业务校验 / 入队之前执行（400 / 413 也落库）；
 * logType / domain 由调用方给定（chat 取请求体 domain，quiz 固定 fengyunsanguo）；
 * runWithTraceId 包裹后续处理供 agent / transport 明细埋点取用 */
function tracingMiddleware(
  logStore: LogStore,
  logType: string,
  resolveDomain: TraceDomainResolver,
  resolveSource?: TraceSourceResolver
): RequestHandler {
  return (request, response, next) => {
    const rawTraceId = request.header('X-Trace-Id');
    const traceId =
      typeof rawTraceId === 'string' && rawTraceId.trim() !== ''
        ? rawTraceId.trim()
        : randomUUID();
    // 兜底生成的 traceId 必须随响应头返回，前端补报以服务端为准（X-Trace-Id）
    response.setHeader('X-Trace-Id', traceId);

    const rawSentAt = request.header('X-Client-Sent-At');
    const clientSentAt =
      typeof rawSentAt === 'string' && /^\d+$/.test(rawSentAt.trim())
        ? Number(rawSentAt.trim())
        : null;

    const body = (request.body ?? {}) as Record<string, unknown>;
    trySafe(() =>
      logStore.ensureSkeleton(
        logType,
        traceId,
        typeof body.message === 'string' ? body.message : null,
        resolveDomain(body),
        Date.now(),
        clientSentAt,
        resolveSource?.(body) ?? null
      )
    );

    runWithTraceId(traceId, () => {
      response.locals.traceId = traceId;
      next();
    });
  };
}

/** 队列 / 编排异常统一映射：503 只由 ToolExecutionError 触发，其余一律 500 */
function processingErrorInfo(error: unknown): { code: number; message: string } {
  const toolUnavailable = error instanceof ToolExecutionError;
  return {
    code: toolUnavailable ? 503 : 500,
    message: toolUnavailable
      ? '工具服务暂不可用，请稍后重试'
      : '处理请求失败，请稍后重试',
  };
}

export function createServer(
  agent: Agent,
  transport: MCPTransport,
  options: { port: number; allowedOrigin: string; logStore?: LogStore; cacheManager?: CacheManager }
) {
  const app = express();
  // feat-A007：日志存储（进程级共享实例；测试可注入隔离 store）
  const logStore = options.logStore ?? getLogStore();
  // 两个 POST 端点共用同一条串行队列，避免 LLM 调用与题库会话读写并发
  let requestQueue = Promise.resolve();

  app.use(
    cors({
      origin: options.allowedOrigin,
      // feat-A007：跨域部署时前端需读取响应头 X-Trace-Id（兜底场景以服务端为准）
      exposedHeaders: ['X-Trace-Id'],
    })
  );
  app.use(express.json({ limit: '32kb' }));

  // feat-A007：v1 日志查询接口独立处理器；/api/v1/logs* 不参与本特性埋点（防递归）
  app.use('/api/v1/logs', createLogsApi(logStore));
  // feat-A010：三国演义原文接口；后台直调器坊 sango_novel_chapter，不参与模型工具装配
  app.use('/api/v1/sango', createSangoApi(transport));
  // feat-A017：草稿台接口（traceId 拉取 / 记录列表与详情）；本组接口自身不落日志（防递归，同 /api/v1/logs*）
  app.use('/api/v1/draftbench', createDraftbenchApi(logStore, transport));
  // feat-A013：缓存后台接口；本组接口自身不落日志（防递归，同 /api/v1/logs*）。
  // cacheManager 由装配层（index.ts）注入 src/cache.ts 实例（小胡实现）；未注入时不挂载路由，
  // 避免 server 层直接依赖尚在分仓开发的 cache.ts（挂载点与实例形状见 api/v1/cache.ts 注释）。
  if (options.cacheManager) {
    app.use('/api/v1/cache', createCacheApi(options.cacheManager, logStore));
  }

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      code: 200,
      data: { status: 'ok', service: 'mcp-orchestrator' },
      message: '',
    });
  });

  // 上报模型实际可见的全部工具；工具集全部来自 MCP server（总台无本地工具）
  app.get('/api/tools', async (_request: Request, response: Response) => {
    try {
      response.json({
        code: 200,
        data: { tools: await agent.listTools() },
        message: '',
      });
    } catch (error) {
      console.error('Failed to list tools:', error);
      sendError(response, 503, 'MCP Server 未连接');
    }
  });

  // 入队执行：队列串行、先到先处理；异常（含 ToolExecutionError）向上抛给调用方映射 500 / 503
  function enqueue<T>(handle: () => T | Promise<T>): Promise<T> {
    const result = requestQueue.then(() => handle());
    requestQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** feat-A017：发送清单 → 落库快照（逐条 chunkId / text / chapter / title，缺失 null） */
  function toDraftbenchChunkSnapshot(
    chunks: DraftbenchChunk[] | undefined
  ): DraftbenchRecordChunk[] {
    if (!Array.isArray(chunks)) {
      return [];
    }
    return chunks.map((chunk) => ({
      chunkId: typeof chunk.chunkId === 'string' ? chunk.chunkId : null,
      text: typeof chunk.text === 'string' ? chunk.text : null,
      chapter: typeof chunk.chapter === 'number' ? chunk.chapter : null,
      title: typeof chunk.title === 'string' ? chunk.title : null,
    }));
  }

  /** feat-A017：校验失败（400 / 413）也落一条草稿台记录（status=failed + errorMessage，§3.2）；
   * 原始请求体的 chunks 未经校验，按防御式形状快照；写入旁路静默 */
  function saveDraftbenchFailedRecord(
    traceId: string,
    rawBody: Record<string, unknown>,
    errorMessage: string
  ): void {
    trySafe(() =>
      logStore.saveDraftbenchRecord({
        traceId,
        time: Date.now(),
        query: typeof rawBody.message === 'string' ? rawBody.message : '',
        params: null,
        chunks: toDraftbenchChunkSnapshot(
          Array.isArray(rawBody.chunks)
            ? (rawBody.chunks as DraftbenchChunk[])
            : undefined
        ),
        citedIndexes: [],
        status: 'failed',
        errorMessage,
        result: null,
      })
    );
  }

  /** feat-A017：草稿台手动发送（§3.2）——不检索、不查 / 不写语义缓存，复用生产 sango-novel 生成 /
   * 校验管线同源实现；响应带 diff（§4.4）与本次生效参数；成功 / 失败都落一条草稿台记录（旁路静默） */
  async function handleDraftbenchSend(
    response: Response,
    parsed: ParsedBody
  ): Promise<void> {
    const traceId = response.locals.traceId as string;
    const receivedAt = Date.now();
    const chunks = parsed.chunks ?? [];
    const params: DraftbenchParams = parsed.params ?? {
      temperature: DEFAULT_TEMPERATURE,
      topK: 10,
      guarantee: 5,
      budget: 2000,
    };
    try {
      const outcome = await enqueue(async () => {
        // 队列出队开始处理：回填 t2（与生产一致）
        trySafe(() => logStore.markHandled(traceId, Date.now()));
        const result = await agent.processDraftbench(
          parsed.message,
          chunks,
          params
        );
        // 响应完成：回填主表 t5 与内容字段（同生产 8000 截断）
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'success',
            200,
            '',
            truncate(result.data.answer) ?? null,
            truncate(JSON.stringify(result.data.citations)) ?? null
          )
        );
        // 草稿台记录：清单快照 + 生效参数快照 + 结果摘要 + 被引用下标（详情页按 §4.4 重算 diff）
        trySafe(() =>
          logStore.saveDraftbenchRecord({
            traceId,
            time: receivedAt,
            query: parsed.message,
            params,
            chunks: toDraftbenchChunkSnapshot(chunks),
            citedIndexes: result.citedIndexes,
            status: 'success',
            errorMessage: '',
            result: {
              answer: result.data.answer,
              citations: result.data.citations,
            },
          })
        );
        return result;
      });
      response.json({
        code: 200,
        data: {
          traceId,
          answer: outcome.data.answer,
          citations: outcome.data.citations,
          params: outcome.params,
          diff: outcome.diff,
        },
        message: '',
      });
    } catch (error) {
      console.error('Failed to process draftbench request:', error);
      const info = processingErrorInfo(error);
      trySafe(() =>
        logStore.markResponded(
          traceId,
          Date.now(),
          'failed',
          info.code,
          info.message,
          null,
          null
        )
      );
      trySafe(() =>
        logStore.saveDraftbenchRecord({
          traceId,
          time: receivedAt,
          query: parsed.message,
          params,
          chunks: toDraftbenchChunkSnapshot(chunks),
          citedIndexes: [],
          status: 'failed',
          errorMessage: info.message,
          result: null,
        })
      );
      sendError(response, info.code, info.message);
    }
  }

  app.post(
    '/api/chat',
    tracingMiddleware(
      logStore,
      'chat',
      (body) => (typeof body.domain === 'string' ? body.domain : null),
      // feat-A017：来源标记随骨架落主表（草稿台行 request_source='draftbench'，生产行保持 NULL）
      (body) => (body.source === 'draftbench' ? 'draftbench' : null)
    ),
    async (request: Request, response: Response) => {
      const traceId = response.locals.traceId as string;
      const rawBody = (request.body ?? {}) as Record<string, unknown>;
      const parsed = parseBody(
        rawBody,
        CHAT_ALLOWED_KEYS,
        CHAT_ALLOWED_LABEL
      );
      if (!parsed.ok) {
        // 校验失败（400 / 413）同样落主表一条：handle_started_at 为 NULL、t5 回填校验失败时刻
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'failed',
            parsed.code,
            parsed.message,
            null,
            null
          )
        );
        // feat-A017：草稿台校验失败也落一条发送记录（status=failed + errorMessage）
        if (rawBody.source === 'draftbench') {
          saveDraftbenchFailedRecord(traceId, rawBody, parsed.message);
        }
        sendError(response, parsed.code, parsed.message);
        return;
      }

      // feat-A017：草稿台手动发送分支（同一 POST /api/chat + 同一串行队列）
      if (parsed.value.source === 'draftbench') {
        await handleDraftbenchSend(response, parsed.value);
        return;
      }

      try {
        const data = await enqueue(() => {
          // 队列出队开始处理：回填 t2（未入队的校验失败请求保持 NULL）
          trySafe(() => logStore.markHandled(traceId, Date.now()));
          return agent.processQueryData(parsed.value.message, parsed.value.domain);
        });

        // 响应完成：回填 t5 与 status / response_code / answer / citations（内容字段 8000 截断）
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'success',
            200,
            '',
            truncate(data.answer) ?? null,
            truncate(JSON.stringify(data.citations)) ?? null
          )
        );
        response.json({ code: 200, data, message: '' });
      } catch (error) {
        // 异常中断兜底：骨架必然已存在（进入本 handler 前 ensureSkeleton），按失败回填
        console.error('Failed to process request:', error);
        const info = processingErrorInfo(error);
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'failed',
            info.code,
            info.message,
            null,
            null
          )
        );
        sendError(response, info.code, info.message);
      }
    }
  );

  app.post(
    '/api/sango/random',
    tracingMiddleware(logStore, 'quiz', () => 'fengyunsanguo'),
    async (request: Request, response: Response) => {
      const traceId = response.locals.traceId as string;
      const parsed = parseBody(
        (request.body ?? {}) as Record<string, unknown>,
        RANDOM_ALLOWED_KEYS,
        RANDOM_ALLOWED_LABEL
      );
      if (!parsed.ok) {
        // 校验失败（400 / 413）同样落主表一条：handle_started_at 为 NULL、t5 回填校验失败时刻
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'failed',
            parsed.code,
            parsed.message,
            null,
            null
          )
        );
        sendError(response, parsed.code, parsed.message);
        return;
      }

      // 确定性命令：薄转发 mcp-server fengyunsanguo_quiz_command（出题 / 判题 / 查答案状态机在 quiz 子进程），
      // 不经 LLM；citations 恒 []（随机一题无原文引用，行为与现状零变化）
      try {
        const data = await enqueue(async () => {
          // 队列出队开始处理：回填 t2（未入队的校验失败请求保持 NULL）
          trySafe(() => logStore.markHandled(traceId, Date.now()));
          // bug-00019：随机一题为后台直调（非对话链路），显式标注 caller=server / stage=admin
          const result = await transport.fengyunsanguo_quiz_command(
            parsed.value.message,
            parsed.value.sessionId,
            { caller: 'server', stage: 'admin' }
          );
          return { answer: toolResultText(result), citations: [] };
        });

        // 响应完成：回填 t5 与 status / response_code / answer / citations（内容字段 8000 截断）
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'success',
            200,
            '',
            truncate(data.answer) ?? null,
            truncate(JSON.stringify(data.citations)) ?? null
          )
        );
        response.json({ code: 200, data, message: '' });
      } catch (error) {
        // 异常中断兜底：骨架必然已存在（进入本 handler 前 ensureSkeleton），按失败回填
        console.error('Failed to process request:', error);
        const info = processingErrorInfo(error);
        trySafe(() =>
          logStore.markResponded(
            traceId,
            Date.now(),
            'failed',
            info.code,
            info.message,
            null,
            null
          )
        );
        sendError(response, info.code, info.message);
      }
    }
  );

  return app;
}

/** 提取工具返回的纯文本（quiz_command 为确定性单文本回复） */
function toolResultText(result: ToolCallResult): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}
