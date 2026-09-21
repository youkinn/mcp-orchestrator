// feat-A009 明细 API 测试（测试即文档）：
// 覆盖：GET /api/v1/logs/:traceId 工具明细增 diagnostics（解析后对象 / null）、
// 有诊断行为解析后的完整对象（含回填 injected/cited）、无诊断 / 旁路丢失 → null、
// 坏 JSON 解析失败 → null 兜底（不 500）、列表接口零改动（无 diagnostics 字段）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { ToolCallResult } from '../../types.js';

const TRACE_A = '9f7c0000-0000-4000-8000-00000000000a';
const TRACE_B = '9f7c0000-0000-4000-8000-00000000000b';

class StubAgent {
  async processQueryData(query: string): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }
  async listTools(): Promise<unknown[]> {
    return [];
  }
}

class QuizSimTransport {
  async fengyunsanguo_quiz_command(message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `模拟回复：${message}` }] };
  }
}

async function startServer(t: TestContext, logStore: LogStore): Promise<string> {
  const app = createServer(
    new StubAgent() as unknown as Agent,
    new QuizSimTransport() as unknown as MCPTransport,
    { port: 0, allowedOrigin: '*', logStore }
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

const SAMPLE_DIAGNOSTICS = {
  truncated: false,
  truncatedCount: 0,
  query: { raw: '关羽千里走单骑的经过', normalized: '关羽 千里走单骑 经过', tokens: ['关羽', '千里走单骑', '经过'] },
  env: { vectorScheme: 'bge-m3', degradedBm25Only: false, corpusChunks: 2344, aliasCount: 87, vectorDim: 1024 },
  funnel: { corpusChunks: 2344, lexicalHits: 42, vectorTop50: 50, labelHits: 3, mergedCandidates: 45, topN: 10, injected: 5, cited: 3 },
  candidates: [
    { rank: 1, chunkId: 'sango-yanyi:0073:c0007', chapter: 73, title: '玄德进位汉中王', bm25: 12.34, cosine: 0.812, labelHit: true, finalScore: 0.92, sources: ['lexical', 'vector'], injected: true, cited: true },
  ],
  nextRank: { rank: 11, chunkId: 'sanguo-yanyi:0074:c0012', chapter: 74, title: '庞令明抬榇决死战', bm25: 3.1, cosine: 0.451, labelHit: false, finalScore: 0.51, sources: ['vector'], injected: false, cited: false, gapToTopN: 0.19 },
  deathIntent: { detected: false, pinned: false, chunkIds: [] },
};

/** 落库带诊断的 TRACE_A，返回工具明细行号 */
function seedTraceA(logStore: LogStore, traceId: string = TRACE_A): number {
  logStore.ensureSkeleton('chat', traceId, '《三国演义》中关羽千里走单骑的经过是怎样的？', 'sango-novel', 1789884000000, 1789883998000);
  const seq = logStore.appendToolCall(traceId, {
    mcpServer: 'sango',
    toolName: 'sango_novel_search',
    argsSummary: '{"query":"关羽 千里走单骑"}',
    callSentAt: 1789884003200,
    callReturnedAt: 1789884003800,
    resultSummary: '[{"id":"sanguo-yanyi:0073:c0007"}]',
    status: 'success',
  });
  logStore.markResponded(traceId, 1789884003450, 'success', 200, '', '关羽在曹操军中得知刘备下落……', '[]');
  return seq ?? -1;
}

test('① 有诊断行：明细 toolCalls[].diagnostics 为解析后完整对象（含回填 injected/cited，验收 13）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const seq = seedTraceA(logStore);
  assert.notEqual(seq, -1);
  logStore.appendRetrievalLog(TRACE_A, seq, SAMPLE_DIAGNOSTICS);
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(res.status, 200);
  const tool = res.body.data.toolCalls[0];
  assert.equal(tool.toolName, 'sango_novel_search');
  assert.deepEqual(tool.diagnostics, SAMPLE_DIAGNOSTICS, '返回解析后的对象，非字符串');
  assert.equal(tool.resultSummary, '[{"id":"sanguo-yanyi:0073:c0007"}]', 'resultSummary 仍为原样字符串');
});

test('② 无诊断行：明细 toolCalls[].diagnostics=null（非检索工具 / 旁路丢失，验收 13）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedTraceA(logStore);
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.toolCalls[0].diagnostics, null, '无诊断行为 null，不炸前端');
});

test('③ 坏 JSON 解析失败 → diagnostics=null 兜底（旁路，不 500，验收 13）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feat-a009-'));
  const dbPath = join(dir, 'logs.db');

  // 第一次 store：正常落库带诊断行（flush 落盘），随即关闭以释放 DB 文件
  const seedStore = createLogStore({ dbPath });
  const seq = seedTraceA(seedStore);
  assert.notEqual(seq, -1);
  seedStore.appendRetrievalLog(TRACE_A, seq, SAMPLE_DIAGNOSTICS);
  seedStore.flush();
  seedStore.close();

  // 模拟脏数据：直接改 diagnostics 列为非法 JSON（命中存储层解析失败路径）
  const raw = new Database(dbPath);
  raw
    .prepare(`UPDATE tool_retrieval_logs SET diagnostics = ? WHERE trace_id = ? AND seq = ?`)
    .run('{bad json', TRACE_A, seq);
  raw.close();

  // 第二次 store：重新打开同一 DB 文件（坏 JSON 行在库内），起 server 验证明细兜底
  const logStore = createLogStore({ dbPath });
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, `/api/v1/logs/${TRACE_A}`);
  assert.equal(res.status, 200, '解析失败不 500（旁路）');
  assert.equal(res.body.data.toolCalls[0].diagnostics, null, '坏 JSON → diagnostics=null 兜底，不炸前端');

  // 收尾顺序（t.after 按注册序 FIFO）：startServer 已注册关 server → 关 logStore → 最后删目录
  t.after(() => logStore.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));
});

test('④ 列表接口零改动：列表项无 diagnostics 字段（诊断只在明细，验收 13）', async (t) => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  seedTraceA(logStore);
  logStore.flush();
  const baseUrl = await startServer(t, logStore);

  const res = await get(baseUrl, '/api/v1/logs');
  assert.equal(res.status, 200);
  const item = res.body.data.list[0];
  assert.ok(!('diagnostics' in item), '列表项不携带诊断');
});
