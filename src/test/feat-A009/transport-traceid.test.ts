import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCPTransport,
  SANGO_SERVER_NAME,
  type MCPServerConfig,
  type MCPServerConnection,
  type MCPServerConnectionFactory,
} from '../../transport.js';
import { runWithTraceId } from '../../trace.js';
import { createLogStore, truncate } from '../../storage/logs.js';
import type { MCPToolDefinition, ToolCallResult } from '../../types.js';

const NOVEL: MCPToolDefinition = {
  name: 'sango_novel_search',
  description: '检索《三国演义》原著原文段落',
  inputSchema: { type: 'object' },
};

const SAMPLE_DIAGNOSTICS = {
  truncated: false,
  truncatedCount: 0,
  query: { raw: '关羽千里走单骑', normalized: '关羽 千里走单骑', tokens: ['关羽', '千里走单骑'] },
  env: { vectorScheme: 'bge-m3', degradedBm25Only: false, corpusChunks: 2344, aliasCount: 87, vectorDim: 1024 },
  funnel: { corpusChunks: 2344, lexicalHits: 42, vectorTop50: 50, labelHits: 3, mergedCandidates: 45, topN: 10, injected: null, cited: null },
  candidates: [],
  nextRank: null,
  deathIntent: { detected: false, pinned: false, chunkIds: [] },
};

/** 记录 callTool 第三参 meta 的假连接（feat-A009 验证 traceId 注入 / retrievalSeq 透传） */
class MetaRecordingConnection implements MCPServerConnection {
  calls: Array<{ name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }> = [];

  constructor(
    public tools: MCPToolDefinition[],
    private result: ToolCallResult
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
    return this.result;
  }
  async close(): Promise<void> {}
}

class RecordingFactory implements MCPServerConnectionFactory {
  connections: MetaRecordingConnection[] = [];
  constructor(
    private toolsByServer: Record<string, MCPToolDefinition[]>,
    private result: ToolCallResult
  ) {}
  create(config: MCPServerConfig): MCPServerConnection {
    const connection = new MetaRecordingConnection(this.toolsByServer[config.name] ?? [], this.result);
    this.connections.push(connection);
    return connection;
  }
}

function sangoConfig(): MCPServerConfig[] {
  return [{ name: SANGO_SERVER_NAME, scriptPath: 's.js', required: false }];
}

const TRACE_ID = '9f7c0000-0000-4000-8000-00000000000a';

test('① 请求上下文就位：tools/call 转发统一注入 _meta.traceId（全部工具一致，验收 11）', async () => {
  const factory = new RecordingFactory({ sango: [NOVEL] }, { content: [{ type: 'text', text: 'ok' }] });
  const transport = new MCPTransport(sangoConfig(), factory);
  await transport.connect();
  await transport.listTools();

  await runWithTraceId(TRACE_ID, () => transport.callTool('sango_novel_search', { query: '关羽' }));

  assert.equal(factory.connections.length, 1);
  const call = factory.connections[0].calls[0];
  assert.equal(call.name, 'sango_novel_search');
  assert.deepEqual(call.meta, { traceId: TRACE_ID }, '注入 _meta.traceId 且与请求上下文一致');
});

test('② 无请求上下文：不注入 _meta，tools/call 参数与旧契约一致', async () => {
  const factory = new RecordingFactory({ sango: [NOVEL] }, { content: [{ type: 'text', text: 'ok' }] });
  const transport = new MCPTransport(sangoConfig(), factory);
  await transport.connect();
  await transport.listTools();

  await transport.callTool('sango_novel_search', { query: '关羽' });

  assert.equal(factory.connections[0].calls[0].meta, undefined, '上下文缺失时不注入');
});

test('③ 剥离 _meta.diagnostics：result_summary 不含诊断（硬约束 2，验收 13）', async () => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  const result: ToolCallResult = {
    content: [{ type: 'text', text: '[{"id":"sango-yanyi:0073:c0007"}]' }],
    _meta: { diagnostics: SAMPLE_DIAGNOSTICS },
  };
  const factory = new RecordingFactory({ sango: [NOVEL] }, result);
  const transport = new MCPTransport(sangoConfig(), factory, logStore);
  await transport.connect();
  await transport.listTools();

  // 骨架由 server 中间件建（transport 只写 tool_call_logs 明细）；此处按真实流程补建后调用
  logStore.ensureSkeleton('chat', TRACE_ID, 'q', 'sango-novel', 1000);
  await runWithTraceId(TRACE_ID, () => transport.callTool('sango_novel_search', { query: '关羽' }));
  logStore.flush();

  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.toolCalls.length, 1);
  const summary = detail.toolCalls[0].resultSummary!;
  assert.ok(!summary.includes('diagnostics'), 'result_summary 不含诊断');
  assert.ok(summary.includes('sango-yanyi:0073:c0007'), 'content 完整保留');
});

