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
  let callCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    callCount += 1;
    if (callCount === 1) {
      capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
    }
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
      : textResponse("斩华雄者系关羽。「云长提刀出阵，斩华雄于帐前。」（出处：第5回 破关兵三英战吕布）");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const answer = await agent.processQuery("谁斩了华雄？");
  assert.equal(
    answer,
    "斩华雄者系关羽。「云长提刀出阵，斩华雄于帐前。」（出处：第5回 破关兵三英战吕布）"
  );
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

test("⑤ 默认链路（本地别名表扫描 + 兜底结论）：校验不过走兜底", async () => {
  const responses = [
    toolUseResponse("sango_novel_search", {
      source: "sanguo-yanyi",
      query: "谁斩了华雄？",
      limit: 5,
    }),
    textResponse("许褚斩华雄。"), // 主问答答案（格式不符 + 许褚不在召回 → 触发兜底）
    textResponse("按原文，斩华雄者系关羽"), // 兜底结论（本地扫描，无提取/NER 模型调用）
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
  assert.equal(callIndex, 3, "主问答 + 兜底结论共 3 次模型调用（无提取/NER）");
});
test("⑥ 快路径注入收窄：只取最符合前 3 段且每段窗口截断（不整段刷屏）", async () => {
  let capturedUser = "";
  const filler = "先叙无关内容。".repeat(40);
  const key = "孙权遣人向关羽求亲，关羽怒曰“吾虎女安肯嫁犬子乎！”";
  const tailText = "后叙无关内容。".repeat(40);
  // 4 段召回（按相关度降序）：第一段命中关键词、其余为无关长段
  const multiText = [
    "【出处】第73回 玄德进位汉中王 云长攻拔襄阳郡 · 段5（叙述）\n" + filler + key + tailText,
    "【出处】第1回 宴桃园豪杰三结义 斩黄巾英雄首立功 · 段1（叙述）\n" + "桃园结义无关内容。".repeat(40),
    "【出处】第5回 发矫诏诸镇应曹公 破关兵三英战吕布 · 段4（叙述）\n" + "三英战吕布无关内容。".repeat(40),
    "【出处】第82回 孙权降魏受九锡 先主征吴赏六军 · 段1（叙述）\n" + "章武元年无关内容。".repeat(40),
  ].join("\n\n");
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    capturedUser = messages.find((m) => m.role === "user")?.content ?? "";
    return textResponse("斩华雄者系关羽。");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: multiText }],
      }),
    },
    modelCaller,
  });
  await agent.processQuery("孙权遣人向关羽求亲，关羽是怎么回复使者的", "sango-novel");
  assert.ok(capturedUser.includes("求亲"), "注入应含最符合段的关键句");
  assert.ok(!capturedUser.includes("章武元年"), "注入只取前 3 段，不应含第 4 段");
  assert.ok(!capturedUser.includes("桃园结义无关内容。".repeat(40)), "每段应被窗口截断，不整段注入");
});
