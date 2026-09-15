import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  ToolExecutionError,
  type LLMConfig,
  type MCPToolDefinition,
  type ModelResponse,
  type ToolCallResult,
} from "./types.js";
import type { MCPTransport } from "./transport.js";

// 统一路由提示词（feat-A003）：单 Agent 自主决定调不调工具、调哪个；
// 分域兜底规则只写在这里，HTTP 层不再有 scenario / service 等路由概念。
export const UNIFIED_SYSTEM_PROMPT = [
  // 身份与总原则
  "你是统一对话助手，用简体中文回答用户问题。",
  "你有两项专用能力：美国天气播报（get-forecast / get-alerts）、风云三国题库问答（sango_query）。",
  "总原则：先判断用户意图是否命中某项专用能力 → 命中则调用对应工具、并严格按该能力的格式作答 → 未命中则按「分域兜底」处理。一次回答只属于一个域，不混用两个域的格式与话术。",
  "",
  // 能力清单
  "【能力一 · 美国天气播报（地铁通勤）】",
  "什么时候调：用户问美国城市（如纽约）的天气，或据此判断地铁 / 通勤出行是否合适时，调用 get-forecast 取预报，涉及预警时再调用 get-alerts。该能力仅适用于美国境内；非美国地区（如北京、上海）不调用天气工具。",
  "调了之后怎么答（以下 5 条必须严格遵守）：",
  "1. 只输出一句话纯文本，总字数不超过 50 字（含标点）；不要换行、不要 Markdown 标题、表格、分点列表或多段建议。",
  "2. 结论优先：适合 / 基本适合但需准备 / 建议调整时间 / 不建议出行，紧跟日期和地点。",
  "3. 只写影响结论的天气依据：温度用摄氏度（℃），换算后四舍五入取整即可；再写降水或预警，不罗列风力等次要数据。",
  "4. 以“出门必备：”结尾，列出手机、乘车码或交通卡、证件、钥匙；天气确实需要时再追加雨伞、薄外套等。",
  "5. 不输出未来几天预报、预警区域细节或用户没问的建议。",
  "",
  "【能力二 · 风云三国题库问答】",
  "适用域：仅限风云三国游戏内的招募武将问答题；其他三国历史或常识问答不属于本能力，不要调用 sango_query。",
  "什么时候调：用户的问题指向上述题库题目时（含与题干问法不同、含义相同的问法）。",
  "调了之后怎么答（以下 5 条必须严格遵守）：",
  "1. 收到用户提问后必须先调用 sango_query 工具（参数 text 传用户原始问题），取回候选题目。",
  "2. 先理解用户问题的含义，再判断候选中哪条含义相同；问法不同但含义相同即算对应。",
  "3. 判定出对应的题目后，只输出该题答案原文，不要输出题干、选项字母、解释或任何多余文字。",
  "4. 候选中没有含义对应的题目时（包括只是字面相似、含义不同的），只回复「题库未收录该题，请换个问法」。",
  "5. 禁止使用题库之外的知识作答、补充或改写答案。",
  "",
  // 优先级判断次序
  "【判断次序（自上而下，命中即停）】",
  "1. 意图是否命中风云三国游戏内招募武将问答题 → 命中：调 sango_query，按能力二的 5 条作答。",
  "2. 意图是否命中美国境内城市的天气 / 地铁通勤出行 → 命中：调 get-forecast（必要时 get-alerts），按能力一的 5 条作答。",
  "3. 以上都未命中 → 不调用任何工具，转入分域兜底。",
  "",
  // 分域兜底
  "【分域兜底（未命中专用能力时按所属域处理，不存在笼统的自由回答）】",
  "- 三国题库域：调过 sango_query 但候选中没有含义对应的题 → 只回复「题库未收录该题，请换个问法」，不用题库之外的知识补答。",
  "- 非美国天气域：用户问的是美国以外地区（如北京）的天气 → 不调用天气工具，明确告知仅支持美国境内天气查询、无法提供该地区数据；严禁编造温度、降水或预警数值。",
  "- 其余域：包括问候（如「你好」）、闲聊以及与天气、题库无关的通用问题 → 不调用任何工具，凭自身知识自由作答，简洁清楚；不套用天气播报格式，不套用题库话术，不确定时直接说明。",
  "",
  // 输出格式约束
  "【输出格式约束】",
  "一律输出简体中文纯文本；只有天气域与题库域有强制格式（见上），其余域按普通对话作答，不加无关模板、不解释自己的判断过程、不提及工具名。",
].join("\n");

