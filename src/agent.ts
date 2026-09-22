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
import { getTraceId } from "./trace.js";
import { appendLlmCall, truncate } from "./storage/logs.js";
import {
  NOVEL_NO_HIT_ANSWER,
  SANGO_NOVEL_SEARCH_TOOL,
  buildFallback,
  buildInjectionView,
  extractCitePointers,
  loadAliasTable,
  pickBestFallbackFragment,
  renderAnswerWithCitations,
  scanRecallPersonIds,
  stripOverlongModelQuotes,
  toRecallFragments,
  validateQuotePointers,
  verifyCitation,
  type ChatData,
  type InjectionView,
  type RecallFragment,
} from "./citation.js";
import {
  computePickedIndices,
  extractEntryChunkIds,
  extractRetrievalMeta,
  fillDiagnostics,
  persistRetrievalDiagnostics,
  type RetrievalPersister,
} from "./recallDiagnostics.js";

export type { ChatData } from "./citation.js";

// feat-A007 埋点辅助（旁路静默）：序列化失败兜底 String，统一 8000 截断
type LlmStage = "routing" | "generation";

function summarizeJson(value: unknown, max = 8000): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return (truncate(text ?? "", max) ?? "").trim();
}

/** LLM 声明要调的工具（name + arguments，JSON 序列化）；无则为空串 '' */
function summarizeToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return "";
  }
  const normalized = toolCalls.map((item: any) => {
    const rawArgs = item?.function?.arguments;
    let parsed: unknown = rawArgs;
    if (typeof rawArgs === "string") {
      try {
        parsed = JSON.parse(rawArgs);
      } catch {
        parsed = rawArgs;
      }
    }
    return { name: item?.function?.name ?? null, arguments: parsed ?? null };
  });
  return summarizeJson(normalized);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 统一路由提示词（feat-A003）：单 Agent 自主决定调不调工具、调哪个
export const UNIFIED_SYSTEM_PROMPT = [
  // 身份与总原则
  "你是统一对话助手，用简体中文回答用户问题。",
  "你有三项专用能力：美国天气播报（get-forecast / get-alerts）、风云三国题库问答（fengyunsanguo_query）、《三国演义》原著检索（sango_novel_search）。",
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
  "适用域：仅限风云三国游戏内的招募武将问答题；其他三国历史或常识问答不属于本能力，不要调用 fengyunsanguo_query。",
  "什么时候调：用户的问题指向上述题库题目时（含与题干问法不同、含义相同的问法）。",
  "调了之后怎么答（以下 5 条必须严格遵守）：",
  "1. 收到用户提问后必须先调用 fengyunsanguo_query 工具（参数 text 传用户原始问题），取回候选题目。",
  "2. 先理解用户问题的含义，再判断候选中哪条含义相同；问法不同但含义相同即算对应。",
  "3. 判定出对应的题目后，只输出该题答案原文，不要输出题干、选项字母、解释或任何多余文字。",
  "4. 候选中没有含义对应的题目时（包括只是字面相似、含义不同的），只回复「题库未收录该题，请换个问法」。",
  "5. 禁止使用题库之外的知识作答、补充或改写答案。",
  "",
  "【能力三 ·《三国演义》原著检索（sango_novel_search）】",
  "什么时候调：用户询问《三国演义》原著情节、人物、事件等需要原文依据的问题时，调用 sango_novel_search 工具检索原文（参数 source=sanguo-yanyi、query=用户白话问句、limit 默认 5）。",
  "调了之后怎么答（以下 6 条必须严格遵守）：",
  "1. 回答前必须先调用 sango_novel_search 工具检索《三国演义》原文。",
  "2. 只依据工具返回的原文作答：人物、情节、数字都必须能在原文里找到。",
  "3. 人名一律以召回原文为准：原文写谁就是谁，不得按常识/记忆替换、不得补别名、不得解释成别人。",
  "4. 原文里没有相关内容的问句，必须回答「演义中未涉及」，禁止用先验知识补全。",
  "5. 不评价、不纠正、不对比：不得说原文写错，不得提正史/影视/游戏，不得出现「实际上是…」这类转折。",
  "6. 回答格式固定：先写一句结论，再用指针引用原文。引语原文与出处一律由服务端按字段渲染，你不得抄写；你只输出指针 `[Qn]`（n 为注入片段中 `⟨Qn⟩` 标记的序号，如 `[Q2]`）。示例：「关羽拒绝了孙权的联姻，回以[Q2]。」严禁输出引语原文、回目、出处或段号。",
  "",
  // 优先级判断次序
  "【判断次序（自上而下，命中即停）】",
  "三个专用域互斥，按语义命中即停：",
  "1. 意图是否命中风云三国游戏内招募武将问答题 → 命中：调 fengyunsanguo_query，按能力二的 5 条作答。",
  "1.1 意图是否命中《三国演义》原著情节 / 人物 / 事件等需要原文依据的问句 → 命中：调 sango_novel_search（参数 source=sanguo-yanyi、query=用户白话问句、limit 默认 5），按能力三的 6 条作答。",
  "2. 意图是否命中美国境内城市的天气 / 地铁通勤出行 → 命中：调 get-forecast（必要时 get-alerts），按能力一的 5 条作答。",
  "3. 以上都未命中 → 不调用任何工具，转入分域兜底。",
  "",
  // 分域兜底
  "【分域兜底（未命中专用能力时按所属域处理，不存在笼统的自由回答）】",
  "- 原著检索域：调过 sango_novel_search 但检索无命中，或引用校验不过 → 不做归纳生成，输出「原文片段 + 出处」并补一句结论归纳（如「按原文，斩华雄者系关羽」）；原文无相关内容时按能力三第 4 条回答「演义中未涉及」。",
  "- 三国题库域：调过 fengyunsanguo_query 但候选中没有含义对应的题 → 只回复「题库未收录该题，请换个问法」，不用题库之外的知识补答。",
  "- 非美国天气域：用户问的是美国以外地区（如北京）的天气 → 不调用天气工具，明确告知仅支持美国境内天气查询、无法提供该地区数据；严禁编造温度、降水或预警数值。",
  "- 其余域：包括问候（如「你好」）、闲聊以及与天气、题库无关的通用问题 → 不调用任何工具，凭自身知识自由作答，简洁清楚；不套用天气播报格式，不套用题库话术，不确定时直接说明。",
  "",
  // 输出格式约束
  "【输出格式约束】",
  "一律输出简体中文纯文本；只有天气域、题库域与原著检索域有强制格式（见上），其余域按普通对话作答，不加无关模板、不解释自己的判断过程、不提及工具名。",
].join("\n");

