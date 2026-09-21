// feat-A010 三国演义原文接口（/api/v1/sango*）：
// GET /chapters/:chapter 整回原文，经 transport.callTool 直调器坊 sango_novel_chapter（不经 agent、
// 不经过滤，后台通道不受白名单影响）；信封 { code, data, message } 与错误码口径见接口文档 §二。
// 本组接口自身不落日志（防递归，同 /api/v1/logs*）。
import { Router, type Request, type Response } from 'express';
import type { MCPTransport } from '../../transport.js';
import type { ToolCallResult } from '../../types.js';

/** 器坊整回读取工具名（与 mcp-server/sango 注册一致） */
export const SANGO_NOVEL_CHAPTER_TOOL = 'sango_novel_chapter';

const CHAPTER_PATTERN = /^\d+$/;
const CHAPTER_ERROR_MESSAGE = 'chapter 只支持 1~120 的整数';
const TOOL_UNAVAILABLE_MESSAGE = '工具服务暂不可用，请稍后重试';
const INTERNAL_ERROR_MESSAGE = '处理请求失败，请稍后重试';

function sendError(response: Response, code: number, message: string): void {
  response.status(code).json({ code, data: null, message });
}

/** isError 返回的错误描述：取返回内容中的文本拼接；无文本返回空串 */
function extractToolError(result: ToolCallResult): string {
  return result.content
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text ?? '')
    .join(' ')
    .trim();
}

export function createSangoApi(transport: MCPTransport): Router {
  const router = Router();

  // GET /api/v1/sango/chapters/:chapter —— 整回原文（1~120，不分页）
  router.get('/chapters/:chapter', async (request: Request, response: Response) => {
    try {
      const raw = request.params.chapter;
      if (typeof raw !== 'string' || !CHAPTER_PATTERN.test(raw)) {
        sendError(response, 400, CHAPTER_ERROR_MESSAGE);
        return;
      }
      const chapter = Number(raw);
      if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > 120) {
        sendError(response, 400, CHAPTER_ERROR_MESSAGE);
        return;
      }

      let result: ToolCallResult;
      try {
        result = await transport.callTool(SANGO_NOVEL_CHAPTER_TOOL, { chapter });
      } catch (error) {
        // MCP 未连接 / 子进程退出 / 协议错误等通道失败 → 503（判定顺序第 2 条）
        console.error(`Failed to call ${SANGO_NOVEL_CHAPTER_TOOL}:`, error);
        sendError(response, 503, TOOL_UNAVAILABLE_MESSAGE);
        return;
      }

      if ((result as { isError?: boolean }).isError === true) {
        const message = extractToolError(result);
        // 器坊回「第 N 回原文不存在」→ 404 透传；其余工具错误 → 500（判定顺序第 3 / 4 条）
        if (message.includes('不存在')) {
          sendError(response, 404, message);
          return;
        }
        // 500 message 固定（接口文档 §2.3 冻结口径），器坊原始文本只进日志排查、不进响应
        console.error(`${SANGO_NOVEL_CHAPTER_TOOL} 返回未识别工具错误：`, message);
        sendError(response, 500, INTERNAL_ERROR_MESSAGE);
        return;
      }

      const text = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('');
      const data = JSON.parse(text) as unknown;
      response.json({ code: 200, data, message: '' });
    } catch (error) {
      console.error('Failed to serve sango chapter:', error);
      sendError(response, 500, INTERNAL_ERROR_MESSAGE);
    }
  });

  return router;
}

