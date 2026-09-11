import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { LLMConfig, MCPToolDefinition, ModelResponse } from "./types.js";
import type { MCPTransport } from "./transport.js";

// 输出格式约束：所有回答必须简洁、结论优先
const DEFAULT_SYSTEM_PROMPT = [
  "你是地铁通勤天气助手，回答美国城市（如纽约）的地铁出行天气问题。",
  "每次回答必须严格遵守：",
  "1. 只输出一句话纯文本，总字数不超过 50 字（含标点）；不要换行、不要 Markdown 标题、表格、分点列表或多段建议。",
  "2. 结论优先：适合 / 基本适合但需准备 / 建议调整时间 / 不建议出行，紧跟日期和地点。",
  "3. 只写影响结论的天气依据：温度用摄氏度（℃），换算后四舍五入取整即可；再写降水或预警，不罗列风力等次要数据。",
  "4. 以“出门必备：”结尾，列出手机、乘车码或交通卡、证件、钥匙；天气确实需要时再追加雨伞、薄外套等。",
  "5. 不输出未来几天预报、预警区域细节或用户没问的建议。",
].join("\n");

export class Agent {
  private transport: MCPTransport;
  private config: LLMConfig;
  private systemPrompt: string;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(transport: MCPTransport, config: LLMConfig, systemPrompt?: string) {
    this.transport = transport;
    this.config = config;
    this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

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

      const systemMessage = messages.find(
        (message: any) => message?.role === "system"
      );
      const apiMessages = messages.filter(
        (message: any) => message?.role !== "system"
      );

      const response = await this.anthropic.messages.create({
        model: this.config.model,
        max_tokens: 1000,
        system: systemMessage?.content,
        messages: apiMessages,
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
        role: "system",
        content: this.systemPrompt,
      },
      {
        role: "user",
        content: query,
      },
    ];

    const availableTools = await this.transport.listTools();

    let currentResponse = await this.callModel(messages, availableTools);

    while (true) {
      let hasToolUse = false;

      for (const item of currentResponse.content) {
        if (item.type !== "tool_use") {
          continue;
        }

        hasToolUse = true;
        const toolName = item.name!;
        const toolArgs = item.input!;

        const result = await this.transport.callTool(toolName, toolArgs);

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

      if (!hasToolUse) {
        break;
      }

      currentResponse = await this.callModel(messages, availableTools);
    }

    return currentResponse.content
      .filter((item) => item.type === "text")
      .map((item) => item.text!)
      .join("\n")
      .trim();
  }
}

