// feat-A010 模型可见工具白名单测试（硬约束专项，测试即文档）：
// 覆盖：器坊注册 sango_novel_chapter 后 transport.listTools() 含它，但模型可见工具不含它；
// options.tools 注入路径同样过白名单（「模型可见 = 白名单」恒成立）；
// agent.listTools()（/api/tools 同源）不含后台专用工具；后台 HTTP 直调不受影响（路由层仍可调）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../agent.js';
import { MCPTransport } from '../../transport.js';
import type {
  LLMConfig,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from '../../types.js';

const ALL_TOOLS: MCPToolDefinition[] = [
  { name: 'get-alerts', description: '天气预警', inputSchema: {} },
  { name: 'get-forecast', description: '天气预报', inputSchema: {} },
  { name: 'fengyunsanguo_query', description: '风云三国题库检索', inputSchema: {} },
  { name: 'fengyunsanguo_quiz_command', description: '随机一题状态机', inputSchema: {} },
  { name: 'fengyunsanguo_quiz_route', description: '高置信识别', inputSchema: {} },
  { name: 'sango_novel_search', description: '演义原文检索', inputSchema: {} },
  // 后台专用工具（feat-A010）：器坊已注册，必须被白名单过滤
  { name: 'sango_novel_chapter', description: '按回取整回原文（后台直调）', inputSchema: {} },
];

class MockTransport extends MCPTransport {
  listToolsCount = 0;
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private tools: MCPToolDefinition[]) {
    super('mock-server');
  }
  override async listTools(): Promise<MCPToolDefinition[]> {
    this.listToolsCount += 1;
    return this.tools;
  }
  override async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    this.callToolCalls.push({ name, args });
    return { content: [{ type: 'text', text: 'ok' }] };
  }
}

function makeConfig(): LLMConfig {
  return { provider: 'deepseek', model: 'test', apiKey: 'x', apiBaseUrl: 'http://x' };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: 'text', text }] };
}

test('① 白名单过滤：模型可见工具不含 sango_novel_chapter（transport 来源）', async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const seenTools: MCPToolDefinition[][] = [];
  const modelCaller = async (
    _messages: unknown[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    return textResponse('回复');
  };

  const agent = new Agent(transport, makeConfig(), { modelCaller });
  await agent.processQuery('你好');

  assert.equal(transport.listToolsCount, 1);
  assert.equal(seenTools.length, 1);
  const names = seenTools[0]!.map((tool) => tool.name);
  assert.ok(!names.includes('sango_novel_chapter'), '模型可见工具不得含后台专用工具');
  assert.deepEqual(names.sort(), ['fengyunsanguo_query', 'fengyunsanguo_quiz_command', 'fengyunsanguo_quiz_route', 'get-alerts', 'get-forecast', 'sango_novel_search']);
});

test('② options.tools 注入路径同样过白名单：sango_novel_chapter 被过滤', async () => {
  const transport = new MockTransport([]);
  const seenTools: MCPToolDefinition[][] = [];
  const modelCaller = async (
    _messages: unknown[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    return textResponse('回复');
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: ALL_TOOLS,
    modelCaller,
  });
  await agent.processQuery('你好');

  assert.equal(transport.listToolsCount, 0, '注入 tools 后不应查 transport');
  const names = seenTools[0]!.map((tool) => tool.name);
  assert.ok(!names.includes('sango_novel_chapter'));
});

test('③ agent.listTools()（/api/tools 同源）不含后台专用工具', async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const agent = new Agent(transport, makeConfig());

  const reported = await agent.listTools();
  const names = reported.map((tool) => tool.name);
  assert.ok(!names.includes('sango_novel_chapter'));
  assert.deepEqual(names.sort(), ['fengyunsanguo_query', 'fengyunsanguo_quiz_command', 'fengyunsanguo_quiz_route', 'get-alerts', 'get-forecast', 'sango_novel_search']);
});

test('④ 后台 HTTP 直调不受影响：transport.callTool 仍可调 sango_novel_chapter', async () => {
  const transport = new MockTransport(ALL_TOOLS);

  // 路由层直调（不经 agent / 不经过滤），等价于 /api/v1/sango/chapters/:chapter 的实现路径
  const result = await transport.callTool('sango_novel_chapter', { chapter: 73 });
  assert.equal(result.content[0].text, 'ok');
  assert.deepEqual(transport.callToolCalls, [{ name: 'sango_novel_chapter', args: { chapter: 73 } }]);
});
