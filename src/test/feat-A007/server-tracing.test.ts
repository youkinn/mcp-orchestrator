// feat-A007 /api/chat 埋点集成测试（测试即文档）：
// 覆盖：X-Trace-Id 透传与回写 / 兜底生成 / X-Client-Sent-At 落库 / 全链路回填（t2/t5/answer/citations）/
// 校验失败 400/413 落库（handle_started_at 为 NULL）/ 500 与 503 失败回填 / 并发队列等待 /
// 故障注入旁路（埋点存储抛错时 /api/chat 仍 200）。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../../agent.js';
import { createServer } from '../../server.js';
import type { MCPTransport } from '../../transport.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import { ToolExecutionError, type ToolCallResult, type MCPToolDefinition } from '../../types.js';

const TRACE_ID = '11111111-2222-4333-8444-555555555555';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StubAgent {
  constructor(
    private options: { reply?: string; error?: Error; delayMs?: number } = {}
  ) {}

  async processQueryData(
    query: string,
    domain?: string
  ): Promise<{ answer: string; citations: [] }> {
    if (this.options.delayMs) {
      await sleep(this.options.delayMs);
    }
    if (this.options.error) {
      throw this.options.error;
    }
    return { answer: this.options.reply ?? '统一 Agent 回复', citations: [] };
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    return [];
  }
}

class QuizSimTransport {
  async fengyunsanguo_quiz_command(_message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: '模拟回复' }] };
  }
}

interface StartOptions {
  agent?: StubAgent;
  logStore?: LogStore;
}

