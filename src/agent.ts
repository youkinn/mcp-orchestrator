import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LLMConfig, MCPToolDefinition, ModelResponse } from "./types.js";
import type { MCPTransport } from "./transport.js";

export class Agent {
  private transport: MCPTransport;
  private config: LLMConfig;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(transport: MCPTransport, config: LLMConfig) {
    this.transport = transport;
    this.config = config;

    if (config.provider === "anthropic") {
      this.anthropic = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.apiBaseUrl,
      });
    } else {
      this.openai = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.apiBaseUrl,
      });
    }
  }

  private getAnthropicTools(tools: MCPToolDefinition[]) {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as any,
    }));
  }

  private getOpenAITools(tools: MCPToolDefinition[]) {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
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

  private async callModel(
    messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> {
    if (this.config.provider === "anthropic") {
      if (!this.anthropic) {
        throw new Error("Anthropic client not initialized");
      }

      const response = await this.anthropic.messages.create({
        model: this.config.model,
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
      throw new Error("OpenAI-compatible client not initialized");
    }

    const response = await this.openai.chat.completions.create({
      model: this.config.model,
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

  async listTools() {
    return this.transport.listTools();
  }

  async processQuery(query: string): Promise<string> {
    let messages: any[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const availableTools = await this.transport.listTools();

    const finalText: string[] = [];
    let currentResponse = await this.callModel(messages, availableTools);

    while (true) {
      let hasToolUse = false;

      for (const item of currentResponse.content) {
        if (item.type === "text") {
          finalText.push(item.text!);
          continue;
        }

        if (item.type === "tool_use") {
          hasToolUse = true;
          const toolName = item.name!;
          const toolArgs = item.input!;

          const result = await this.transport.callTool(toolName, toolArgs);

          finalText.push(
            `[调用工具 ${toolName}，参数：${JSON.stringify(toolArgs)}]`
          );

          if (this.config.provider === "anthropic") {
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
              assistantMessage.reasoning_content =
                currentResponse.reasoningContent;
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
}

