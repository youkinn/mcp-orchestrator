import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_ROUTE_IDS,
  FENGYUNSANGUO_DOMAIN_PROMPT,
  FENGYUNSANGUO_QUERY_TOOL,
  FREE_CHAT_SYSTEM_PROMPT,
  SANGO_NOVEL_DOMAIN_PROMPT,
} from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import {
  ToolExecutionError,
  type LLMConfig,
  type LLMProvider,
  type MCPToolDefinition,
  type ModelResponse,
  type ToolCallResult,
} from "../../types.js";

/** Mock Transport：只记录调用，不发真实 MCP 连接；可注入 callTool 异常 */
class MockTransport extends MCPTransport {
  listToolsCount = 0;
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  callToolError: Error | null = null;

  constructor(private tools: MCPToolDefinition[] = []) {
    super("mock-server");
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    this.listToolsCount += 1;
    return this.tools;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.callToolCalls.push({ name, args });
    if (this.callToolError) {
      throw this.callToolError;
    }
    return { content: [{ type: "text", text: `transport-result:${name}` }] };
  }
}

const NOVEL_TOOL: MCPToolDefinition = {
  name: "sango_novel_search",
  description: "《三国演义》原著检索",
  inputSchema: { type: "object" },
};

const FYS_QUERY_TOOL: MCPToolDefinition = {
  name: FENGYUNSANGUO_QUERY_TOOL,
  description: "风云三国题库检索",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

const QUIZ_COMMAND_TOOL: MCPToolDefinition = {
  name: "fengyunsanguo_quiz_command",
  description: "随机一题状态机",
  inputSchema: { type: "object" },
};

const QUIZ_ROUTE_TOOL: MCPToolDefinition = {
  name: "fengyunsanguo_quiz_route",
  description: "高置信识别",
  inputSchema: { type: "object" },
};

const WHITELIST_TOOLS: MCPToolDefinition[] = [
  NOVEL_TOOL,
  FYS_QUERY_TOOL,
  QUIZ_COMMAND_TOOL,
  QUIZ_ROUTE_TOOL,
];

const WEATHER_TOOLS: MCPToolDefinition[] = [
  { name: "get-forecast", description: "天气预报", inputSchema: { type: "object" } },
  { name: "get-alerts", description: "天气预警", inputSchema: { type: "object" } },
];

/** 原著召回出参（裸 JSON 数组，与 mcp-server 同构） */
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

function makeConfig(provider: LLMProvider = "deepseek"): LLMConfig {
  return {
    provider,
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }] };
}

/** 记录每轮 stage / tools / 消息形状的 RecordingAgent */
class StageRecordingAgent extends Agent {
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

test("路由判定：L1 domain 锁定两能力域（source=label）；天气关键词不再命中路由（纽约天气 → auto）", () => {
  const transport = new MockTransport();
  const agent = new Agent(transport, makeConfig());

  assert.deepEqual(agent.resolveRoute("你好", "sango-novel"), {
    route: "sango-novel",
    source: "label",
  });
  assert.deepEqual(agent.resolveRoute("你好", "fengyunsanguo"), {
    route: "fengyunsanguo",
    source: "label",
  });
  assert.deepEqual(agent.resolveRoute("风云三国答题", "fengyunsanguo"), {
    route: "fengyunsanguo",
    source: "label",
  });
  assert.deepEqual(agent.resolveRoute("谁斩了华雄", "sango-novel"), {
    route: "sango-novel",
    source: "label",
  });
  assert.deepEqual(agent.resolveRoute("纽约今天适合坐地铁吗？"), {
    route: "auto",
    source: null,
  }, "天气能力下线：天气关键词不再路由到 weather");
  assert.deepEqual(agent.resolveRoute("你好"), { route: "auto", source: null });
});

test("快路径生成轮：domain=sango-novel 预调 sango_novel_search + 注入 + 域提示，不携带 tools", async () => {
  const transport = new MockTransport(WHITELIST_TOOLS);
  const seenTools: MCPToolDefinition[][] = [];
  const seenMessages: any[][] = [];
  const modelCaller = async (
    messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    seenMessages.push([...messages]);
    // 泛答不含人物名/指针：引用校验早退，保持「单轮生成」断言聚焦 A011 消息排布（引用行为见 agent-novel）
    return textResponse("这是测试回复。");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    modelCaller,
  });

  await agent.processQuery("谁斩了华雄？", "sango-novel");

  assert.equal(seenTools.length, 1, "域锁定只走一轮生成");
  assert.deepEqual(seenTools[0]!, [], "快路径生成轮不携带工具定义");
  const messages = seenMessages[0]!;
  assert.equal(messages.length, 3, "消息固定三段排布");
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, SANGO_NOVEL_DOMAIN_PROMPT, "域锁定用 sango-novel 域提示");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content, "谁斩了华雄？");
  assert.equal(messages[2].role, "system");
  assert.ok(
    messages[2].content.includes("云长提刀出阵，斩华雄于帐前！"),
    "注入片段恒在消息末尾"
  );
  assert.equal(transport.callToolCalls.length, 0, "localTools 注入时不走 transport");
});

