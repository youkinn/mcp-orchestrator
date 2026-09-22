import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  CLASSIFY_SYSTEM_PROMPT,
  FREE_CHAT_SYSTEM_PROMPT,
} from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "../../types.js";

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

/** 子类覆写 callModel：记录每轮 system 提示词与是否携带 tools，不发网络请求 */
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

test("general 模式：options.tools=[] 时不执行任何工具，也不查 transport.listTools", async () => {
  const transport = new MockTransport();
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
  assert.equal(seenTools.length, 2, "auto 应分分类轮 + 生成轮两次调用");
  for (const tools of seenTools) {
    assert.equal(tools.length, 0, "分类轮与生成轮都不应携带工具定义");
  }
  assert.equal(transport.listToolsCount, 0, "不应走 transport.listTools()");
  assert.equal(transport.callToolCalls.length, 0, "不应执行任何工具");
});

test("向后兼容：第 3 参字符串仍作为 systemPrompt（99 自由对话轮生效）；不传时默认 FREE_CHAT_SYSTEM_PROMPT", async () => {
  const transport = new MockTransport();

  const legacy = new RecordingAgent(transport, makeConfig(), "你是自定义助手");
  await legacy.processQuery("你好");
  assert.equal(legacy.prompts[0], CLASSIFY_SYSTEM_PROMPT, "分类轮固定使用分类提示，不替换自定义提示词");
  assert.equal(legacy.prompts[1], "你是自定义助手", "第 3 参字符串作为 99 自由对话轮 systemPrompt");

  const defaultAgent = new RecordingAgent(transport, makeConfig());
  await defaultAgent.processQuery("你好");
  assert.equal(defaultAgent.prompts[0], CLASSIFY_SYSTEM_PROMPT, "分类轮固定使用分类提示");
  assert.equal(defaultAgent.prompts[1], FREE_CHAT_SYSTEM_PROMPT, "未传时 99 自由对话轮默认自由对话提示");
});
