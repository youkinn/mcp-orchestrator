// feat-A017 草稿台 HTTP 接口测试（测试即文档）：
// 覆盖：source/chunks/params 400 明细（§4.1 / §4.2）、生产请求行为不变、来源筛选隔离（缺省仅生产，验收 7）、
// 草稿台发送成功 / 失败落记录、记录列表 / 详情 + diff 重算、trace 拉取（候选映射 + preview 合成 + 温度带出）、
// 记录删除（物理删除含日志链路 / 404 / 400 / 删除后列表与详情不可见 / 日志页不再出现该 traceId）、
// 差异三态边界（空清单 400 / 拒答缺省 / extra 非空不吞）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type {
  Agent,
  DraftbenchChunk,
  DraftbenchParams,
  DraftbenchResult,
} from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import { SANGO_NOVEL_SEARCH_TOOL } from '../../citation.js';
import { SANGO_NOVEL_CHAPTER_TOOL } from '../../api/v1/sango.js';
import type { ToolCallResult } from '../../types.js';

const TRACE_PROD = '9f7c0000-0000-4000-8000-00000000000a';
const TRACE_DRAFT = '9f7c0000-0000-4000-8000-00000000000b';

const CHUNK_A: DraftbenchChunk = {
  chunkId: 'sanguo-yanyi:0005:c0001',
  text: '却说陈宫临欲下手杀曹操，忽转念曰："我为国家跟他到此，杀之不义。不若弃而他往。"',
  chapter: 5,
  title: '发矫诏诸镇应曹公 破关兵三英战吕布',
};

/** 双通道桩：sango_novel_chapter 返回可定位 chunk 的整回 JSON；chapterFail 模拟通道故障（预览降级） */
class DraftbenchSimTransport {
  chapterFail = false;
  chapterCalls: number[] = [];

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    if (name === SANGO_NOVEL_CHAPTER_TOOL) {
      const chapter = Number(args.chapter);
      this.chapterCalls.push(chapter);
      if (this.chapterFail) {
        throw new Error('sango channel down');
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              chapter,
              title: '发矫诏诸镇应曹公 破关兵三英战吕布',
              prev: null,
              next: null,
              chunks: [
                {
                  chunkId: 'sanguo-yanyi:0005:c0001',
                  text: '却说陈宫临欲下手杀曹操，忽转念曰："我为国家跟他到此，杀之不义。不若弃而他往。"插剑上马，不等天明，自投东郡去了。操觉，不见陈宫，寻思："此人见我说了这两句，疑我不仁，弃我而去；吾当急行，不可久留。"遂连夜到陈留。',
                  type: 'narration',
                  segFrom: 1,
                  segTo: 2,
                },
              ],
            }),
          },
        ],
      };
    }
    return { content: [{ type: 'text', text: '' }] };
  }

  async fengyunsanguo_quiz_command(): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: '模拟回复' }] };
  }
}

/** 桩 Agent：生产走 processQueryData；草稿台走 processDraftbench（可注入结果 / 失败） */
class StubDraftbenchAgent {
  draftbenchCalls: Array<{
    query: string;
    chunks: unknown;
    params: unknown;
  }> = [];
  failDraftbench = false;
  outcome: {
    answer?: string;
    citations?: unknown[];
    diff?: DraftbenchResult['diff'];
    citedIndexes?: number[];
    params?: DraftbenchParams;
  } = {};

  async processQueryData(query: string): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }

  async processDraftbench(
    query: string,
    chunks: unknown,
    params: unknown
  ): Promise<DraftbenchResult> {
    this.draftbenchCalls.push({ query, chunks, params });
    if (this.failDraftbench) {
      throw new Error('模拟编排失败');
    }
    const citations = (this.outcome.citations ?? []) as DraftbenchResult['data']['citations'];
    return {
      data: {
        answer: this.outcome.answer ?? '草稿台回复',
        citations,
      },
      params: (this.outcome.params ?? params) as DraftbenchParams,
      diff: this.outcome.diff ?? { consistent: [1], missing: [], extra: [] },
      citedIndexes: this.outcome.citedIndexes ?? [0],
    };
  }

  async listTools(): Promise<unknown[]> {
    return [];
  }
}

