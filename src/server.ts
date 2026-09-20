import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { Agent, ChatData } from './agent.js';
import type { MCPTransport } from './transport.js';
import { ToolExecutionError, type ToolCallResult } from './types.js';

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

export function createServer(
  agent: Agent,
  transport: MCPTransport,
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

  // 校验通过后入队执行；503 只由 ToolExecutionError 触发，其余异常一律 500
  async function enqueue(
    response: Response,
    handle: () => ChatData | Promise<ChatData>
  ) {
    try {
      const result = requestQueue.then(() => handle());
      requestQueue = result.then(
        () => undefined,
        () => undefined
      );
      response.json({ code: 200, data: await result, message: '' });
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

    await enqueue(
      response,
      () => agent.processQueryData(parsed.value.message, parsed.value.domain)
    );
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

    // 确定性命令：薄转发 mcp-server fengyunsanguo_quiz_command（出题 / 判题 / 查答案状态机在 quiz 子进程），
    // 不经 LLM；citations 恒 []（随机一题无原文引用，行为与现状零变化）
    await enqueue(response, async () => {
      const result = await transport.fengyunsanguo_quiz_command(
        parsed.value.message,
        parsed.value.sessionId
      );
      return { answer: toolResultText(result), citations: [] };
    });
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
