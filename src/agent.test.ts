import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, SANGO_KNOWLEDGE_SYSTEM_PROMPT } from "./agent.js";
import { MCPTransport } from "./transport.js";
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "./types.js";

/** Mock Transport：只记录调用，不发起真实 MCP 连接（feat-A002） */
class MockTransport extends MCPTransport {
  listToolsCount = 0;
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

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
    return { content: [{ type: "text", text: `transport-result:${name}` }] };
  }
}

/** 子类覆写 callModel：验证 legacy 字符串 form systemPrompt，不发网络请求 */
class RecordingAgent extends Agent {
  prompts: string[] = [];

  protected override async callModel(
    messages: any[],
    _tools: MCPToolDefinition[]
  ): Promise<ModelResponse> {
    this.prompts.push(messages[0].content);
    return textResponse("agent 回复");
  }
}

const SANG_QUIZ_TOOL: MCPToolDefinition = {
  name: "sango_query",
  description: "风云三国知识问答：查题库",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
};

const WEATHER_TOOL: MCPToolDefinition = {
  name: "get_weather",
  description: "查询美国城市天气",
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
  return {
    content: [{ type: "tool_use", id: "call_1", name, input }],
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }] };
}

test("general 模式：options.tools=[] 时不执行任何工具，也不查 transport.listTools", async () => {
  const transport = new MockTransport([SANG_QUIZ_TOOL]);
  const seenTools: MCPToolDefinition[][] = [];

  const modelCaller = async (
    _messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    seenTools.push(tools);
    return textResponse("直接回答");
  };

  const agent = new Agent(transport, makeConfig(), {
    tools: [],
    modelCaller,
  });

  const answer = await agent.processQuery("三国是什么？");

  assert.equal(answer, "直接回答");
  assert.equal(seenTools.length, 1);
  assert.equal(seenTools[0]!.length, 0, "传给 LLM 的工具列表应为空");
  assert.equal(transport.listToolsCount, 0, "不应走 transport.listTools()");
  assert.equal(transport.callToolCalls.length, 0, "不应执行任何工具");
});

for (const provider of ["deepseek", "anthropic"] as const) {
  test(`本地工具命中（${provider}）：走 localTools 而非 transport.callTool，回填符合 ${provider} 消息格式`, async () => {
    const transport = new MockTransport([SANG_QUIZ_TOOL]);
    let localCalls = 0;
    const localTools = {
      sango_query: async (args: Record<string, unknown>) => {
        localCalls += 1;
        return {
          content: [{ type: "text", text: `题干：${String(args.text)}` }],
        };
      },
    };

    let modelCallCount = 0;
    const modelCaller = async (
      messages: any[],
      _tools: MCPToolDefinition[]
    ): Promise<ModelResponse> => {
      modelCallCount += 1;
      if (modelCallCount === 1) {
        return toolUseResponse("sango_query", {
          text: "赤壁之战发生在哪一年？",
        });
      }

      const last = messages[messages.length - 1];
      if (provider === "anthropic") {
        assert.equal(last.role, "user");
        assert.equal(last.content[0].type, "tool_result");
        assert.equal(last.content[0].tool_use_id, "call_1");
        assert.match(JSON.stringify(last.content[0].content), /题干/);
      } else {
        assert.equal(last.role, "tool");
        assert.equal(last.tool_call_id, "call_1");
        assert.match(last.content, /题干/);
      }

      return textResponse("赤壁之战发生在公元208年");
    };

    const agent = new Agent(transport, makeConfig(provider), {
      localTools,
      modelCaller,
    });

    const answer = await agent.processQuery("赤壁之战发生在哪一年？");

    assert.equal(answer, "赤壁之战发生在公元208年");
    assert.equal(localCalls, 1, "本地工具应被调用一次");
    assert.equal(transport.callToolCalls.length, 0, "不应走 transport.callTool");
    assert.equal(transport.listToolsCount, 1, "未显式传 tools 时应走 listTools");
  });
}

test("未命中本地工具时回退 transport.callTool（天气链路回归）", async () => {
  const transport = new MockTransport([WEATHER_TOOL]);

  const localTools = {
    sango_query: async () => ({
      content: [{ type: "text", text: "不应被调用" }],
    }),
  };

  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (modelCallCount === 1) {
      return toolUseResponse("get_weather", { city: "New York" });
    }
    return textResponse("纽约今日适合出行");
  };

  const agent = new Agent(transport, makeConfig(), {
    localTools,
    modelCaller,
  });

  const answer = await agent.processQuery("纽约天气怎么样？");

  assert.equal(answer, "纽约今日适合出行");
  assert.equal(transport.callToolCalls.length, 1);
  assert.equal(transport.callToolCalls[0]!.name, "get_weather");
  assert.deepEqual(transport.callToolCalls[0]!.args, { city: "New York" });
});

test("SANGO_KNOWLEDGE_SYSTEM_PROMPT 已导出，含未收录提示与 sango_query 调用要求", () => {
  assert.equal(typeof SANGO_KNOWLEDGE_SYSTEM_PROMPT, "string");
  assert.ok(SANGO_KNOWLEDGE_SYSTEM_PROMPT.length > 0);
  assert.match(SANGO_KNOWLEDGE_SYSTEM_PROMPT, /未收录/);
  assert.match(SANGO_KNOWLEDGE_SYSTEM_PROMPT, /hit=false/);
  assert.match(SANGO_KNOWLEDGE_SYSTEM_PROMPT, /sango_query/);
});

test("向后兼容：第 3 参字符串仍作为 systemPrompt；不传时保持默认提示", async () => {
  const transport = new MockTransport();

  const legacy = new RecordingAgent(transport, makeConfig(), "你是自定义助手");
  await legacy.processQuery("你好");
  assert.equal(legacy.prompts[0], "你是自定义助手");

  const defaultAgent = new RecordingAgent(transport, makeConfig());
  await defaultAgent.processQuery("纽约天气？");
  assert.match(defaultAgent.prompts[0], /地铁通勤天气助手/);
});