test('④ 回传诊断时透传 retrievalSeq（工具明细行号，供 agent 收尾回填后落库）', async () => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  const result: ToolCallResult = {
    content: [{ type: 'text', text: 'ok' }],
    _meta: { diagnostics: SAMPLE_DIAGNOSTICS },
  };
  const factory = new RecordingFactory({ sango: [NOVEL] }, result);
  const transport = new MCPTransport(sangoConfig(), factory, logStore);
  await transport.connect();
  await transport.listTools();

  logStore.ensureSkeleton('chat', TRACE_ID, 'q', 'sango-novel', 1000);
  const returned = await runWithTraceId(TRACE_ID, () =>
    transport.callTool('sango_novel_search', { query: '关羽' })
  );

  assert.equal(returned._meta?.retrievalSeq, 1, 'retrievalSeq=appendToolCall 返回的行号');
  assert.deepEqual(returned._meta?.diagnostics, SAMPLE_DIAGNOSTICS, '诊断原样保留给 agent 回填');
});

test('⑤ 无 trace 上下文时不落工具明细，也不透传 retrievalSeq', async () => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  const result: ToolCallResult = {
    content: [{ type: 'text', text: 'ok' }],
    _meta: { diagnostics: SAMPLE_DIAGNOSTICS },
  };
  const factory = new RecordingFactory({ sango: [NOVEL] }, result);
  const transport = new MCPTransport(sangoConfig(), factory, logStore);
  await transport.connect();
  await transport.listTools();

  const returned = await transport.callTool('sango_novel_search', { query: '关羽' });
  logStore.flush();

  assert.equal(returned._meta?.retrievalSeq, undefined, '无上下文不透传行号');
  assert.equal(logStore.queryDetail(TRACE_ID), null, '无上下文不落工具明细');
});

test('⑥ 大出参 + 大诊断：剥离后 result_summary 仍完整、不被 8000 截断（硬约束 2，验收 13）', async () => {
  const logStore = createLogStore({ dbPath: ':memory:' });
  // TRUNCATE_MARKER 未导出，用 truncate 反推实际常量值，避免与实现漂移
  const TRUNCATE_MARKER = truncate('x'.repeat(9000), 1)!.slice(1);
  // 贴近真实体量的出参：20 条候选原文段落，序列化后约 7000 字符
  const paragraphs = Array.from({ length: 20 }, (_, i) => ({
    id: `sango-yanyi:${String(i + 1).padStart(4, '0')}:c0007`,
    text: `关公${'义'.repeat(300)}【尾条目${i}】`,
  }));
  const contentText = JSON.stringify(paragraphs);
  // 大诊断载荷：20 条候选各带长 title，序列化后数十 KB
  const bigDiagnostics = {
    ...SAMPLE_DIAGNOSTICS,
    candidates: Array.from({ length: 20 }, (_, i) => ({
      chunkId: `sango-yanyi:0073:c${String(i).padStart(4, '0')}`,
      title: `第${i}条候选段落标题：${'关羽千里走单骑原文片段'.repeat(120)}`,
      score: 0.87 - i * 0.01,
      lexical: 1.2,
      vector: 0.9,
    })),
  };
  const result: ToolCallResult = {
    content: [{ type: 'text', text: contentText }],
    _meta: { diagnostics: bigDiagnostics },
  };
  const factory = new RecordingFactory({ sango: [NOVEL] }, result);
  const transport = new MCPTransport(sangoConfig(), factory, logStore);
  await transport.connect();
  await transport.listTools();

  logStore.ensureSkeleton('chat', TRACE_ID, 'q', 'sango-novel', 1000);
  await runWithTraceId(TRACE_ID, () => transport.callTool('sango_novel_search', { query: '关羽' }));
  logStore.flush();

  const detail = logStore.queryDetail(TRACE_ID)!;
  assert.equal(detail.toolCalls.length, 1);
  const summary = detail.toolCalls[0].resultSummary!;
  assert.ok(!summary.includes('diagnostics'), 'result_summary 不含诊断');
  assert.ok(!summary.includes(TRUNCATE_MARKER), 'result_summary 未被 8000 截断');
  assert.ok(summary.length <= 8000, `result_summary 未超 8000（实际 ${summary.length}）`);
  assert.ok(summary.includes('sango-yanyi:0001:c0007'), 'content 首部完整保留');
  assert.ok(summary.includes('【尾条目19】'), 'content 尾部完整保留');

  // 对照：同一 result 若不剥离诊断，直接序列化必然超 8000 被截断
  const withoutStrip = truncate(JSON.stringify(result))!;
  assert.ok(withoutStrip.includes(TRUNCATE_MARKER), '不剥离时 result_summary 会被截断');
});
