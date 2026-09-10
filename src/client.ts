import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import OpenAI from "openai";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as readline from "node:readline";

dotenv.config();

interface MCPClientConfig {
  name?: string;
  version?: string;
}

type LLMProvider = "anthropic" | "deepseek" | "openai";

// 统一模型提供方入口：
// - anthropic: Claude
// - deepseek: DeepSeek
// - openai: OpenAI 兼容模型
class MCPClient {
  private client: Client | null = null;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;
  private transport: StdioClientTransport | null = null;
  private provider: LLMProvider;
  private model: string;

  constructor(config: MCPClientConfig = {}) {
    const provider = (process.env.LLM_PROVIDER || "deepseek").toLowerCase() as LLMProvider;
    if (!['anthropic', 'deepseek', 'openai'].includes(provider)) {
      throw new Error("LLM_PROVIDER 必须是 anthropic / deepseek / openai");
    }

    this.provider = provider;
    this.model = process.env.LLM_MODEL || (
      provider === "anthropic"
        ? "claude-3-5-sonnet-20241022"
        : provider === "openai"
          ? "gpt-4o-mini"
          : "deepseek-v4-flash"
    );

    const apiKey = process.env.API_KEY;
    const apiBaseUrl = process.env.API_BASE_URL || (
      provider === "anthropic"
        ? "https://api.anthropic.com"
        : provider === "openai"
          ? "https://api.openai.com/v1"
          : "https://api.deepseek.com"
    );

    if (!apiKey) {
      throw new Error("缺少 API_KEY，请在 .env 中配置统一的模型 key");
    }

    if (provider === "anthropic") {
      this.anthropic = new Anthropic({ apiKey, baseURL: apiBaseUrl });
    } else {
      this.openai = new OpenAI({
        apiKey,
        baseURL: apiBaseUrl,
      });
    }
  }

