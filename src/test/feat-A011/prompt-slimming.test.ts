import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  CLASSIFY_SYSTEM_PROMPT,
  FENGYUNSANGUO_DOMAIN_PROMPT,
  FREE_CHAT_SYSTEM_PROMPT,
  SANGO_NOVEL_DOMAIN_PROMPT,
  parseClassifyRouteId,
} from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import type {
  LLMConfig,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "../../types.js";

/**
 * feat-A011 提示词瘦身专项（接口文档 §2 / §6 验收清单的 agent 侧条目，测试即文档）：
 * 分类轮无 tools / 编号解析 / 快路径生成轮无 tools / 生成轮消息顺序 /
 * 统一提示词无天气条款 / 白名单无天气工具 / 描述瘦身。
 */

class MockTransport extends MCPTransport {
  listToolsCount = 0;
  constructor(private tools: MCPToolDefinition[]) {
    super("mock-server");
  }
  override async listTools(): Promise<MCPToolDefinition[]> {
    this.listToolsCount += 1;
    return this.tools;
  }
  override async callTool(
    _name: string,
    _args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    return { content: [{ type: "text", text: "ok" }] };
  }
}

const ALL_TOOLS: MCPToolDefinition[] = [
  { name: "get-forecast", description: "天气预报", inputSchema: {} },
  { name: "get-alerts", description: "天气预警", inputSchema: {} },
  { name: "fengyunsanguo_query", description: "题库检索", inputSchema: {} },
  { name: "fengyunsanguo_quiz_command", description: "随机一题", inputSchema: {} },
  { name: "fengyunsanguo_quiz_route", description: "高置信识别", inputSchema: {} },
  { name: "sango_novel_search", description: "原著检索", inputSchema: {} },
];

const RECALL_TEXT = JSON.stringify([
  {
    id: "sanguo-yanyi:0005:c0001",
    text: "众皆大惊曰：“云长提刀出阵，斩华雄于帐前！”",
    chapter: 5,
    title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    type: "narration",
    segFrom: 4,
    segTo: 4,
    quoteBalanced: true,
    quotes: [{ offset: 7, len: 13 }],
  },
]);

function makeConfig(): LLMConfig {
  return {
    provider: "deepseek",
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }] };
}

/** 记录每轮 stage / tools / 消息形状 */
class RecordingAgent extends Agent {
  calls: Array<{ stage?: string; tools: MCPToolDefinition[]; messages: any[] }> = [];

  protected override async callModel(
    messages: any[],
    tools: MCPToolDefinition[],
    stage?: string
  ): Promise<ModelResponse> {
    this.calls.push({ stage, tools: [...tools], messages: [...messages] });
    return textResponse("回复");
  }
}

test("分类轮请求体无 tools：auto 首轮仅 [system 分类提示 + user 问题]，stage=classify，生成轮 stage=generation 也无 tools", async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const agent = new RecordingAgent(transport, makeConfig(), { tools: ALL_TOOLS });

  await agent.processQuery("你好");

  assert.equal(agent.calls.length, 2);
  const classify = agent.calls[0]!;
  assert.equal(classify.stage, "classify", "auto 首轮日志 stage=classify");
  assert.deepEqual(classify.tools, [], "分类轮请求体无 tools");
  assert.equal(classify.messages.length, 2, "分类轮仅 system 分类提示 + user 问题");
  assert.equal(classify.messages[0].content, CLASSIFY_SYSTEM_PROMPT);
  const generation = agent.calls[1]!;
  assert.equal(generation.stage, "generation");
  assert.deepEqual(generation.tools, [], "生成轮不携带 tools");
});

test("编号解析 4 例：2.xxx→2 / 99→99 / 空→99 / 非数字→99（无法解析按 99，不重试）", () => {
  const asContent = (text: string): unknown => [{ type: "text", text }];
  assert.equal(parseClassifyRouteId(asContent("2. 原著检索")), 2, "2.xxx → 2");
  assert.equal(parseClassifyRouteId(asContent("99")), 99, "99 → 99");
  assert.equal(parseClassifyRouteId(asContent("")), 99, "空 → 99");
  assert.equal(parseClassifyRouteId(asContent("原著")), 99, "非数字 → 99");
  assert.equal(parseClassifyRouteId([]), 99, "无文本内容 → 99");
});

