// feat-A013 callInternal 测试（测试即文档）：覆盖接口文档 §1.7.2 三不原则——
// 不落 tool_call_logs / 不注入 _meta.traceId / 不包装 ToolExecutionError（失败以 isError 形态返回），
// 以及按 toolToServer 路由（验收 15 语义工具内部调用旁路口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCPTransport,
  SANGO_SERVER_NAME,
  FENGYUNSANGUO_SERVER_NAME,
  type MCPServerConfig,
  type MCPServerConnection,
  type MCPServerConnectionFactory,
  type InternalToolResult,
} from '../../transport.js';
import { runWithTraceId } from '../../trace.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { MCPToolDefinition, ToolCallResult } from '../../types.js';

const EMBED_TOOL: MCPToolDefinition = {
  name: 'sango_query_embed',
  description: '内部工具：query → BGE-M3 向量',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

const TRACE_ID = '9f7c0000-0000-4000-8000-00000000000a';

/** 记录调用（name / args / meta）的假连接；可配置成功结果或抛出 */
class RecordingConnection implements MCPServerConnection {
  calls: Array<{ name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }> = [];

  constructor(
    public tools: MCPToolDefinition[],
    private result: ToolCallResult | (() => ToolCallResult | Promise<ToolCallResult>),
    private fail: boolean
  ) {}

  async connect(): Promise<void> {}
  async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.calls.push({ name, args, meta });
    if (this.fail) {
      throw new Error('通道异常：connection closed');
    }
    return typeof this.result === 'function' ? this.result() : this.result;
  }
  async close(): Promise<void> {}
}

class RecordingFactory implements MCPServerConnectionFactory {
  connections: RecordingConnection[] = [];
  constructor(
    private toolsByServer: Record<string, MCPToolDefinition[]>,
    private result: ToolCallResult | (() => ToolCallResult | Promise<ToolCallResult>),
    private fail = false
  ) {}
  create(config: MCPServerConfig): MCPServerConnection {
    const connection = new RecordingConnection(this.toolsByServer[config.name] ?? [], this.result, this.fail);
    this.connections.push(connection);
    return connection;
  }
}

function configs(): MCPServerConfig[] {
  return [
    { name: SANGO_SERVER_NAME, scriptPath: 'sango.js', required: false },
    { name: FENGYUNSANGUO_SERVER_NAME, scriptPath: 'fengyun.js', required: false },
  ];
}

test('① callInternal 按 toolToServer 路由到归属 server，且不注入 _meta.traceId（无请求上下文时）', async () => {
  const factory = new RecordingFactory(
    { sango: [EMBED_TOOL], fengyunsanguo: [] },
    { content: [{ type: 'text', text: '{"dim":1024}' }] }
  );
  const transport = new MCPTransport(configs(), factory);
  await transport.connect();
  await transport.listTools();

  const result = await transport.callInternal('sango_query_embed', { query: '义释严颜是怎么回事' });

  assert.equal(result.isError, undefined, '成功结果不透传 isError 标志');
  assert.equal(result.content[0].text, '{"dim":1024}');
  const call = factory.connections[0].calls[0];
  assert.equal(call.name, 'sango_query_embed');
  assert.deepEqual(call.args, { query: '义释严颜是怎么回事' });
  assert.equal(call.meta, undefined, 'callInternal 不注入 meta');
});

test('② 请求上下文就位也不注入 _meta.traceId（三不原则，验收 15）', async () => {
  const factory = new RecordingFactory({ sango: [EMBED_TOOL] }, { content: [{ type: 'text', text: 'ok' }] });
  const transport = new MCPTransport(configs(), factory);
  await transport.connect();
  await transport.listTools();

  await runWithTraceId(TRACE_ID, () => transport.callInternal('sango_query_embed', { query: 'q' }));

  assert.deepEqual(factory.connections[0].calls[0].meta, undefined, '即使有 traceId 上下文也不注入');
});

