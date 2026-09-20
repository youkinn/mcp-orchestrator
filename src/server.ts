import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, {
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { Agent, ChatData } from './agent.js';
import type { MCPTransport } from './transport.js';
import { ToolExecutionError, type ToolCallResult } from './types.js';
import { createLogsApi } from './api/v1/logs.js';
import {
  getLogStore,
  truncate,
  type LogStore,
} from './storage/logs.js';
import { runWithTraceId } from './trace.js';

const MAX_MESSAGE_LENGTH = 300;
const CHAT_ALLOWED_KEYS = ['message', 'domain'];
const CHAT_ALLOWED_LABEL = 'message、domain';
const CHAT_ALLOWED_DOMAINS = ['fengyunsanguo', 'sango-novel'];
const RANDOM_ALLOWED_KEYS = ['message', 'sessionId'];
const RANDOM_ALLOWED_LABEL = 'message、sessionId';

interface ParsedBody {
  message: string;
  sessionId?: string;
  domain?: string;
}

type BodyParseResult =
  | { ok: true; value: ParsedBody }
  | { ok: false; code: number; message: string };

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

  const rawDomain = body.domain;
  if (
    rawDomain !== undefined &&
    (typeof rawDomain !== 'string' || !CHAT_ALLOWED_DOMAINS.includes(rawDomain))
  ) {
    return {
      ok: false,
      code: 400,
      message: `domain 字段仅支持 ${CHAT_ALLOWED_DOMAINS.join('、')}`
    };
  }

  const session = body.sessionId;
  return {
    ok: true,
    value: {
      message: raw.trim(),
      domain:
        typeof rawDomain === 'string' && CHAT_ALLOWED_DOMAINS.includes(rawDomain)
          ? rawDomain
          : undefined,
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

/** 埋点旁路：日志写失败只告警，绝不影响 /api/chat 主流程与响应 */
function trySafe(run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error('Log write failed (bypassed):', error);
  }
}

/** /api/chat 全链路埋点中间件（t1 骨架）：读 X-Trace-Id（缺失兜底生成并回写响应头）、
 * X-Client-Sent-At；ensureSkeleton 在业务校验 / 入队之前执行（400 / 413 也落库）；
 * runWithTraceId 包裹后续处理供 agent / transport 明细埋点取用 */
function chatTracing(logStore: LogStore): RequestHandler {
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
        'chat',
        traceId,
        typeof body.message === 'string' ? body.message : null,
        typeof body.domain === 'string' ? body.domain : null,
        Date.now(),
        clientSentAt
      )
    );

    runWithTraceId(traceId, () => {
      response.locals.chatTraceId = traceId;
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
  options: { port: number; allowedOrigin: string; logStore?: LogStore }
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
  function enqueue(
    handle: () => ChatData | Promise<ChatData>
  ): Promise<ChatData> {
    const result = requestQueue.then(() => handle());
    requestQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  app.post(
    '/api/chat',
    chatTracing(logStore),
    async (request: Request, response: Response) => {
      const traceId = response.locals.chatTraceId as string;
      const parsed = parseBody(
        (request.body ?? {}) as Record<string, unknown>,
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
        sendError(response, parsed.code, parsed.message);
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

  app.post('/api/sango/random', async (request: Request, response: Response) => {
    const parsed = parseBody(
      (request.body ?? {}) as Record<string, unknown>,
      RANDOM_ALLOWED_KEYS,
      RANDOM_ALLOWED_LABEL
    );
    if (!parsed.ok) {
      sendError(response, parsed.code, parsed.message);
      return;
    }

    // 确定性命令：薄转发 mcp-server fengyunsanguo_quiz_command（出题 / 判题 / 查答案状态机在 quiz 子进程），
    // 不经 LLM；citations 恒 []（随机一题无原文引用，行为与现状零变化）
    try {
      const data = await enqueue(async () => {
        const result = await transport.fengyunsanguo_quiz_command(
          parsed.value.message,
          parsed.value.sessionId
        );
        return { answer: toolResultText(result), citations: [] };
      });
      response.json({ code: 200, data, message: '' });
    } catch (error) {
      console.error('Failed to process request:', error);
      const info = processingErrorInfo(error);
      sendError(response, info.code, info.message);
    }
  });

  return app;
}

/** 提取工具返回的纯文本（quiz_command 为确定性单文本回复） */
function toolResultText(result: ToolCallResult): string {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}