test("快路径生成轮：domain=fengyunsanguo 预调 fengyunsanguo_query + 注入 + 域提示，不携带 tools", async () => {
  const transport = new MockTransport(WHITELIST_TOOLS);
  const seenTools: MCPToolDefinition[][] = [];
  const seenMessages: any[][] = [];
  const modelCaller = async (
    messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    seenMessages.push([...messages]);
    return textResponse("元让");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
    localTools: {
      fengyunsanguo_query: async (args: Record<string, unknown>) => ({
        content: [{ type: "text", text: `1. 夏侯惇的字是什么？ → ${String(args.text)}` }],
      }),
    },
    modelCaller,
  });

  await agent.processQuery("夏侯惇的字是什么？", "fengyunsanguo");

  assert.equal(seenTools.length, 1);
  assert.deepEqual(seenTools[0]!, [], "题库快路径生成轮不携带工具定义");
  const messages = seenMessages[0]!;
  assert.equal(messages[0].content, FENGYUNSANGUO_DOMAIN_PROMPT);
  assert.ok(
    messages[2].content.includes("夏侯惇的字是什么？"),
    "题库候选注入恒在消息末尾"
  );
});

test("auto 分类轮：请求体无 tools，消息仅 [system 分类提示 + user 问题]，stage=classify", async () => {
  const transport = new MockTransport();
  const agent = new StageRecordingAgent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
  });

  await agent.processQuery("你好");

  assert.equal(agent.calls.length, 2, "auto 未命中能力域分分类 + 生成两轮");
  const classify = agent.calls[0]!;
  assert.equal(classify.stage, "classify", "分类轮日志 stage=classify");
  assert.deepEqual(classify.tools, [], "分类轮请求体无 tools");
  assert.equal(classify.messages.length, 2);
  assert.equal(classify.messages[0].content, CLASSIFY_SYSTEM_PROMPT);
  assert.equal(classify.messages[0].role, "system");
  assert.equal(classify.messages[1].role, "user");
  assert.equal(classify.messages[1].content, "你好");
  const generation = agent.calls[1]!;
  assert.equal(generation.stage, "generation", "生成轮日志 stage=generation");
  assert.deepEqual(generation.tools, [], "生成轮不携带工具定义");
});

test("auto 编号 1 → 预调 sango_novel_search + 注入 + sango-novel 域提示生成轮", async () => {
  const transport = new MockTransport(WHITELIST_TOOLS);
  let callCount = 0;
  const seenMessages: any[][] = [];
  const modelCaller = async (
    messages: any[],
    _tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    callCount += 1;
    seenMessages.push([...messages]);
    // 生成轮用不含人物名/指针的泛答，避免触发引用校验兜底轮
    return callCount === 1 ? textResponse("1") : textResponse("这是测试回复。");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    modelCaller,
  });

  await agent.processQuery("谁斩了华雄？");

  assert.equal(callCount, 2);
  assert.equal(seenMessages[0]![0].content, CLASSIFY_SYSTEM_PROMPT, "首轮为分类轮");
  const generation = seenMessages[1]!;
  assert.equal(generation[0].content, SANGO_NOVEL_DOMAIN_PROMPT, "编号 1 走 sango-novel 域提示");
  assert.ok(
    generation[2].content.includes("云长提刀出阵"),
    "编号 1 预调 sango_novel_search 后注入原文片段"
  );
});

