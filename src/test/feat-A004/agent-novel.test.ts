import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import { loadAliasTable } from "../../citation.js";
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "../../types.js";

/** Mock Transport：只记录调用，不发真实 MCP 连接 */
class MockTransport extends MCPTransport {
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(private tools: MCPToolDefinition[] = []) {
    super("mock-server");
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.callToolCalls.push({ name, args });
    return { content: [{ type: "text", text: "transport-result" }] };
  }
}

const NOVEL_TOOL: MCPToolDefinition = {
  name: "sango_novel_search",
  description: "《三国演义》原著检索：参数 source=sanguo-yanyi、query=用户白话问句、limit 默认 5",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
    },
  },
};

const WEATHER_TOOL: MCPToolDefinition = {
  name: "get-forecast",
  description: "获取美国境内天气预报",
  inputSchema: { type: "object" },
};

function makeConfig(provider: LLMProvider = "deepseek"): LLMConfig {
  return {
    provider,
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

function toolUseResponse(
  name: string,
  input: Record<string, unknown>
): ModelResponse {
  return { content: [{ type: "tool_use", id: "call_1", name, input }] };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }] };
}

const ALIAS_TABLE = loadAliasTable("a004-not-exist"); // stub 别名表（关羽=P002）

const RECALL_TEXT =
  "第五回：云长提刀出阵，斩华雄于帐前。众皆大惊，尽皆失色。";

test("domain=sango-novel 时 system 追加三国演义域提示（软性，不拦截非原著问句）", async () => {
  let capturedSystem = "";
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    capturedSystem = system;
    return textResponse("按原文，斩华雄者系关羽。");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    modelCaller,
  });
  await agent.processQuery("谁斩了华雄？", "sango-novel");
  assert.ok(capturedSystem.includes("三国演义原著解读"), "应追加三国演义域提示");
  assert.ok(capturedSystem.includes("sango_novel_search"), "域提示应指向原著检索工具");
});

test("① 引用校验通过：答案原样返回，无额外模型调用", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
      : textResponse("按原文，斩华雄者系关羽。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    extractPersonNames: async () => ["关羽", "华雄"],
    resolveNer: async () => [],
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const answer = await agent.processQuery("谁斩了华雄？");
  assert.equal(answer, "按原文，斩华雄者系关羽。");
  assert.equal(modelCallCount, 2, "校验通过不应有额外模型调用");
});

test("② 引用校验不通过：输出兜底「原文片段 + 出处 + 结论归纳」", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
      : textResponse("曹操斩了华雄。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    extractPersonNames: async () => ["曹操"],
    resolveNer: async () => [],
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const answer = await agent.processQuery("谁斩了华雄？");
  assert.match(answer, /【原文片段】/);
  assert.match(answer, /第五回：云长提刀出阵，斩华雄于帐前。/);
  assert.match(answer, /（出处：sanguo-yanyi）/);
  assert.match(answer, /按原文，斩华雄者系关羽/);
  assert.doesNotMatch(answer, /曹操斩了华雄/);
  assert.equal(modelCallCount, 2, "注入提取/结论后不增加模型调用");
});

test("③ 检索无命中：回答「演义中未涉及」，不做归纳生成", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "诸葛亮借东风后去了哪？",
          limit: 5,
        })
      : textResponse("借东风后诸葛亮回了夏口。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: "" }],
      }),
    },
    modelCaller,
  });

  const answer = await agent.processQuery("诸葛亮借东风后去了哪？");
  assert.equal(answer, "演义中未涉及");
  assert.equal(modelCallCount, 2, "无命中不应触发提取/NER/结论模型调用");
});

test("④ 未调原著工具的其他域：不触发引用校验，无额外模型调用", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? toolUseResponse("get-forecast", { latitude: 40.7, longitude: -74 })
      : textResponse("纽约今日适合出行。");
  };

  const agent = new Agent(new MockTransport([WEATHER_TOOL]), makeConfig(), {
    tools: [WEATHER_TOOL],
    modelCaller,
  });

  const answer = await agent.processQuery("纽约天气怎么样？");
  assert.equal(answer, "纽约今日适合出行。");
  assert.equal(modelCallCount, 2, "天气域不应触发引用校验的额外模型调用");
});

test("⑤ 默认链路（LLM 提取 / NER / 结论归纳）：校验不过走兜底", async () => {
  const responses = [
    toolUseResponse("sango_novel_search", {
      source: "sanguo-yanyi",
      query: "谁斩了华雄？",
      limit: 5,
    }),
    textResponse("许褚斩华雄。"),
    textResponse('["许褚"]'), // 提取断言人名
    textResponse("[]"), // 许褚 NER 无 ID
    textResponse("按原文，斩华雄者系关羽"), // 兜底结论
  ];
  let callIndex = 0;
  const modelCaller = async (
    _messages: any[],
    _tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    const next = responses[callIndex];
    callIndex += 1;
    if (!next) {
      throw new Error(`模型脚本已耗尽：${callIndex}`);
    }
    return next;
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    modelCaller,
  });

  const answer = await agent.processQuery("谁斩了华雄？");
  assert.match(answer, /【原文片段】/);
  assert.match(answer, /第五回：云长提刀出阵，斩华雄于帐前。/);
  assert.match(answer, /按原文，斩华雄者系关羽/);
  assert.equal(callIndex, 5, "主问答 + 提取 + NER + 结论共 5 次模型调用");
});