async function startServer(
  t: TestContext,
  logStore: LogStore,
  agent: StubDraftbenchAgent,
  transport: DraftbenchSimTransport
): Promise<string> {
  const app = createServer(
    agent as unknown as Agent,
    transport as unknown as MCPTransport,
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

async function post(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<{ status: number; body: any; traceId: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
    traceId: response.headers.get('X-Trace-Id') ?? '',
  };
}

async function del(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
  return { status: response.status, body: await response.json() };
}

function newHarness(t: TestContext): {
  logStore: LogStore;
  agent: StubDraftbenchAgent;
  transport: DraftbenchSimTransport;
  baseUrl: string;
} {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const agent = new StubDraftbenchAgent();
  const transport = new DraftbenchSimTransport();
  return { logStore, agent, transport, baseUrl: '' };
}

function seedProductionTrace(logStore: LogStore, traceId = TRACE_PROD): void {
  logStore.ensureSkeleton('chat', traceId, '关羽千里走单骑的经过', 'sango-novel', 1789884000000, 1789883998000);
  logStore.markResponded(traceId, 1789884003450, 'success', 200, '', '示例答案', '[]');
  logStore.flush();
}

function seedDraftbenchTrace(logStore: LogStore, traceId = TRACE_DRAFT): void {
  logStore.ensureSkeleton('chat', traceId, '草稿台手动问题', 'sango-novel', 1789884009000, null, 'draftbench');
  logStore.markResponded(traceId, 1789884010000, 'success', 200, '', '草稿答案', '[]');
  logStore.flush();
}

function seedTraceWithRetrieval(logStore: LogStore, traceId: string): void {
  logStore.ensureSkeleton('chat', traceId, '关羽怎么败的？', 'sango-novel', 1789885000000, null);
  logStore.appendLlmCall(traceId, {
    stage: 'generation',
    model: 'mock-model',
    requestAt: 1789885000100,
    status: 'success',
    temperature: 0.5,
    errorMessage: '',
  });
  const seq = logStore.appendToolCall(traceId, {
    mcpServer: 'sango',
    toolName: SANGO_NOVEL_SEARCH_TOOL,
    callSentAt: 1789885000200,
    status: 'success',
    caller: 'server',
    stage: 'fastpath',
  });
  if (seq !== null) {
    logStore.appendRetrievalLog(traceId, seq, {
      funnel: { injected: 1, cited: 1 },
      candidates: [
        {
          chunkId: 'sanguo-yanyi:0005:c0001',
          rank: 1,
          chapter: 5,
          title: '发矫诏诸镇应曹公 破关兵三英战吕布',
          sources: ['lexical', 'vector'],
          finalScore: 12.3,
          injected: true,
          cited: true,
        },
      ],
    });
  }
  logStore.markResponded(traceId, 1789885003000, 'success', 200, '', '关羽败走麦城', '[]');
  logStore.flush();
}

// ===== 校验 400 明细（§4.1 / §4.2） =====

test('draftbench: source/chunks/params 非法均 400 明细且生产请求行为不变', async (t) => {
  const h = newHarness(t);
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  // 生产请求（不带 source）行为不变：200 + 走生产管线
  const prod = await post(baseUrl, '/api/chat', {
    message: '关羽是谁',
    domain: 'sango-novel',
  });
  assert.equal(prod.status, 200);
  assert.equal(prod.body.code, 200);
  assert.equal(prod.body.data.answer, '统一 Agent 回复');
  assert.equal(prod.body.data.diff, undefined);
  assert.equal(h.agent.draftbenchCalls.length, 0);

  const cases: Array<{ body: Record<string, unknown>; message: string }> = [
    { body: { message: 'x', source: 'foo' }, message: 'source 只支持 production/draftbench' },
    { body: { message: 'x', domain: 'sango-novel', source: 'production', chunks: [CHUNK_A] }, message: 'chunks/params 仅支持草稿台（source=draftbench）发送' },
    { body: { message: 'x', domain: 'sango-novel', source: 'production', params: { topK: 3 } }, message: 'chunks/params 仅支持草稿台（source=draftbench）发送' },
    { body: { message: 'x', source: 'draftbench' }, message: 'domain 字段仅支持 sango-novel（草稿台发送锁定原著域）' },
    { body: { message: 'x', domain: 'fengyunsanguo', source: 'draftbench', chunks: [CHUNK_A] }, message: 'domain 字段仅支持 sango-novel（草稿台发送锁定原著域）' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench' }, message: '发送清单不能为空' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [] }, message: '发送清单不能为空' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: 'not-array' }, message: '发送清单不能为空' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: Array.from({ length: 21 }, () => CHUNK_A) }, message: '发送清单最多 20 条' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: ['text'] }, message: '清单条目格式非法' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [{ chapter: 5 }] }, message: '片段文本不能为空' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [{ text: 'a'.repeat(2001) }] }, message: '单条片段不能超过 2000 字' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [{ text: 'a', chunkId: 123 }] }, message: 'chunkId 格式非法' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [{ text: 'a', chapter: '5' }] }, message: '清单条目元数据格式非法' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: { temperature: 1.5 } }, message: 'temperature 需为 0~1 的数字' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: { topK: 0 } }, message: 'topK 需为 1~20 的整数' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: { topK: 21 } }, message: 'topK 需为 1~20 的整数' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: { topK: 3, guarantee: 4 } }, message: 'guarantee 需为 0~topK 的整数' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: { budget: 0 } }, message: 'budget 需为 1~20000 的整数' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: { budget: 20001 } }, message: 'budget 需为 1~20000 的整数' },
    { body: { message: 'x', domain: 'sango-novel', source: 'draftbench', chunks: [CHUNK_A], params: 'nope' }, message: 'params 需为对象' },
  ];
  for (const c of cases) {
    const res = await post(baseUrl, '/api/chat', c.body);
    assert.equal(res.status, 400, `case: ${JSON.stringify(c.body)}`);
    assert.equal(res.body.code, 400);
    assert.equal(res.body.message, c.message);
  }
  // 草稿台校验失败（400）也落一条记录
  const records = await get(baseUrl, '/api/v1/draftbench/records');
  assert.equal(records.body.code, 200);
  const failed = records.body.data.list.filter(
    (row: any) => row.status === 'failed' && row.errorMessage !== ''
  );
  assert.ok(failed.length > 0, '校验失败应落 failed 记录');
  assert.ok(
    failed.some((row: any) => row.chunkCount === 1),
    '携带清单的失败请求应快照 chunkCount=1'
  );
});

// ===== 草稿台发送：成功 / 失败 / 落库 =====

test('draftbench: 发送成功响应形状 + 草稿台记录与主表来源', async (t) => {
  const h = newHarness(t);
  h.agent.outcome = {
    answer: '草稿台回复',
    citations: [{ text: CHUNK_A.text, chapter: 5, title: CHUNK_A.title }],
    diff: { consistent: [1], missing: [], extra: [] },
    citedIndexes: [0],
  };
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);
  const res = await post(baseUrl, '/api/chat', {
    message: '关羽为何败走麦城？',
    domain: 'sango-novel',
    source: 'draftbench',
    chunks: [CHUNK_A],
    params: { temperature: 0.5, topK: 3, guarantee: 2, budget: 500 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.answer, '草稿台回复');
  assert.equal(res.body.data.citations.length, 1);
  assert.deepEqual(res.body.data.params, { temperature: 0.5, topK: 3, guarantee: 2, budget: 500 });
  assert.deepEqual(res.body.data.diff, { consistent: [1], missing: [], extra: [] });
  assert.ok(typeof res.body.data.traceId === 'string' && res.body.data.traceId.length > 0);

  // 主表 request_source=draftbench（详情可见 source）
  h.logStore.flush();
  const detail = await get(baseUrl, `/api/v1/logs/${res.body.data.traceId}`);
  assert.equal(detail.body.data.log.source, 'draftbench');
  assert.equal(detail.body.data.log.routeSource, null);

  // 草稿台记录：成功行含结果摘要
  const records = await get(baseUrl, '/api/v1/draftbench/records');
  assert.equal(records.body.data.total, 1);
  const row = records.body.data.list[0];
  assert.equal(row.status, 'success');
  assert.equal(row.chunkCount, 1);
  assert.equal(row.result.citationCount, 1);
  assert.equal(row.traceId, res.body.data.traceId);
});

test('draftbench: 发送失败落 failed 记录（500），响应 message 走统一口径', async (t) => {
  const h = newHarness(t);
  h.agent.failDraftbench = true;
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);
  const res = await post(baseUrl, '/api/chat', {
    message: '关羽为何败走麦城？',
    domain: 'sango-novel',
    source: 'draftbench',
    chunks: [CHUNK_A],
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.message, '处理请求失败，请稍后重试');
  const records = await get(baseUrl, '/api/v1/draftbench/records');
  assert.equal(records.body.data.total, 1);
  const row = records.body.data.list[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.errorMessage, '处理请求失败，请稍后重试');
  assert.equal(row.result, null);
});

// ===== 差异三态边界（§4.4） =====

test('draftbench: 拒答三态（consistent 空 / missing 全量 / extra 空）且 extra 非空信号不被吞', async (t) => {
  const h = newHarness(t);
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  // 拒答边界：answer=演义中未涉及 + citations [] → missing 全部
  h.agent.outcome = {
    answer: '演义中未涉及',
    citations: [],
    diff: { consistent: [], missing: [1, 2], extra: [] },
    citedIndexes: [],
  };
  const twoChunks = [CHUNK_A, { text: '却说吕蒙白衣渡江，袭取荆州。', chapter: 5 }];
  const refused = await post(baseUrl, '/api/chat', {
    message: '演义中未涉及的问法',
    domain: 'sango-novel',
    source: 'draftbench',
    chunks: twoChunks,
  });
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.body.data.diff, { consistent: [], missing: [1, 2], extra: [] });

  // extra 非空信号：服务端透传不吞（页面高亮 / CLI 打 ! 的判别依据）
  h.agent.outcome = {
    answer: '异常答案',
    citations: [{ text: '超出清单的引用' }],
    diff: { consistent: [1], missing: [], extra: [{ text: '超出清单的引用', chapter: 1 }] },
    citedIndexes: [0],
  };
  const extra = await post(baseUrl, '/api/chat', {
    message: '异常用例',
    domain: 'sango-novel',
    source: 'draftbench',
    chunks: twoChunks,
  });
  assert.equal(extra.status, 200);
  assert.equal(extra.body.data.diff.extra.length, 1);
  assert.equal(extra.body.data.diff.extra[0].text, '超出清单的引用');
});

// ===== 记录列表 / 详情（§3.3 / §3.4） =====

test('draftbench: records 列表仅草稿台、时间倒序、分页形状', async (t) => {
  const h = newHarness(t);
  h.logStore.saveDraftbenchRecord({
    traceId: '9f7c0000-0000-4000-8000-0000000000c1',
    time: 1789884000000,
    query: '问题一',
    params: { temperature: 0.5, topK: 3, guarantee: 2, budget: 500 },
    chunks: [{ chunkId: 'x', text: '文本一', chapter: 5, title: '回目' }],
    citedIndexes: [0],
    status: 'success',
    errorMessage: '',
    result: { answer: '答案一', citations: [{ text: '引用一' }] },
  });
  h.logStore.saveDraftbenchRecord({
    traceId: '9f7c0000-0000-4000-8000-0000000000c2',
    time: 1789884010000,
    query: '问题二',
    params: null,
    chunks: null,
    citedIndexes: [],
    status: 'failed',
    errorMessage: '发送清单不能为空',
    result: null,
  });
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  const res = await get(baseUrl, '/api/v1/draftbench/records');
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.total, 2);
  assert.equal(res.body.data.pageNo, 1);
  assert.equal(res.body.data.pageSize, 20);
  // 倒序：时间新在前
  assert.equal(res.body.data.list[0].traceId, '9f7c0000-0000-4000-8000-0000000000c2');
  assert.equal(res.body.data.list[0].status, 'failed');
  assert.equal(res.body.data.list[0].errorMessage, '发送清单不能为空');
  assert.equal(res.body.data.list[0].result, null);
  // 校验失败行 params 快照缺失 → 服务端带出生产缺省（§4.2）
  assert.deepEqual(res.body.data.list[0].params, { temperature: 0.7, topK: 10, guarantee: 5, budget: 2000 });
  assert.equal(res.body.data.list[1].result.citationCount, 1);

  const bad = await get(baseUrl, '/api/v1/draftbench/records/not-a-uuid');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.message, 'traceId 格式非法');
  const missing = await get(baseUrl, '/api/v1/draftbench/records/9f7c0000-0000-4000-8000-000000000099');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, '草稿台记录不存在');
});