  private getAnthropicTools(tools: any[]) {
    return tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema ?? tool.parameters ?? {},
    }));
  }

  private getOpenAITools(tools: any[]) {
    return tools.map((tool: any) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? tool.parameters ?? {},
      },
    }));
  }

  private normalizeOpenAIMessage(message: any) {
    const content = message?.content;
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    if (Array.isArray(content)) {
      return content
        .filter((item: any) => item?.type === "text")
        .map((item: any) => ({ type: "text", text: item.text }));
    }
    return [];
  }

  // 统一的模型调用入口：
  // 根据 LLM_PROVIDER 选择不同 SDK，并将 MCP 工具按目标模型格式进行适配。
  private async callModel(messages: any[], tools: any[]) {
    if (this.provider === "anthropic") {
      if (!this.anthropic) {
        throw new Error("Anthropic client 未初始化");
      }

      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages,
        tools: this.getAnthropicTools(tools),
      });

      return {
        content: response.content.map((item: any) => {
          if (item.type === "text") {
            return { type: "text", text: item.text };
          }
          if (item.type === "tool_use") {
            return {
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: item.input,
            };
          }
          return { type: "text", text: JSON.stringify(item) };
        }),
      };
    }

    if (!this.openai) {
      throw new Error("OpenAI 兼容客户端未初始化");
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages,
      tools: this.getOpenAITools(tools),
      max_tokens: 1000,
      temperature: 0.7,
    });

    const message = response.choices[0]?.message;
    const normalizedContent: any[] = [];
    const reasoningContent =
      typeof (message as any)?.reasoning_content === "string"
        ? (message as any).reasoning_content
        : null;

    if (message?.content) {
      normalizedContent.push(...this.normalizeOpenAIMessage(message));
    }

    if (message?.tool_calls?.length) {
      for (const toolCall of message.tool_calls as any[]) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || "{}");
        normalizedContent.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolName,
          input: toolArgs,
        });
      }
    }

    return { content: normalizedContent, reasoningContent };
  }

  // 连接到 MCP 服务器，并列出可用工具。
  async connectToServer(serverScriptPath: string): Promise<void> {
    const isPython = serverScriptPath.endsWith(".py");
    const isJs = serverScriptPath.endsWith(".js");

    if (!isPython && !isJs) {
      throw new Error("服务器脚本必须是 .py 或 .js 文件");
    }

    const command = isPython ? "python" : "node";

    this.transport = new StdioClientTransport({
      command,
      args: [serverScriptPath],
    });

    this.client = new Client(
      {
        name: "mcp-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await this.client.connect(this.transport);

    const response = await this.client.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );

    console.log(
      "\n已连接到服务器，可用工具：",
      response.tools.map((tool: any) => tool.name)
    );
  }

  // 处理用户查询：
  // 1. 让模型决定是否需要调工具
  // 2. 执行 MCP 工具调用
  // 3. 把工具结果再发回模型并拿到最终回答
  async processQuery(query: string): Promise<string> {
    if (!this.client) {
      throw new Error("客户端未连接");
    }

    let messages: any[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const toolsResponse = await this.client.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );

    const availableTools = toolsResponse.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? {},
    }));

    const finalText: string[] = [];
    let currentResponse = await this.callModel(messages, availableTools);

    while (true) {
      let hasToolUse = false;

      for (const item of currentResponse.content) {
        if (item.type === "text") {
          finalText.push(item.text);
          continue;
        }

        if (item.type === "tool_use") {
          hasToolUse = true;
          const toolName = item.name;
          const toolArgs = item.input;

          const result = await this.client.request(
            {
              method: "tools/call",
              params: {
                name: toolName,
                arguments: toolArgs,
              },
            },
            CallToolResultSchema
          );

          finalText.push(
            `[调用工具 ${toolName}，参数：${JSON.stringify(toolArgs)}]`
          );

          if (this.provider === "anthropic") {
            messages.push({
              role: "assistant",
              content: currentResponse.content,
            });

            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.id,
                  content: [
                    { type: "text", text: JSON.stringify(result.content) },
                  ],
                },
              ],
            });
          } else {
            const assistantMessage: any = {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: item.id,
                  type: "function",
                  function: {
                    name: toolName,
                    arguments: JSON.stringify(toolArgs),
                  },
                },
              ],
            };

            if (currentResponse.reasoningContent) {
              assistantMessage.reasoning_content = currentResponse.reasoningContent;
            }

            messages.push(assistantMessage);

            messages.push({
              role: "tool",
              tool_call_id: item.id,
              content: JSON.stringify(result.content),
            });
          }
        }
      }

      if (!hasToolUse) {
        break;
      }

      currentResponse = await this.callModel(messages, availableTools);
    }

    return finalText.join("\n");
  }

  // 交互式聊天循环，负责读取用户输入并持续调用 processQuery。
  async chatLoop(): Promise<void> {
    console.log("\nMCP 客户端已启动！");
    console.log("输入你的查询或输入 'quit' 退出。");

    // 使用 Node 的 readline 进行控制台输入
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const askQuestion = () => {
      rl.question("\n查询：", async (query: string) => {
        try {
          if (query.toLowerCase() === "quit") {
            await this.cleanup();
            rl.close();
            return;
          }

          const response = await this.processQuery(query);
          console.log("\n" + response);
          askQuestion();
        } catch (error) {
          console.error("\n错误：", error);
          askQuestion();
        }
      });
    };

    askQuestion();
  }

  async cleanup(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
    }
  }
}


// 主执行
async function main() {
  if (process.argv.length < 3) {
    console.log("用法：ts-node client.ts <服务器脚本路径>");
    process.exit(1);
  }

  const client = new MCPClient();
  try {
    await client.connectToServer(process.argv[2]);
    await client.chatLoop();
  } catch (error) {
    console.error("错误：", error);
    await client.cleanup();
    process.exit(1);
  }
}

// 如果这是主模块则运行 main
if (require.main === module) {
  main();
}

export default MCPClient;