test('③ callInternal 不落 tool_call_logs（三不原则；对比 callTool 同场景落明细）', async () => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  const factory = new RecordingFactory(
    { sango: [EMBED_TOOL, { name: 'sango_novel_search', description: 'd', inputSchema: {} }] },
    { content: [{ type: 'text', text: 'ok' }] }
  );
  const transport = new MCPTransport(configs(), factory, logStore);
  await transport.connect();
  await transport.listTools();
  logStore.ensureSkeleton('chat', TRACE_ID, 'q', 'sango-novel', 1000);

  await runWithTraceId(TRACE_ID, () => transport.callInternal('sango_query_embed', { query: 'q' }));
  logStore.flush();
  assert.equal(logStore.queryDetail(TRACE_ID)!.toolCalls.length, 0, '内部调用不产生工具明细');

  // 对照组：常规 callTool 同一 trace 落明细（既有契约不回退）
  await runWithTraceId(TRACE_ID, () => transport.callTool('sango_novel_search', { query: 'q' }));
  logStore.flush();
  assert.equal(logStore.queryDetail(TRACE_ID)!.toolCalls.length, 1, '常规 callTool 明细照落');
});

test('④ 通道异常 → 以 isError 形态返回，不抛出、不包装 ToolExecutionError（三不原则）', async () => {
  const factory = new RecordingFactory({ sango: [EMBED_TOOL] }, { content: [] }, true);
  const transport = new MCPTransport(configs(), factory);
  await transport.connect();
  await transport.listTools();

  let result: InternalToolResult | undefined;
  await assert.doesNotReject(async () => {
    result = await transport.callInternal('sango_query_embed', { query: 'q' });
  });
  assert.equal(result!.isError, true, '通道异常以 isError 返回');
  assert.ok((result!.content[0].text ?? '').length > 0, '附错误文本供排查');
});

test('⑤ 工具侧 isError=true 原样透传（不吞不包装）', async () => {
  const factory = new RecordingFactory(
    { sango: [EMBED_TOOL] },
    () => ({ content: [{ type: 'text', text: '内部错误文案' }], isError: true })
  );
  const transport = new MCPTransport(configs(), factory);
  await transport.connect();
  await transport.listTools();

  const result = await transport.callInternal('sango_query_embed', { query: 'q' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, '内部错误文案');
});

test('⑥ 未知工具名 → isError 形态返回（不抛出）', async () => {
  const factory = new RecordingFactory({ sango: [EMBED_TOOL] }, { content: [] });
  const transport = new MCPTransport(configs(), factory);
  await transport.connect();
  await transport.listTools();

  let result: InternalToolResult | undefined;
  await assert.doesNotReject(async () => {
    result = await transport.callInternal('no_such_tool', {});
  });
  assert.equal(result!.isError, true, '未知工具同样以 isError 返回，供缓存层降级旁路');
});

test('⑦ callInternal 失败形态不抛 503（不包装 ToolExecutionError，验收 15 口径：不抛 503）', async () => {
  const factory = new RecordingFactory({ sango: [EMBED_TOOL] }, { content: [] }, true);
  const transport = new MCPTransport(configs(), factory);
  await transport.connect();
  await transport.listTools();

  const result = await transport.callInternal('sango_query_embed', { query: 'q' });
  assert.equal(result.isError, true);
  assert.ok(!(result instanceof Error), '返回对象是 ToolCallResult 形态而非异常实例');
});

test('⑧ 全程无日志副作用：callInternal 失败路径也不落明细（含无请求上下文场景）', async () => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  t_after(logStore);
  const factory = new RecordingFactory({ sango: [EMBED_TOOL] }, { content: [] }, true);
  const transport = new MCPTransport(configs(), factory, logStore);
  await transport.connect();
  await transport.listTools();

  await transport.callInternal('sango_query_embed', { query: 'q' });
  logStore.flush();
  assert.equal(logStore.queryList({}).total, 0, '内部调用失败也不产生任何日志行');
});

function t_after(store: LogStore): void {
  test.after(() => store.close());
}