/** 域提示：命中域后追加在统一提示词之后（域内工具已预调并注入结果，模型不再自行调工具） */
const ROUTE_HINTS: Record<string, string> = {
  fengyunsanguo: ["当前用户已明确选择了“风云三国题库”场景（题库域硬锁）。系统已预先调用 fengyunsanguo_query 检索题库，候选题目附在问题下方【已检索到的题库候选】中；请直接依据候选作答，不要再调用 fengyunsanguo_query：候选中含义相同的那道题只输出该题答案原文，候选为「未召回到任何候选题目」时只回复「题库未收录该题，请换个问法」。"].join('\n'),
  "sango-novel":
    ['当前用户已明确选择了“三国演义原著解读”场景。系统已预先调用 sango_novel_search（source=sanguo-yanyi）检索《三国演义》原文并附在问题下方【已检索到的《三国演义》原文片段】中；请直接依据这些片段作答，不要再调用 sango_novel_search。',
      '1. 给出一句结论，结论必须直接回答用户问题的主体。例如用户问“谁温酒斩华雄”，结论应写「关羽温酒斩华雄」；不能只写「酒尚温时斩华雄」。人名用原文中的称呼，关羽、云长、关公均可。',
      '2. 结论后用指针引用原文：对应答案句是引语时输出 `[Qn]`（n 为 `⟨Qn⟩` 标记序号，如 [Q2]）；答案句是无引号的叙述句时输出 `[片段N]`（n 为该片段编号，如 [片段1]）。引语原文与出处由服务端按字段渲染，你不得抄写；严禁输出引语原文、回目、出处或段号。',
      '3. 只依据片段作答；片段中确实没有相关内容时才回复「演义中未涉及」。',
      '4. 正常回答不要以「按原文，」开头，禁止输出解释、总结或格式以外的内容。若提问明显不属于原著检索（如问候、天气等），按普通对话处理。'
    ].join("\n"),
};

// feat-A004：引用硬校验的兜底结论归纳提示词（校验 / 格式不过时调用）
const CITATION_FALLBACK_CONCLUSION_PROMPT =
  "根据给定的《三国演义》原文片段，用一句话归纳结论，以「按原文，」开头；结论必须先回答用户问题的主体（例如用户问“谁”，就要写出对应人物），再写事件，禁止只复述事件。如果用户只是问名字，只回答名字即可。只依据片段内容作答，不得补充片段之外的信息，不得评价、纠正、对比原文。引用的原文片段长度以10字内为佳，最长不得超过20汉字。";