export type LocalToolHandler = (
  args: Record<string, unknown>
) => ToolCallResult | Promise<ToolCallResult>;

export type ModelCaller = (
  messages: any[],
  tools: MCPToolDefinition[]
) => Promise<ModelResponse>;

// Agent 第 3 参 options：不传时保持 A001 行为；systemPrompt 传字符串兼容旧调用
export interface AgentOptions {
  systemPrompt?: string;
  tools?: MCPToolDefinition[];
  localTools?: Record<string, LocalToolHandler>;
  /** 测试注入点：注入后 processQuery 直接调用，不注入走 callModel 现实现 */
  modelCaller?: ModelCaller;
}

export class Agent {
  private transport: MCPTransport;
  private config: LLMConfig;
  private options: AgentOptions;
  private systemPrompt: string;
  private anthropic: Anthropic | null = null;
  private openai: OpenAI | null = null;

  constructor(
    transport: MCPTransport,
    config: LLMConfig,
    options?: AgentOptions | string
  ) {
    this.transport = transport;
    this.config = config;
    this.options =
      typeof options === "string" || options === undefined ? {} : options;
    this.systemPrompt =
      (typeof options === "string" ? options : options?.systemPrompt) ||
      UNIFIED_SYSTEM_PROMPT;

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

  protected async callModel(
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

  /** 上报的能力 = 模型实际可见的能力：与 processQuery 的 availableTools 同源 */
  async listTools(): Promise<MCPToolDefinition[]> {
    return this.options.tools ?? (await this.transport.listTools());
  }

  /** MCP 工具失败包装为 ToolExecutionError（server.ts 据此判 503）；本地工具失败原样上抛 */
  private async callTransportTool(
    toolName: string,
    toolArgs: Record<string, unknown>
  ): Promise<ToolCallResult> {
    try {
      return await this.transport.callTool(toolName, toolArgs);
    } catch (error) {
      throw new ToolExecutionError(toolName, { cause: error });
    }
  }

  private invokeModel(
    messages: any[],
    tools: MCPToolDefinition[]
  ): Promise<ModelResponse> {
    if (this.options.modelCaller) {
      return this.options.modelCaller(messages, tools);
    }
    return this.callModel(messages, tools);
  }

  async processQuery(query: string, domain?: string): Promise<string> {
    const domainHint = "\n当前用户已明确选择了“风云三国题库”场景。用户接下来的提问应一律视为风云三国游戏内的招募武将问答题，必须先调用 sango_query 工具查询题库。";
    const systemContent = domain === "sango"
      ? this.systemPrompt + domainHint
      : this.systemPrompt;

    let messages: any[] = [
      {
        role: "system",
        content: systemContent,
      },
      {
        role: "user",
        content: query,
      },
    ];

    const availableTools =
      this.options.tools ?? (await this.transport.listTools());

    let currentResponse = await this.invokeModel(messages, availableTools);

    while (true) {
      let hasToolUse = false;

      for (const item of currentResponse.content) {
        if (item.type !== "tool_use") {
          continue;
        }

        hasToolUse = true;
        const toolName = item.name!;
        const toolArgs = item.input!;

        const localTool = this.options.localTools?.[toolName];
        const result = localTool
          ? await localTool(toolArgs)
          : await this.callTransportTool(toolName, toolArgs);

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

      currentResponse = await this.invokeModel(messages, availableTools);
    }

    return currentResponse.content
      .filter((item) => item.type === "text")
      .map((item) => item.text!)
      .join("\n")
      .trim();
  }
}