test('draftbench: 记录详情载入 + diff 按 §4.4 重算（单一实现点）', async (t) => {
  const h = newHarness(t);
  h.logStore.saveDraftbenchRecord({
    traceId: '9f7c0000-0000-4000-8000-0000000000d1',
    time: 1789884000000,
    query: '关羽为何败走麦城？',
    params: { temperature: 0.5, topK: 10, guarantee: 5, budget: 2000 },
    chunks: [
      { chunkId: 'a', text: '片段甲', chapter: 5, title: '回目一' },
      { chunkId: 'b', text: '片段乙', chapter: 5, title: '回目一' },
      { chunkId: 'c', text: '片段丙', chapter: 5, title: '回目一' },
    ],
    citedIndexes: [0, 2],
    status: 'success',
    errorMessage: '',
    result: { answer: '答案', citations: [{ text: '片段甲' }, { text: '片段丙' }] },
  });
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);
  const res = await get(
    baseUrl,
    '/api/v1/draftbench/records/9f7c0000-0000-4000-8000-0000000000d1'
  );
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.chunks.length, 3);
  assert.deepEqual(res.body.data.diff, { consistent: [1, 3], missing: [2], extra: [] });
  assert.equal(res.body.data.result.answer, '答案');
  assert.equal(res.body.data.result.citations.length, 2);
});