/** 路由目标（docs/sango-mcp-routing-design.md §二）：决定系统提示词、可见工具与是否走域内快路径 */
export type RouteTarget = "weather" | "fengyunsanguo" | "sango-novel" | "auto";

/** L3 向量匹配注入点：只做风云三国高置信正向识别，命中返回 fengyunsanguo */
export type FengyunsanguoVectorMatcher = (
  query: string
) =>
  | boolean
  | "fengyunsanguo"
  | null
  | Promise<boolean | "fengyunsanguo" | null>;

/** 本地题库工具名（index.ts 装配同名 localTool）：fengyunsanguo 域快路径预调它，不经模型决策 */
export const FENGYUNSANGUO_QUERY_TOOL = "fengyunsanguo_query";

/** feat-A010 模型可见工具白名单（硬约束）：登记对象 = 工具定义清单（MCP 工具 + options.tools 注入的本地工具定义），
 * 不是 options.localTools 的 key（localTools 只是「工具名 → 处理器」派发映射）。
 * 器坊新增后台专用工具（sango_novel_chapter）默认不在白名单 → 模型不可见；后台 HTTP 直调不受影响。
 * 初始值按当前 /api/tools 实际输出核对登记（见 api/feat-A010-original-text-reader.md §4.2）。 */
const MODEL_VISIBLE_TOOLS: string[] = [
  'get-alerts',
  'get-forecast',
  FENGYUNSANGUO_QUERY_TOOL,
  'fengyunsanguo_quiz_command',
  'fengyunsanguo_quiz_route',
  SANGO_NOVEL_SEARCH_TOOL,
];

/** L1 前端标签 → 域：domain 取值与 server.ts 白名单同源，命中即跳过后续所有路由判断 */
const DOMAIN_ROUTES: Record<string, RouteTarget> = {
  weather: "weather",
  fengyunsanguo: "fengyunsanguo",
  "sango-novel": "sango-novel",
};

// L2 本地关键词硬匹配（文档 §二 第二层）：命中任意专属关键词即路由到对应域
const FENGYUNSANGUO_KEYWORDS = ["风云三国", "MOD", "骑砍", "招募", "答题", "好感度"];
const NOVEL_KEYWORDS = [
  "官职",
  "生卒年",
  "原著",
  "章节",
  "第几回",
  "原文",
  "生平",
  "演义",
  "三国时期",
  "罗贯中",
];
const WEATHER_KEYWORDS = [
  "天气",
  "气温",
  "下雨",
  "下雪",
  "湿度",
  "风力",
  "晴天",
  "阴天",
  "温度",
  "降雨",
  "雷暴",
  "大风",
  "出门",
  "游玩",
  "旅游",
  "美国",
];

// 重叠题校正（文档 §二 第三层 4）：字 / 籍贯 在题库与文史两域都高频出现，命中后不直接路由
const AMBIGUOUS_KEYWORDS = ["字", "籍贯"];

export type LocalToolHandler = (
  args: Record<string, unknown>
) => ToolCallResult | Promise<ToolCallResult>;

/** feat-A009：检索工具调用路径（fastpath=域内快路径确定性注入；tooluse=LLM 自主 tool-use） */
type RetrievalKind = "fastpath" | "tooluse";

/** feat-A009：一次带诊断的检索调用登记（seq=tool_call_logs 行号；diagnostics 保留给收尾回填） */
interface RetrievalCallRecord {
  seq: number | null;
  diagnostics: Record<string, unknown> | null;
  kind: RetrievalKind;
}

/** feat-A009：本次请求的小说召回编排追踪——片段 ↔ chunkId 对齐 + 检索调用登记（收尾回填用） */
interface NovelTracking {
  fragments: RecallFragment[];
  chunkMeta: Array<{ chunkId: string | null; kind: RetrievalKind }>;
  calls: RetrievalCallRecord[];
}

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
  /** feat-A004 引用硬校验注入点（测试用）；不注入使用默认实现（本地别名表扫描 + LLM 结论归纳） */
  aliasTable?: Map<string, string>;
  fallbackConcluder?: (fragments: RecallFragment[]) => Promise<string>;
  /** L3 向量匹配注入点；命中 fengyunsanguo 后走题库快路径 */
  fengyunsanguoVectorMatcher?: FengyunsanguoVectorMatcher;
  /** feat-A009 诊断落库注入点（测试用）；不注入使用默认实现（appendRetrievalLog，旁路静默） */
  retrievalDiagnosticsPersister?: RetrievalPersister;
}

