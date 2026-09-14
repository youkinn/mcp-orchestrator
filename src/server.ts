import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { Agent } from './agent.js';
import type { SangoService } from './sango.js';
import { ToolExecutionError } from './types.js';

const MAX_MESSAGE_LENGTH = 300;
const CHAT_ALLOWED_KEYS = ['message'];
const CHAT_ALLOWED_LABEL = 'message';
const RANDOM_ALLOWED_KEYS = ['message', 'sessionId'];
const RANDOM_ALLOWED_LABEL = 'message、sessionId';

interface ParsedBody {
  message: string;
  sessionId?: string;
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

  const session = body.sessionId;
  return {
    ok: true,
    value: {
      message: raw.trim(),
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

export function createServer(
  agent: Agent,
  sangoService: SangoService,
  options: { port: number; allowedOrigin: string }
) {
  const app = express();
  // 两个 POST 端点共用同一条串行队列，避免 LLM 调用与题库会话读写并发
  let requestQueue = Promise.resolve();

  app.use(cors({ origin: options.allowedOrigin }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      code: 200,
      data: { status: 'ok', service: 'mcp-orchestrator' },
      message: '',
    });
  });

  // 上报模型实际可见的全部工具（MCP 工具 + 本地 sango_query），来源为统一 Agent
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

  // 校验通过后入队执行；503 只由 ToolExecutionError 触发，其余异常一律 500
  async function enqueue(
    response: Response,
    handle: () => string | Promise<string>
  ) {
    try {
      const result = requestQueue.then(() => handle());
      requestQueue = result.then(
        () => undefined,
        () => undefined
      );
      response.json({ code: 200, data: { answer: await result }, message: '' });
    } catch (error) {
      console.error('Failed to process request:', error);
      const toolUnavailable = error instanceof ToolExecutionError;
      sendError(
        response,
        toolUnavailable ? 503 : 500,
        toolUnavailable
          ? '工具服务暂不可用，请稍后重试'
          : '处理请求失败，请稍后重试'
      );
    }
  }

  app.post('/api/chat', async (request: Request, response: Response) => {
    const parsed = parseBody(
      (request.body ?? {}) as Record<string, unknown>,
      CHAT_ALLOWED_KEYS,
      CHAT_ALLOWED_LABEL
    );
    if (!parsed.ok) {
      sendError(response, parsed.code, parsed.message);
      return;
    }

    await enqueue(response, () => agent.processQuery(parsed.value.message));
  });

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

    // 确定性命令：本地规则出题 / 判题 / 查答案，不经 LLM、不经 MCP
    await enqueue(response, () =>
      sangoService.handleRandom(parsed.value.message, parsed.value.sessionId)
    );
  });

  return app;
}
