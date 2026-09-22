// feat-A010/A011 模型可见工具白名单测试（硬约束专项，测试即文档）：
// 覆盖：器坊注册 sango_novel_chapter 后 transport.listTools() 含它，但模型可见工具不含它；
// feat-A011 天气下线：get-forecast / get-alerts 不再进入白名单（4 个能力工具）；
// options.tools 注入路径同样过白名单（「模型可见 = 白名单」恒成立）；
// 模型可见 description 被瘦身（接口文档 §1.2 全文），MCP 侧原文不被原地修改；
// agent.listTools()（/api/tools 同源）不含天气与后台专用工具；后台 HTTP 直调不受影响。
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

/** 瘦身后模型可见 description（接口文档 §1.2，全文） */
const SLIM_DESCRIPTIONS: Record<string, string> = {
  sango_novel_search:
    '检索《三国演义》原著原文。仅当用户询问原著情节/人物/事件等需要原文依据的问题时调用；返回结构化条目数组，禁止凭记忆作答。',
  fengyunsanguo_query:
    '风云三国题库候选召回：text 传用户原始问法，返回候选题目（题干→答案），供 LLM 判定对应题。',
  fengyunsanguo_quiz_command:
    '风云三国随机一题状态机（本地规则，不经 LLM）：随机出题/判题/查答案，按 sessionId 维持会话。',
  fengyunsanguo_quiz_route:
    '风云三国 L3 高置信识别（不经 LLM）：判定 text 是否为题库内问题，返回 JSON true/false。',
};

/** 白名单最终形态：4 个能力工具，无天气、无后台专用工具 */
const VISIBLE_NAMES = [
  'fengyunsanguo_query',
  'fengyunsanguo_quiz_command',
  'fengyunsanguo_quiz_route',
  'sango_novel_search',
].sort();

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

test('① 白名单过滤（transport 来源）：不含天气工具与 sango_novel_chapter，description 替换为瘦身文本', async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const agent = new Agent(transport, makeConfig());

  const reported = await agent.listTools();
  const names = reported.map((tool) => tool.name).sort();
  assert.deepEqual(names, VISIBLE_NAMES);
  assert.ok(!names.includes('sango_novel_chapter'), '模型可见工具不得含后台专用工具');
  for (const tool of reported) {
    assert.equal(tool.description, SLIM_DESCRIPTIONS[tool.name]!, '描述应替换为 §1.2 瘦身全文');
  }
});

test('② options.tools 注入路径同样过白名单：无天气工具，MCP 侧原文未被原地修改', async () => {
  const transport = new MockTransport([]);
  const agent = new Agent(transport, makeConfig(), { tools: ALL_TOOLS });

  const reported = await agent.listTools();
  const names = reported.map((tool) => tool.name).sort();
  assert.deepEqual(names, VISIBLE_NAMES);
  assert.equal(transport.listToolsCount, 0, '注入 tools 后不应查 transport');
  // 白名单过滤 + 描述替换是拷贝展开，不得原地改动 options.tools 里的原对象
  const original = ALL_TOOLS.find((tool) => tool.name === 'fengyunsanguo_query')!;
  assert.equal(original.description, '风云三国题库检索', 'MCP 侧 description 原文一字不动');
});

test('③ LLM 请求不携带 tools：分类轮与生成轮 tools 恒为空数组', async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const seenTools: MCPToolDefinition[][] = [];
  const modelCaller = async (
    _messages: unknown[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    return textResponse('回复');
  };

  const agent = new Agent(transport, makeConfig(), { tools: ALL_TOOLS, modelCaller });
  await agent.processQuery('你好');

  assert.equal(seenTools.length, 2, 'auto 应分分类轮 + 生成轮');
  for (const tools of seenTools) {
    assert.equal(tools.length, 0, 'feat-A011：LLM 请求不再携带工具定义');
  }
});

test('④ 后台 HTTP 直调不受影响：transport.callTool 仍可调 sango_novel_chapter', async () => {
  const transport = new MockTransport(ALL_TOOLS);

  // 路由层直调（不经 agent / 不经过滤），等价于 /api/v1/sango/chapters/:chapter 的实现路径
  const result = await transport.callTool('sango_novel_chapter', { chapter: 73 });
  assert.equal(result.content[0].text, 'ok');
  assert.deepEqual(transport.callToolCalls, [{ name: 'sango_novel_chapter', args: { chapter: 73 } }]);
});