test("快路径生成轮无 tools：domain=sango-novel 预调 + 注入后单轮生成，工具列表恒为空", async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const seenTools: MCPToolDefinition[][] = [];
  const modelCaller = async (
    _messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    // 泛答不含人物名/指针：引用校验早退，保持「单轮生成」断言聚焦 A011 消息排布（引用行为见 agent-novel）
    return textResponse("这是测试回复。");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: ALL_TOOLS,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    modelCaller,
  });

  await agent.processQuery("谁斩了华雄？", "sango-novel");

  assert.equal(seenTools.length, 1, "域锁定只走一轮生成");
  assert.deepEqual(seenTools[0]!, [], "快路径生成轮无 tools");
});

test("生成轮消息顺序：system 域提示 → user 用户问题 → system 注入片段（注入恒在末尾，静态前缀稳定）", async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const capturedMessages: any[] = [];
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    capturedMessages.push(...messages);
    // 泛答不含人物名/指针：引用校验早退，注入片段恒在生成轮末尾（引用行为见 agent-novel）
    return textResponse("这是测试回复。");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: ALL_TOOLS,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    modelCaller,
  });

  await agent.processQuery("谁斩了华雄？", "sango-novel");

  assert.equal(capturedMessages.length, 3);
  assert.equal(capturedMessages[0].role, "system");
  assert.equal(capturedMessages[0].content, SANGO_NOVEL_DOMAIN_PROMPT, "首条为域提示");
  assert.equal(capturedMessages[1].role, "user");
  assert.equal(capturedMessages[1].content, "谁斩了华雄？");
  assert.equal(capturedMessages[2].role, "system");
  assert.ok(
    capturedMessages[2].content.includes("云长提刀出阵，斩华雄于帐前！"),
    "注入片段恒在末尾"
  );
});

test("统一提示词已无天气条款：分类 / 两能力域 / 自由对话四常量均不含天气能力与工具", () => {
  const all = [
    CLASSIFY_SYSTEM_PROMPT,
    SANGO_NOVEL_DOMAIN_PROMPT,
    FENGYUNSANGUO_DOMAIN_PROMPT,
    FREE_CHAT_SYSTEM_PROMPT,
  ].join("\n");
  assert.doesNotMatch(all, /get-forecast|get-alerts/);
  assert.doesNotMatch(all, /美国天气播报/);
  assert.doesNotMatch(all, /仅适用于美国境内/);
  assert.doesNotMatch(all, /非美国天气域/);
  assert.doesNotMatch(all, /出门必备/);
});

test("白名单已无天气工具：listTools 仅返回 4 个能力工具，且 description 替换为 §1.2 瘦身全文", async () => {
  const transport = new MockTransport(ALL_TOOLS);
  const agent = new Agent(transport, makeConfig());

  const reported = await agent.listTools();
  const names = reported.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "fengyunsanguo_query",
    "fengyunsanguo_quiz_command",
    "fengyunsanguo_quiz_route",
    "sango_novel_search",
  ]);
  const byName = Object.fromEntries(reported.map((tool) => [tool.name, tool.description]));
  assert.equal(
    byName["sango_novel_search"],
    "检索《三国演义》原著原文。仅当用户询问原著情节/人物/事件等需要原文依据的问题时调用；返回结构化条目数组，禁止凭记忆作答。"
  );
  assert.equal(
    byName["fengyunsanguo_query"],
    "风云三国题库候选召回：text 传用户原始问法，返回候选题目（题干→答案），供 LLM 判定对应题。"
  );
  assert.equal(
    byName["fengyunsanguo_quiz_command"],
    "风云三国随机一题状态机（本地规则，不经 LLM）：随机出题/判题/查答案，按 sessionId 维持会话。"
  );
  assert.equal(
    byName["fengyunsanguo_quiz_route"],
    "风云三国 L3 高置信识别（不经 LLM）：判定 text 是否为题库内问题，返回 JSON true/false。"
  );
});