// ===== 记录删除（§3.6） =====

test('draftbench: 删除记录 200（物理删除含日志链路）+ 删除后列表 / 详情不可见 + 日志页查不到', async (t) => {
  const h = newHarness(t);
  const traceId = '9f7c0000-0000-4000-8000-0000000000e1';
  // 同 traceId 同时存在草稿台记录行与完整日志链路（LLM / 工具 / 检索 / 缓存判定行；删除应一并物理删除）
  seedDraftbenchTrace(h.logStore, traceId);
  h.logStore.appendLlmCall(traceId, {
    stage: 'generation',
    model: 'mock-model',
    requestAt: 1789884009100,
    status: 'success',
    errorMessage: '',
  });
  const seq = h.logStore.appendToolCall(traceId, {
    mcpServer: 'sango',
    toolName: SANGO_NOVEL_SEARCH_TOOL,
    callSentAt: 1789884009200,
    status: 'success',
    caller: 'server',
    stage: 'fastpath',
  });
  if (seq !== null) {
    h.logStore.appendRetrievalLog(traceId, seq, {
      funnel: { injected: 1, cited: 1 },
      candidates: [],
    });
  }
  h.logStore.appendCacheLog(traceId, {
    userQuery: '草稿台手动问题',
    nearestQuery: null,
    similarity: 0.9,
    hitLine: 0.8,
    hit: false,
    tieHits: 0,
  });
  h.logStore.saveDraftbenchRecord({
    traceId,
    time: 1789884009000,
    query: '草稿台手动问题',
    params: { temperature: 0.5, topK: 3, guarantee: 2, budget: 500 },
    chunks: [{ chunkId: 'x', text: '文本', chapter: 5, title: '回目' }],
    citedIndexes: [0],
    status: 'success',
    errorMessage: '',
    result: { answer: '草稿答案', citations: [{ text: '引用' }] },
  });
  h.logStore.flush();
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  // 删除前：日志页该 traceId 按正常日志可见（来源=draftbench）
  const before = await get(baseUrl, `/api/v1/logs/${traceId}`);
  assert.equal(before.status, 200);
  assert.equal(before.body.data.log.source, 'draftbench');

  const res = await del(baseUrl, `/api/v1/draftbench/records/${traceId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { code: 200, data: { deleted: true }, message: '' });

  // 删除后：记录列表与详情均不可见
  const records = await get(baseUrl, '/api/v1/draftbench/records');
  assert.equal(records.body.code, 200);
  assert.equal(records.body.data.total, 0);
  const detail = await get(baseUrl, `/api/v1/draftbench/records/${traceId}`);
  assert.equal(detail.status, 404);
  assert.equal(detail.body.message, '草稿台记录不存在');

  // 物理删除范围含日志链路：日志页来源=草稿台不再出现该 traceId（详情 404）
  const logDetail = await get(baseUrl, `/api/v1/logs/${traceId}`);
  assert.equal(logDetail.status, 404);
  assert.equal(logDetail.body.message, '日志不存在');
});

test('draftbench: 删除不存在 404 / traceId 格式非法 400，未命中的记录不误删', async (t) => {
  const h = newHarness(t);
  seedDraftbenchTrace(h.logStore, TRACE_DRAFT);
  h.logStore.saveDraftbenchRecord({
    traceId: TRACE_DRAFT,
    time: 1789884009000,
    query: '草稿台手动问题',
    params: null,
    chunks: null,
    citedIndexes: [],
    status: 'success',
    errorMessage: '',
    result: null,
  });
  h.logStore.flush();
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  const bad = await del(baseUrl, '/api/v1/draftbench/records/not-a-uuid');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.message, 'traceId 格式非法');

  const missing = await del(baseUrl, '/api/v1/draftbench/records/9f7c0000-0000-4000-8000-000000000099');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, '草稿台记录不存在');

  // 未命中删除不影响既有记录
  const records = await get(baseUrl, '/api/v1/draftbench/records');
  assert.equal(records.body.code, 200);
  assert.equal(records.body.data.total, 1);
});

// ===== trace 拉取（§3.1） =====

test('draftbench: trace 拉取候选映射 + preview 合成 + 生成温度带出', async (t) => {
  const h = newHarness(t);
  seedTraceWithRetrieval(h.logStore, TRACE_PROD);
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  const bad = await get(baseUrl, '/api/v1/draftbench/trace/not-a-uuid');
  assert.equal(bad.status, 400);
  const missing = await get(baseUrl, '/api/v1/draftbench/trace/9f7c0000-0000-4000-8000-000000000099');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.message, '请求记录不存在');

  const res = await get(baseUrl, `/api/v1/draftbench/trace/${TRACE_PROD}`);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.traceId, TRACE_PROD);
  assert.equal(res.body.data.userQuery, '关羽怎么败的？');
  assert.equal(res.body.data.routeSource, null);
  assert.equal(res.body.data.serverReceivedAt, 1789885000000);
  // params 默认带出：温度取生成轮成功实参 0.5，其余注入常量、tailFallback 只读
  assert.deepEqual(res.body.data.params, {
    temperature: 0.5,
    topK: 10,
    guarantee: 5,
    budget: 2000,
    tailFallback: true,
  });
  assert.equal(res.body.data.chunks.injectedCount, 1);
  assert.equal(res.body.data.chunks.citedCount, 1);
  assert.equal(res.body.data.chunks.candidates.length, 1);
  const candidate = res.body.data.chunks.candidates[0];
  assert.equal(candidate.chunkId, 'sanguo-yanyi:0005:c0001');
  assert.equal(candidate.rank, 1);
  assert.equal(candidate.chapter, 5);
  assert.equal(candidate.title, '发矫诏诸镇应曹公 破关兵三英战吕布');
  assert.equal(candidate.segFrom, 1);
  assert.equal(candidate.segTo, 2);
  assert.equal(candidate.injected, true);
  assert.equal(candidate.cited, true);
  assert.deepEqual(candidate.sources, ['lexical', 'vector']);
  assert.equal(candidate.finalScore, 12.3);
  assert.ok(typeof candidate.preview === 'string' && candidate.preview.length <= 120);
});

test('draftbench: 无生成轮温度缺省 0.7；章节通道故障时 preview 降级 null 不拖垮拉取', async (t) => {
  const h = newHarness(t);
  seedProductionTrace(h.logStore, TRACE_PROD);
  h.transport.chapterFail = true;
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  const res = await get(baseUrl, `/api/v1/draftbench/trace/${TRACE_PROD}`);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.params.temperature, 0.7);
  assert.equal(res.body.data.chunks.candidates.length, 0);
  assert.equal(res.body.data.chunks.injectedCount, 0);
});

// ===== 来源筛选隔离（§3.5 / §10 决策 3） =====

test('draftbench: 日志列表 / token-stats 来源筛选（缺省仅生产、非法 400、列表行带 source）', async (t) => {
  const h = newHarness(t);
  seedProductionTrace(h.logStore, TRACE_PROD);
  seedDraftbenchTrace(h.logStore, TRACE_DRAFT);
  // token 统计种子：生产 100 / 草稿台 900，同一时间段
  h.logStore.appendLlmCall(TRACE_PROD, {
    stage: 'generation',
    model: 'm',
    requestAt: 1789884001000,
    status: 'success',
    promptTokens: 100,
    completionTokens: 10,
    errorMessage: '',
  });
  h.logStore.appendLlmCall(TRACE_DRAFT, {
    stage: 'generation',
    model: 'm',
    requestAt: 1789884001000,
    status: 'success',
    promptTokens: 900,
    completionTokens: 20,
    errorMessage: '',
  });
  h.logStore.flush();
  const baseUrl = await startServer(t, h.logStore, h.agent, h.transport);

  // 缺省仅生产
  const list = await get(baseUrl, '/api/v1/logs');
  assert.equal(list.body.code, 200);
  assert.deepEqual(
    list.body.data.list.map((row: any) => row.traceId),
    [TRACE_PROD]
  );
  assert.equal(list.body.data.list[0].source, 'production');

  // 显式草稿台
  const draftList = await get(baseUrl, '/api/v1/logs?source=draftbench');
  assert.deepEqual(
    draftList.body.data.list.map((row: any) => row.traceId),
    [TRACE_DRAFT]
  );
  assert.equal(draftList.body.data.list[0].source, 'draftbench');

  // 非法 400
  const bad = await get(baseUrl, '/api/v1/logs?source=foo');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.message, 'source 只支持 production/draftbench');

  // 详情 log.source 同口径
  const detail = await get(baseUrl, `/api/v1/logs/${TRACE_DRAFT}`);
  assert.equal(detail.body.data.log.source, 'draftbench');

  // token-stats：缺省仅生产 → 100；显式草稿台 → 900
  const base = '/api/v1/logs/token-stats?startAt=1789884000000&endAt=1789884009999&granularity=day';
  const prodStats = await get(baseUrl, base);
  assert.equal(prodStats.body.data.buckets[0].inputTokens, 100);
  assert.equal(prodStats.body.data.buckets[0].outputTokens, 10);
  const draftStats = await get(baseUrl, `${base}&source=draftbench`);
  assert.equal(draftStats.body.data.buckets[0].inputTokens, 900);
  assert.equal(draftStats.body.data.buckets[0].outputTokens, 20);
  const badStats = await get(baseUrl, `${base}&source=nope`);
  assert.equal(badStats.status, 400);
});