export class Agent {
  private transport: MCPTransport;
  private config: LLMConfig;
  private options: AgentOptions;
  private systemPrompt: string;
  private aliasTable: Map<string, string> | null = null;
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
    tools: MCPToolDefinition[],
    stage?: LlmStage
  ): Promise<ModelResponse> {
    if (!this.openai) {
      throw new Error("OpenAI-compatible client not initialized");
    }

    // feat-A007 埋点：仅请求上下文（getTraceId 非空）且显式指定 stage 时记录，其余路径零开销
    const traceId = getTraceId();
    const logContext =
      stage != null && typeof traceId === "string" && traceId !== ""
        ? { traceId, stage }
        : null;
    const requestAt = Date.now();
    const requestSummary = logContext ? summarizeJson(messages) : "";

    console.error('[callModel]', 'messages:', messages);
    console.time('callModel');
    let response: Awaited<ReturnType<typeof this.openai.chat.completions.create>>;
    try {
      response = await this.openai.chat.completions.create({
        model: this.config.model,
        messages,
        tools: this.getOpenAITools(tools),
        max_tokens: 1000,
        temperature: 0.7,
      });
    } catch (error) {
      if (logContext) {
        try {
          appendLlmCall(logContext.traceId, {
            stage: logContext.stage,
            model: this.config.model,
            requestAt,
            responseAt: null,
            requestSummary,
            responseSummary: null,
            status: "failed",
            errorMessage: toErrorMessage(error),
          });
        } catch {
          // 旁路：埋点失败静默，绝不影响 LLM 编排
        }
      }
      throw error;
    }
    console.timeEnd('callModel');

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

    if (logContext) {
      try {
        appendLlmCall(logContext.traceId, {
          stage: logContext.stage,
          model: this.config.model,
          requestAt,
          responseAt: Date.now(),
          requestSummary,
          responseSummary: summarizeJson(normalizedContent),
          toolCalls: summarizeToolCalls(message?.tool_calls),
          promptTokens: response.usage?.prompt_tokens ?? null,
          completionTokens: response.usage?.completion_tokens ?? null,
          finishReason: response.choices?.[0]?.finish_reason ?? null,
          status: "success",
          errorMessage: "",
        });
      } catch {
        // 旁路：埋点失败静默，绝不影响 LLM 编排
      }
    }

    return { content: normalizedContent, reasoningContent };
  }

  /** 上报的能力 = 模型实际可见的能力：与 processQuery 的 availableTools 同源 */
  async listTools(): Promise<MCPToolDefinition[]> {
    return this.resolveModelTools();
  }

  /** feat-A010：模型可见工具 = 白名单过滤后的工具定义（options.tools 注入路径同样过滤，保证「模型可见 = 白名单」恒成立） */
  private async resolveModelTools(): Promise<MCPToolDefinition[]> {
    const tools = this.options.tools ?? (await this.transport.listTools());
    return tools.filter((tool) => MODEL_VISIBLE_TOOLS.includes(tool.name));
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

  /** sango-novel 快路径：直接调检索工具（不经模型决策）；测试可用 localTools 注入 */
  private async searchNovel(query: string): Promise<ToolCallResult> {
    // 返回收缩到 10 条（候选人来自 mcp-server 侧 50 路候选 + 重排），与 INJECT_FRAGMENT_LIMIT 联动
    const args = { source: "sanguo-yanyi", query, limit: 10 };
    const localTool = this.options.localTools?.[SANGO_NOVEL_SEARCH_TOOL];
    return localTool
      ? await localTool(args)
      : await this.callTransportTool(SANGO_NOVEL_SEARCH_TOOL, args);
  }

  /** fengyunsanguo 域快路径：直接调题库工具（不经模型决策）；测试可用 localTools 注入 */
  private async searchFengyunsanguoQuestions(query: string): Promise<ToolCallResult> {
    const args = { text: query };
    const localTool = this.options.localTools?.[FENGYUNSANGUO_QUERY_TOOL];
    return localTool
      ? await localTool(args)
      : await this.callTransportTool(FENGYUNSANGUO_QUERY_TOOL, args);
  }

  private invokeModel(
    messages: any[],
    tools: MCPToolDefinition[],
    stage?: LlmStage
  ): Promise<ModelResponse> {
    if (this.options.modelCaller) {
      return this.options.modelCaller(messages, tools);
    }
    return this.callModel(messages, tools, stage);
  }

  /** 工具返回的纯文本片段（空文本不计入） */
  private collectTexts(result: ToolCallResult): string[] {
    return result.content
      .filter(
        (item) =>
          item.type === "text" &&
          typeof item.text === "string" &&
          item.text.trim().length > 0
      )
      .map((item) => item.text!.trim());
  }

  /** feat-A004/A009：sango_novel_search 返回文本 → 召回原文片段 + 逐条 chunkId。
   * 片段与 chunkId 同一遍历 / 跳过规则（extractEntryChunkIds 对齐 toRecallFragments），
   * 供收尾把「片段 → 候选」映射回诊断（服务端内部已知，不做文本比对）。 */
  private collectRecallFragmentsWithChunkIds(
    result: ToolCallResult,
    args: Record<string, unknown>
  ): { fragments: RecallFragment[]; chunkIds: Array<string | null> } {
    const texts = this.collectTexts(result);
    const source =
      typeof args.source === "string" && args.source.trim()
        ? args.source
        : "《三国演义》";
    // 工具按相关度降序返回结构化条目（spec §5）；出处 / 段号 / 分数走字段，正文只留纯原文
    return {
      fragments: toRecallFragments(texts, source),
      chunkIds: extractEntryChunkIds(result),
    };
  }

  /** feat-A009：登记一次带诊断的检索调用（无诊断不登记；诊断对象保留给收尾回填后落库） */
  private recordRetrievalCall(
    tracking: NovelTracking,
    result: ToolCallResult,
    kind: RetrievalKind
  ): void {
    const meta = extractRetrievalMeta(result);
    if (!meta.diagnostics) {
      return;
    }
    tracking.calls.push({
      seq: meta.seq,
      diagnostics: meta.diagnostics,
      kind,
    });
  }

  private getAliasTable(): Map<string, string> {
    if (this.options.aliasTable) {
      return this.options.aliasTable;
    }
    if (!this.aliasTable) {
      this.aliasTable = loadAliasTable();
    }
    return this.aliasTable;
  }

  private concludeFallback(
    fragments: RecallFragment[],
    query: string
  ): Promise<string> {
    if (this.options.fallbackConcluder) {
      return this.options.fallbackConcluder(fragments);
    }
    return this.concludeFallbackViaModel(fragments, query);
  }

  private async concludeFallbackViaModel(
    fragments: RecallFragment[],
    query: string
  ): Promise<string> {
    // 只取最符合的一段（检索词附近窗口），避免结论归纳被无关长文带偏；
    // 选段与兜底展示同口径（pickBestFallbackFragment 锚点评分），不再盲取 fragments[0]；
    // 片段与出处同样由字段渲染（纯原文 + 回目），模型只归纳一句结论
    const top = fragments.length
      ? pickBestFallbackFragment(fragments, query)
      : null;
    const fragmentText = top
      ? buildInjectionView([top], query).text
      : "（无原文片段）";
    const content = `用户问题：${query}\n\n${fragmentText}`;
    const response = await this.invokeModel(
      [
        { role: "system", content: CITATION_FALLBACK_CONCLUSION_PROMPT },
        { role: "user", content },
      ],
      [],
      "generation"
    );
    return response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text!)
      .join("\n")
      .trim();
  }

  /**
   * feat-A004/A006：引用硬校验（本地别名表扫描，0 次 LLM）+ 指针校验 + 服务端渲染引文与 citations。
   * 模型只输出「结论 + 指针」（`[Qn]`）：指针合法（∈ 本次注入的 qid）且断言人物 ⊆ 召回人物 →
   * 由字段渲染「引文」+ 全局上标角标并组装 citations（按引用出现顺序、片段粒度合并）；
   * 指针非法 / 抄写超长引语 / 断言不成立 → 兜底（结论句带角标 ¹ + 恰一条兜底片段）。
   * feat-A009：同步计算被引用片段 → 候选 chunkId 集合（服务端内部映射，不做文本比对），
   * 供收尾回填 candidates[].cited / funnel.cited。
   */
  private async applyNovelCitationGuard(
    answer: string,
    fragments: RecallFragment[],
    query: string,
    view: InjectionView | null,
    chunkMeta: NovelTracking["chunkMeta"] | null = null
  ): Promise<{ data: ChatData; citedChunkIds: Set<string> }> {
    if (fragments.length === 0 || !view) {
      return {
        data: { answer: NOVEL_NO_HIT_ANSWER, citations: [] },
        citedChunkIds: new Set(),
      };
    }
    const aliasTable = this.getAliasTable();
    const recallText = fragments.map((fragment) => fragment.text).join("\n");
    const recallPersonIds = scanRecallPersonIds(recallText, aliasTable);
    // 软性域：问候 / 天气等非原著问句（无别名人物、无指针）不套用原著检索格式
    // 判定基于原始输出：安全网只做内容回收，不得把非原著答案误吞成空串
    const isNovelAnswer =
      scanRecallPersonIds(answer, aliasTable).size > 0 ||
      /\[Q\d+\]/.test(answer) ||
      /\[片段\d+\]/.test(answer) ||
      /按原文，/.test(answer);
    if (!isNovelAnswer) {
      return { data: { answer, citations: [] }, citedChunkIds: new Set() };
    }
    // H4 长引语安全网：模型输出里的超长「…」是违规抄写，直接丢弃；原文改由指针 + 字段渲染提供。
    // 断言扫描对象是丢弃违规抄写后的答案正文人名（抄写内容不参与断言）
    const cleaned = stripOverlongModelQuotes(answer);
    const assertedIds = scanRecallPersonIds(cleaned, aliasTable);
    const pointer = validateQuotePointers(
      cleaned,
      view.quotes,
      view.fragments
    );
    const asserted = [...assertedIds].map((id) => ({ name: id, id }));
    const check = verifyCitation(asserted, recallText, recallPersonIds);
    if (pointer.ok && check.ok) {
      return {
        data: renderAnswerWithCitations(cleaned, view),
        citedChunkIds: this.computeCitedChunkIds(
          cleaned,
          view,
          fragments,
          chunkMeta
        ),
      };
    }
    const conclusion = await this.concludeFallback(fragments, query);
    return {
      data: buildFallback(fragments, conclusion, query),
      citedChunkIds: this.computeFallbackCitedChunkIds(
        fragments,
        query,
        conclusion,
        chunkMeta
      ),
    };
  }

  /** feat-A009：指针合法路径的 cited——按注入视图编号表反查候选 chunkId（§9-7 不做逐条文本比对） */
  private computeCitedChunkIds(
    answer: string,
    view: InjectionView,
    fragments: RecallFragment[],
    chunkMeta: NovelTracking["chunkMeta"] | null
  ): Set<string> {
    const cited = new Set<string>();
    if (!chunkMeta) {
      return cited;
    }
    const pickedIndices = computePickedIndices(fragments);
    for (const ref of extractCitePointers(answer)) {
      const fragmentKey = ref.startsWith("Q")
        ? view.quoteFragments.get(ref)
        : ref;
      const match = fragmentKey && /^片段(\d+)$/.exec(fragmentKey);
      if (!match) {
        continue;
      }
      const index = pickedIndices[Number(match[1]) - 1];
      const chunkId = index !== undefined ? chunkMeta[index]?.chunkId : null;
      if (chunkId) {
        cited.add(chunkId);
      }
    }
    return cited;
  }

  /** feat-A009：兜底路径 cited（§3.2 兜底口径）——兜底片段若来自某候选则计入，未经过注入视图故不计入 injected */
  private computeFallbackCitedChunkIds(
    fragments: RecallFragment[],
    query: string,
    conclusion: string,
    chunkMeta: NovelTracking["chunkMeta"] | null
  ): Set<string> {
    const cited = new Set<string>();
    if (!chunkMeta || fragments.length === 0) {
      return cited;
    }
    const top = pickBestFallbackFragment(fragments, query, conclusion);
    const index = fragments.indexOf(top);
    const chunkId = index >= 0 ? chunkMeta[index]?.chunkId : null;
    if (chunkId) {
      cited.add(chunkId);
    }
    return cited;
  }

  /**
   * 路由判定（零 LLM）：L1 前端标签 → L2 本地关键词硬匹配。
   * 返回 "auto" 表示前两层未命中，交统一 Agent 按语义自主决策（L3 题库高置信识别由调用方注入）。
   */
  resolveRoute(query: string, domain?: string): RouteTarget {
    if (domain && DOMAIN_ROUTES[domain]) {
      return DOMAIN_ROUTES[domain];
    }
    const lowered = query.toLowerCase();
    const hit = (keywords: string[]) =>
      keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
    if (hit(FENGYUNSANGUO_KEYWORDS)) {
      return "fengyunsanguo";
    }
    if (hit(NOVEL_KEYWORDS)) {
      return "sango-novel";
    }
    if (hit(WEATHER_KEYWORDS)) {
      return "weather";
    }
    return "auto";
  }

  private async resolveUserContent(
    query: string,
    domain?: string,
    tracking?: NovelTracking
  ): Promise<{
    result: string;
    novelView?: InjectionView;
    novelSearched?: boolean;
  }> {
    if (domain && DOMAIN_ROUTES[domain]) {
      if (domain === DOMAIN_ROUTES["sango-novel"]) {
        const result = await this.searchNovel(query);
        const { fragments, chunkIds } = this.collectRecallFragmentsWithChunkIds(result, {
          source: "sanguo-yanyi",
          query,
          limit: 10,
        });
        // 过滤与片段同序对齐（"未召回" 兜底条目不进注入视图，也不参与回填）
        const kept: RecallFragment[] = [];
        const keptChunkIds: Array<string | null> = [];
        for (let i = 0; i < fragments.length; i++) {
          if (fragments[i].text.includes("未召回")) {
            continue;
          }
          kept.push(fragments[i]);
          keptChunkIds.push(chunkIds[i] ?? null);
        }
        const novelFragments = tracking ? tracking.fragments : kept;
        if (tracking) {
          tracking.fragments.push(...kept);
          tracking.chunkMeta.push(
            ...keptChunkIds.map((chunkId) => ({
              chunkId,
              kind: "fastpath" as const,
            }))
          );
          this.recordRetrievalCall(tracking, result, "fastpath");
        }

        // 注入策略（2026-09-20 定稿）：前 5 段整段保底 + 第 6–10 段预算兜底（INJECT_TAIL_FALLBACK_ENABLED=false 时只注入前 5 段）；
        // 超预算丢整段、不段内裁剪；注入视图只给纯原文 + 服务端编号（`[片段N]` / `⟨Qn⟩`），不带回目、段号、分数（spec §6.3）
        const view = buildInjectionView(novelFragments, query);
        const injected = novelFragments.length ? view.text : "（检索无命中）";
        return {
          result: injected,
          novelView: view,
          novelSearched: true,
        };
      } else if (domain === DOMAIN_ROUTES["fengyunsanguo"]) {
        const result = await this.searchFengyunsanguoQuestions(query);
        return { result: this.collectTexts(result).join("\n") };
      } else if (domain === DOMAIN_ROUTES["weather"]) {
        // Handle weather domain
      }
    }
    return { result: '' };
  }

  /**
   * 处理用户提问并回答（feat-A006 结构化）：同样走三层路由判定与域内快路径
   * （L1 标签 → L2 关键词 → L3 题库高置信识别，L3 仅 auto 时生效），
   * 返回 /api/chat 响应 data 统一形状 { answer, citations }（无引用恒 []）。
   */
  async processQueryData(query: string, domain?: string): Promise<ChatData> {
    // feat-A009：本次请求的小说召回编排追踪（片段 ↔ chunkId + 检索调用登记），收尾回填 injected/cited
    const tracking: NovelTracking = {
      fragments: [],
      chunkMeta: [],
      calls: [],
    };
    let novelView: InjectionView | null = null;
    let novelSearched = false;
    const userContent = query.trim();
    let resolvedContent = '';

    // L1 / L2 已命中专用域，直接走域内快路径（不经 L3）
    let route = this.resolveRoute(query, domain);
    if (Object.values(DOMAIN_ROUTES).includes(route)) {
      const result = await this.resolveUserContent(query, domain || route, tracking);
      resolvedContent = result.result;
      novelView = result.novelView || null;
      novelSearched = result.novelSearched ?? false;
    }

    // L3 向量匹配注入点：只做风云三国高置信正向识别，命中 fengyunsanguo 后走题库快路径；
    // 仅 auto（L1/L2 未锁定域）时生效——domain 硬锁（weather/fengyunsanguo/sango-novel）不得被 L3 覆盖
    if (route === "auto") {
      const fengyunsanguoHit = await this.options.fengyunsanguoVectorMatcher?.(query);
      if (fengyunsanguoHit === true || fengyunsanguoHit === "fengyunsanguo") {
        route = DOMAIN_ROUTES.fengyunsanguo;
        const { result } = await this.resolveUserContent(query, route);
        resolvedContent = result;
      }
    }

    const systemContent = resolvedContent ? ROUTE_HINTS[route] : this.systemPrompt;
    let messages: any[] = [
      { role: "system", content: systemContent, },
      { role: "user", content: userContent, },
    ];
    if (resolvedContent) {
      messages.push({ role: "system", content: resolvedContent, });
    }
    let availableTools = await this.resolveModelTools();
    let currentResponse = await this.invokeModel(messages, availableTools, "routing"); // 调LLM

    const MAX_TOOL_ROUNDS = 8
    let toolRounds = 0
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
        // 模型自行调原著检索工具：与快路径同源收集片段，并把注入视图（纯原文 + 服务端编号）
        // 作为工具出参回填——模型看到的 `⟨Qn⟩` 与指针校验用的 qid 集合同源
        let toolContent = JSON.stringify(result.content);
        if (toolName === SANGO_NOVEL_SEARCH_TOOL) {
          novelSearched = true;
          // 模型自主调原著检索（route=auto 的 tool-use 路径）：与快路径同源收集片段 + chunkId，
          // 并把注入视图（纯原文 + 服务端编号）作为工具出参回填——模型看到的 `⟨Qn⟩` 与指针校验同源
          const { fragments, chunkIds } =
            this.collectRecallFragmentsWithChunkIds(result, toolArgs);
          tracking.fragments.push(...fragments);
          tracking.chunkMeta.push(
            ...chunkIds.map((chunkId) => ({
              chunkId,
              kind: "tooluse" as const,
            }))
          );
          this.recordRetrievalCall(tracking, result, "tooluse");
          const view = buildInjectionView(tracking.fragments, query);
          novelView = view;
          toolContent = view.text;
        }
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
          content: toolContent,
        });
      }

      if (!hasToolUse || toolRounds >= MAX_TOOL_ROUNDS) {
        break;
      }
      toolRounds++;

      currentResponse = await this.invokeModel(messages, availableTools, "generation");
    }

    let answer = currentResponse.content
      .filter((item) => item.type === "text")
      .map((item) => item.text!)
      .join("\n")
      .trim();

    // 调过原著检索即进校验：无命中（片段为空）由 guard 统一回「演义中未涉及」+ citations []
    let data: ChatData;
    let citedChunkIds = new Set<string>();
    if (novelSearched) {
      const guarded = await this.applyNovelCitationGuard(
        answer,
        tracking.fragments,
        query,
        novelView,
        tracking.chunkMeta
      );
      data = guarded.data;
      citedChunkIds = guarded.citedChunkIds;
    } else {
      data = { answer, citations: [] };
    }
    // feat-A009 收尾：回填 injected/cited 后按 (trace_id, seq) 一次性落库（旁路原则：失败不影响响应）
    this.persistRetrievalDiagnostics(tracking, citedChunkIds);
    return data;
  }

  /** feat-A009：注入视图实际纳入的候选 chunkId（快路径确定性注入计入；
   * LLM 自主 tool-use 路径按 §3.2 口径不统计注入视图 → injected=0 属预期） */
  private computeInjectedChunkIds(tracking: NovelTracking): Set<string> {
    const injected = new Set<string>();
    const pickedIndices = computePickedIndices(tracking.fragments);
    for (const index of pickedIndices) {
      const meta = tracking.chunkMeta[index];
      if (meta?.kind === "fastpath" && meta.chunkId) {
        injected.add(meta.chunkId);
      }
    }
    return injected;
  }

  /** feat-A009：收尾落库（旁路，§3.3/§6）：回填 injected/cited → appendRetrievalLog；
   * 任一环节失败静默，绝不影响 /api/chat 主流程与响应 */
  private persistRetrievalDiagnostics(
    tracking: NovelTracking,
    citedChunkIds: Set<string>
  ): void {
    const injectedChunkIds = this.computeInjectedChunkIds(tracking);
    const traceId = getTraceId();
    const traceIdValue =
      typeof traceId === "string" && traceId !== "" ? traceId : null;
    for (const call of tracking.calls) {
      if (!call.diagnostics || call.seq === null) {
        continue;
      }
      try {
        fillDiagnostics(call.diagnostics, injectedChunkIds, citedChunkIds);
        persistRetrievalDiagnostics(
          traceIdValue,
          call.seq,
          call.diagnostics,
          this.options.retrievalDiagnosticsPersister
        );
      } catch {
        // 旁路：回填/落库失败静默，不影响响应
      }
    }
  }

  /** 兼容旧调用：只返回结论正文（citations 由 processQueryData 承载） */
  async processQuery(query: string, domain?: string): Promise<string> {
    return (await this.processQueryData(query, domain)).answer;
  }
}
