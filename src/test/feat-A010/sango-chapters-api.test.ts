// feat-A010 原文接口 HTTP 路由测试（测试即文档）：
// 覆盖：GET /api/v1/sango/chapters/:chapter 成功 200（整回 + prev/next + chunks[]）/
// 越界与非数字 400 message 原文 / 器坊「第 N 回原文不存在」→ 404 透传 /
// MCP 通道失败（callTool 抛错）→ 503 / 内容解析失败 → 500。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { ToolCallResult } from '../../types.js';
import { SANGO_NOVEL_CHAPTER_TOOL } from '../../api/v1/sango.js';

const CHAPTER_400 = 'chapter 只支持 1~120 的整数';
const TOOL_503 = '工具服务暂不可用，请稍后重试';
const INTERNAL_500 = '处理请求失败，请稍后重试';

const PAYLOAD_73 = {
  chapter: 73,
  title: '玄德进位汉中王　云长攻拔襄阳郡',
  prev: { chapter: 72, title: '诸葛亮智取汉中　曹阿瞒兵退斜谷' },
  next: { chapter: 74, title: '庞令明抬榇决死战　关云长放水淹七军' },
  chunks: [
    { chunkId: 'sanguo-yanyi:0073:c0001', text: '却说曹操退兵至斜谷……', type: 'narration', segFrom: 1, segTo: 1 },
  ],
};

class StubAgent {
  async processQueryData(query: string): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }
  async listTools(): Promise<unknown[]> {
    return [];
  }
}

class ChapterTransport {
  constructor(
    private readonly mode:
      | { kind: 'ok' }
      | { kind: 'isError'; text: string }
      | { kind: 'throw' }
      | { kind: 'badJson' }
  ) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    assert.equal(name, SANGO_NOVEL_CHAPTER_TOOL);
    if (this.mode.kind === 'throw') {
      throw new Error('MCP Server 未连接');
    }
    if (this.mode.kind === 'isError') {
      return {
        content: [{ type: 'text', text: this.mode.text }],
        isError: true,
      } as unknown as ToolCallResult;
    }
    if (this.mode.kind === 'badJson') {
      return { content: [{ type: 'text', text: 'not-json' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(PAYLOAD_73) }] };
  }
}

async function startServer(t: TestContext, transport: MCPTransport): Promise<string> {
  const app = createServer(
    new StubAgent() as unknown as Agent,
    transport,
    { port: 0, allowedOrigin: '*', logStore: createLogStore({ dbPath: ':memory:' }) }
  );
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

function assertEnvelope(body: any, code: number, data: unknown, message: string): void {
  assert.deepEqual(body, { code, data, message });
}

test('① 成功 200：整回原文 + prev/next + chunks[] 原样透传（不分页信封）', async (t) => {
  const baseUrl = await startServer(t, new ChapterTransport({ kind: 'ok' }) as unknown as MCPTransport);

  const res = await get(baseUrl, '/api/v1/sango/chapters/73');
  assert.equal(res.status, 200);
  assertEnvelope(res.body, 200, PAYLOAD_73, '');
});

test('② 越界 / 非数字：chapter 非法 → 400 message 原文', async (t) => {
  const baseUrl = await startServer(t, new ChapterTransport({ kind: 'ok' }) as unknown as MCPTransport);

  for (const path of ['0', '-1', '121', 'abc', '1.5']) {
    const res = await get(baseUrl, `/api/v1/sango/chapters/${path}`);
    assert.equal(res.status, 400, path);
    assertEnvelope(res.body, 400, null, CHAPTER_400);
  }
});

test('③ 语料缺失：器坊 isError「第 N 回原文不存在」→ 404 透传 message', async (t) => {
  const baseUrl = await startServer(
    t,
    new ChapterTransport({ kind: 'isError', text: '第 50 回原文不存在' }) as unknown as MCPTransport
  );

  const res = await get(baseUrl, '/api/v1/sango/chapters/50');
  assert.equal(res.status, 404);
  assertEnvelope(res.body, 404, null, '第 50 回原文不存在');
});

test('④ MCP 通道失败：callTool 抛错 → 503 message 原文', async (t) => {
  const baseUrl = await startServer(t, new ChapterTransport({ kind: 'throw' }) as unknown as MCPTransport);

  const res = await get(baseUrl, '/api/v1/sango/chapters/73');
  assert.equal(res.status, 503);
  assertEnvelope(res.body, 503, null, TOOL_503);
});

test('⑤ 其余处理失败：器坊返回内容解析失败 → 500 message 原文', async (t) => {
  const baseUrl = await startServer(t, new ChapterTransport({ kind: 'badJson' }) as unknown as MCPTransport);

  const res = await get(baseUrl, '/api/v1/sango/chapters/73');
  assert.equal(res.status, 500);
  assertEnvelope(res.body, 500, null, INTERNAL_500);
});

test('⑥ 边界回号：1 与 120 均合法（不 400）', async (t) => {
  const baseUrl = await startServer(t, new ChapterTransport({ kind: 'ok' }) as unknown as MCPTransport);

  for (const path of ['1', '120']) {
    const res = await get(baseUrl, `/api/v1/sango/chapters/${path}`);
    assert.equal(res.status, 200, path);
  }
});