async function startServer(
  t: TestContext,
  options: StartOptions = {}
): Promise<{ baseUrl: string; logStore: LogStore }> {
  const logStore = options.logStore ?? createLogStore({ dbPath: ':memory:' });
  t.after(() => {
    try {
      logStore.close();
    } catch {
      // 故障注入用 store 的 close 也可能抛错，测试收尾不因此失败
    }
  });
  const app = createServer(
    (options.agent ?? new StubAgent()) as unknown as Agent,
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
  return { baseUrl: `http://127.0.0.1:${port}`, logStore };
}

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('埋点：带 X-Trace-Id / X-Client-Sent-At 的 /api/chat 全链路落库（t1 骨架 → t2 → t5 回填 success）', async (t) => {
  const { baseUrl, logStore } = await startServer(t);

  const res = await post(baseUrl, '/api/chat', { message: '你好', domain: 'sango-novel' }, {
    'X-Trace-Id': TRACE_ID,
    'X-Client-Sent-At': '1789883998000',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.headers.get('x-trace-id'), TRACE_ID);

  logStore.flush();
  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.log.logType, 'chat');
  assert.equal(detail.log.userInput, '你好');
  assert.equal(detail.log.domain, 'sango-novel');
  assert.equal(detail.log.clientSentAt, 1789883998000);
  assert.ok(detail.log.serverReceivedAt > 0);
  assert.ok(detail.log.handleStartedAt !== null, 't2 已回填');
  assert.ok(detail.log.serverRespondedAt !== null, 't5 已回填');
  assert.ok(
    detail.log.handleStartedAt! >= detail.log.serverReceivedAt &&
      detail.log.serverRespondedAt! >= detail.log.handleStartedAt!,
    't1 ≤ t2 ≤ t5'
  );
  assert.equal(detail.log.status, 'success');
  assert.equal(detail.log.responseCode, 200);
  assert.equal(detail.log.errorMessage, '');
  assert.equal(detail.log.answer, '统一 Agent 回复');
  assert.equal(detail.log.citations, '[]', '成功 citations 恒为数组字符串');
});

test('埋点：缺失 X-Trace-Id 时服务端兜底生成 UUID v4 并随响应头返回（前端补报以响应头为准）', async (t) => {
  const { baseUrl, logStore } = await startServer(t);

  const res = await post(baseUrl, '/api/chat', { message: '你好' });

  assert.equal(res.status, 200);
  const traceId = res.headers.get('x-trace-id');
  assert.ok(traceId, '响应头必须回写 X-Trace-Id');
  assert.match(traceId!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  logStore.flush();
  const detail = logStore.queryDetail(traceId!)!;
  assert.equal(detail.log.traceId, traceId);
  assert.equal(detail.log.logType, 'chat');
  assert.equal(detail.log.userInput, '你好');
  assert.equal(detail.log.clientSentAt, null, '未上报 X-Client-Sent-At 时为 NULL');
});

test('埋点：校验失败（400 / 413）也落主表一条，handle_started_at 为 NULL', async (t) => {
  const { baseUrl, logStore } = await startServer(t);

  const empty = await post(baseUrl, '/api/chat', { message: '' });
  assert.equal(empty.status, 400);
  const badTrace = empty.headers.get('x-trace-id')!;

  const tooLong = await post(baseUrl, '/api/chat', { message: 'x'.repeat(301) });
  assert.equal(tooLong.status, 413);
  const longTrace = tooLong.headers.get('x-trace-id')!;

  logStore.flush();
  const bad = logStore.queryDetail(badTrace)!;
  assert.equal(bad.log.status, 'failed');
  assert.equal(bad.log.responseCode, 400);
  assert.equal(bad.log.errorMessage, 'message 不能为空');
  assert.equal(bad.log.handleStartedAt, null, '未入队的校验失败请求 t2 为 NULL');
  assert.ok(bad.log.serverRespondedAt !== null, 't5 回填校验失败响应时刻');
  assert.equal(bad.log.answer, null);
  assert.equal(bad.log.citations, null);

  const long = logStore.queryDetail(longTrace)!;
  assert.equal(long.log.status, 'failed');
  assert.equal(long.log.responseCode, 413);
  assert.equal(long.log.errorMessage, '消息不能超过 300 字符');
  assert.equal(long.log.handleStartedAt, null);
  assert.equal(long.log.answer, null);
});

test('埋点：编排异常 → 500 回填 failed；工具异常 → 503 回填 failed', async (t) => {
  const { baseUrl, logStore } = await startServer(t, {
    agent: new StubAgent({ error: new Error('对话编排崩了') }),
  });

  const res = await post(baseUrl, '/api/chat', { message: '你好' });
  assert.equal(res.status, 500);
  const traceId = res.headers.get('x-trace-id')!;

  logStore.flush();
  const detail = logStore.queryDetail(traceId)!;
  assert.equal(detail.log.status, 'failed');
  assert.equal(detail.log.responseCode, 500);
  assert.equal(detail.log.errorMessage, '处理请求失败，请稍后重试');
  assert.ok(detail.log.handleStartedAt !== null, '异常发生在出队后，t2 已回填');
  assert.ok(detail.log.serverRespondedAt !== null);
  assert.equal(detail.log.answer, null);
});

test('埋点：ToolExecutionError → 503 回填 failed（工具服务不可用）', async (t) => {
  const { baseUrl, logStore } = await startServer(t, {
    agent: new StubAgent({ error: new ToolExecutionError('sango_novel_search') }),
  });

  const res = await post(baseUrl, '/api/chat', { message: '你好' });
  assert.equal(res.status, 503);
  const traceId = res.headers.get('x-trace-id')!;

  logStore.flush();
  const detail = logStore.queryDetail(traceId)!;
  assert.equal(detail.log.status, 'failed');
  assert.equal(detail.log.responseCode, 503);
  assert.equal(detail.log.errorMessage, '工具服务暂不可用，请稍后重试');
});

test('埋点：并发请求串行队列——后入队的请求 durations.queueWait > 0（验收⑥）', async (t) => {
  const { baseUrl, logStore } = await startServer(t, {
    agent: new StubAgent({ delayMs: 80 }),
  });

  const responses = await Promise.all([
    post(baseUrl, '/api/chat', { message: '第一问' }),
    post(baseUrl, '/api/chat', { message: '第二问' }),
  ]);
  assert.deepEqual(responses.map((res) => res.status), [200, 200]);

  logStore.flush();
  const list = logStore.queryList({}).list;
  assert.equal(list.length, 2);
  const waited = list.filter((item) => item.durations.queueWait !== null && item.durations.queueWait > 0);
  assert.ok(waited.length >= 1, '串行队列中至少一个请求 queueWait > 0');
});

test('旁路：埋点存储抛错时 /api/chat 仍 200 正常返回（故障注入，验收⑪）', async (t) => {
  const throwingStore = new ThrowingStore() as unknown as LogStore;
  const { baseUrl } = await startServer(t, { logStore: throwingStore });

  const res = await post(baseUrl, '/api/chat', { message: '你好' });

  assert.equal(res.status, 200);
  assert.equal(res.body.code, 200);
  assert.equal(res.body.data.answer, '统一 Agent 回复');
  assert.equal(res.body.message, '');
  assert.ok(res.headers.get('x-trace-id'), '兜底 traceId 仍随响应头返回');
});

/** 所有方法都抛错：模拟存储故障，验证埋点旁路（查询接口 500 见 logs-api.test.ts） */
class ThrowingStore {
  private throw(): never {
    throw new Error('injected storage failure');
  }

  ensureSkeleton(): void { this.throw(); }
  markHandled(): void { this.throw(); }
  markResponded(): void { this.throw(); }
  appendLlmCall(): void { this.throw(); }
  appendToolCall(): void { this.throw(); }
  reportFrontendEnd(): void { this.throw(); }
  flush(): void { this.throw(); }
  runRetentionCleanup(): void { this.throw(); }
  close(): void { this.throw(); }
  queryList(): never { this.throw(); }
  queryDetail(): never { this.throw(); }
  queryTokenStats(): never { this.throw(); }
}
