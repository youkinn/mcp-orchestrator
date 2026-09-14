import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, GENERAL_SYSTEM_PROMPT } from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import type {
  LLMConfig,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "../../types.js";

/** Mock Transport：只记录调用，不发真实 MCP 连接（feat-A002） */
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

/** 子类覆写 callModel：记录 system 提示词与工具列表，不发网络请求 */
class RecordingAgent extends Agent {
  prompts: string[] = [];
  toolLists: MCPToolDefinition[][] = [];

  protected override async callModel(
    messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> {
    this.prompts.push(messages[0].content);
    this.toolLists.push(tools);
    return { content: [{ type: "text", text: "通用回答" }] };
  }
}

const WEATHER_TOOL: MCPToolDefinition = {
  name: "get_weather",
  description: "查询美国城市天气",
  inputSchema: { type: "object" },
};

function makeConfig(): LLMConfig {
  return {
    provider: "deepseek",
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

test("general 提示词：通用对话，不含天气播报格式约束与题库指令", () => {
  assert.match(GENERAL_SYSTEM_PROMPT, /通用对话助手/);
  assert.doesNotMatch(
    GENERAL_SYSTEM_PROMPT,
    /地铁|天气助手|出门必备|不超过 50 字|风云三国|sango/i
  );
});

test("general 场景：system 消息为通用提示词而非天气默认提示词，且不传工具", async () => {
  const transport = new MockTransport([WEATHER_TOOL]);
  const agent = new RecordingAgent(transport, makeConfig(), {
    systemPrompt: GENERAL_SYSTEM_PROMPT,
    tools: [],
  });

  const answer = await agent.processQuery("1+1等于几");

  assert.equal(answer, "通用回答");
  assert.equal(agent.prompts[0], GENERAL_SYSTEM_PROMPT);
  assert.doesNotMatch(
    agent.prompts[0]!,
    /地铁通勤天气助手/,
    "general 不应复用天气默认提示词"
  );
  assert.equal(agent.toolLists[0]!.length, 0, "general 不应给模型任何工具");
  assert.equal(transport.listToolsCount, 0, "不应走 transport.listTools()");
  assert.equal(transport.callToolCalls.length, 0, "不应执行任何 MCP 工具");
});

test("装配回归：index.ts 的 generalAgent 注入 GENERAL_SYSTEM_PROMPT", () => {
  const source = readFileSync(
    join(__dirname, "../../../src/index.ts"),
    "utf8"
  );

  assert.match(
    source,
    /generalAgent\s*=\s*new Agent\(transport, llmConfig, \{[\s\S]*?systemPrompt:\s*GENERAL_SYSTEM_PROMPT/
  );
  assert.doesNotMatch(
    source,
    /generalAgent\s*=\s*new Agent\(transport, llmConfig, \{\s*tools:\s*\[\]\s*\}\)/
  );
});

test("weather 场景回归：不传 systemPrompt 时仍用地铁天气默认提示词", async () => {
  const transport = new MockTransport([WEATHER_TOOL]);
  const agent = new RecordingAgent(transport, makeConfig());

  await agent.processQuery("纽约今天适合坐地铁出门吗？");

  assert.match(agent.prompts[0]!, /地铁通勤天气助手/);
  assert.notEqual(agent.prompts[0], GENERAL_SYSTEM_PROMPT);
});