test("auto 编号 2 → 预调 fengyunsanguo_query + 注入 + fengyunsanguo 域提示生成轮", async () => {
  const transport = new MockTransport(WHITELIST_TOOLS);
  const preCalls: string[] = [];
  let callCount = 0;
  const seenMessages: any[][] = [];
  const modelCaller = async (
    messages: any[],
    _tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    callCount += 1;
    seenMessages.push([...messages]);
    return callCount === 1 ? textResponse("2") : textResponse("元让");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
    localTools: {
      fengyunsanguo_query: async (args: Record<string, unknown>) => {
        preCalls.push(String(args.text));
        return { content: [{ type: "text", text: "1. 夏侯惇的字是什么？ → 元让" }] };
      },
    },
    modelCaller,
  });

  await agent.processQuery("夏侯惇的字是什么？");

  assert.equal(callCount, 2);
  assert.deepEqual(preCalls, ["夏侯惇的字是什么？"], "编号 2 预调 fengyunsanguo_query（text=用户问句）");
  const generation = seenMessages[1]!;
  assert.equal(generation[0].content, FENGYUNSANGUO_DOMAIN_PROMPT, "编号 2 走 fengyunsanguo 域提示");
  assert.ok(generation[2].content.includes("夏侯惇的字是什么？ → 元让"), "题库候选注入末尾");
});

test("auto 编号 99 / 非数字 / 空 → 自由对话提示，无注入、无预调、不重试", async () => {
  for (const classifyReply of ["99", "你好呀", ""]) {
    const transport = new MockTransport(WHITELIST_TOOLS);
    const seenMessages: any[][] = [];
    let callCount = 0;
    const modelCaller = async (
      messages: any[],
      _tools: MCPToolDefinition[]
    ): Promise<ModelResponse> => {
      callCount += 1;
      seenMessages.push([...messages]);
      return callCount === 1 ? textResponse(classifyReply) : textResponse("自由回答");
    };

    const agent = new Agent(transport, makeConfig(), {
      tools: WHITELIST_TOOLS,
      modelCaller,
    });

    const answer = await agent.processQuery("你好");

    assert.equal(answer, "自由回答");
    assert.equal(callCount, 2, "兜底不重试分类轮");
    const generation = seenMessages[1]!;
    assert.equal(generation[0].content, FREE_CHAT_SYSTEM_PROMPT, `回复 ${JSON.stringify(classifyReply)} 按 99 自由对话`);
    assert.equal(generation.length, 2, "99 无注入段");
    assert.equal(transport.callToolCalls.length, 0, "99 不预调任何工具");
  }
});

test("503 落点：domain=sango-novel 预调 transport 抛错 → processQuery 抛 ToolExecutionError", async () => {
  const transport = new MockTransport(WHITELIST_TOOLS);
  const cause = new Error("MCP connection closed");
  transport.callToolError = cause;

  const agent = new Agent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
    modelCaller: async () => textResponse("不应到达"),
  });

  await assert.rejects(
    agent.processQuery("谁斩了华雄？", "sango-novel"),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal((error as ToolExecutionError).toolName, "sango_novel_search");
      assert.equal((error as ToolExecutionError).cause, cause);
      return true;
    }
  );
});

test("500 落点：domain=fengyunsanguo 预调 localTools 抛错原样上抛，不包装成 ToolExecutionError", async () => {
  const transport = new MockTransport(WHITELIST_TOOLS);
  const original = new Error("question bank broken");

  const agent = new Agent(transport, makeConfig(), {
    tools: WHITELIST_TOOLS,
    localTools: {
      fengyunsanguo_query: async () => {
        throw original;
      },
    },
    modelCaller: async () => textResponse("不应到达"),
  });

  await assert.rejects(
    agent.processQuery("夏侯惇的字是什么？", "fengyunsanguo"),
    (error: unknown) => {
      assert.equal(error, original, "本地工具异常必须原样向上抛");
      assert.equal(error instanceof ToolExecutionError, false);
      return true;
    }
  );
});

test("listTools：白名单 4 个能力工具（无天气 / 无后台），description 替换为瘦身全文", async () => {
  const transport = new MockTransport([...WEATHER_TOOLS, ...WHITELIST_TOOLS]);
  const agent = new Agent(transport, makeConfig());

  const reported = await agent.listTools();
  const names = reported.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    FENGYUNSANGUO_QUERY_TOOL,
    "fengyunsanguo_quiz_command",
    "fengyunsanguo_quiz_route",
    "sango_novel_search",
  ]);
  assert.ok(!names.includes("get-forecast") && !names.includes("get-alerts"), "天气工具已下线");
  assert.match(
    reported.find((tool) => tool.name === FENGYUNSANGUO_QUERY_TOOL)!.description,
    /风云三国题库候选召回/
  );
  assert.match(
    reported.find((tool) => tool.name === "sango_novel_search")!.description,
    /检索《三国演义》原著原文/
  );
});
