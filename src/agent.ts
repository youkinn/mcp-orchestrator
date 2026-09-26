import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  ToolExecutionError,
  type LLMConfig,
  type MCPToolDefinition,
  type ModelResponse,
  type ToolCallResult,
} from "./types.js";
import type { MCPTransport, ToolCallOrigin } from "./transport.js";
import { getTraceId } from "./trace.js";
import {
  appendLlmCall,
  reportRouteSource,
  truncate,
  type InputBreakdown,
  type RouteSource,
} from "./storage/logs.js";
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
  findLowOverlapSentences,
  stripAnswerSentences,
  stripOverlongModelQuotes,
  stripPointerMarkers,
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
import type { CacheLookupResult, CacheManager } from "./cache.js";

export type { ChatData } from "./citation.js";

// feat-A007 埋点辅助（旁路静默）：序列化失败兜底 String，统一 8000 截断
// feat-A011：auto 首轮从「带工具自主决策（routing）」改为「无 tools 轻量分类（classify）」，枚举同步
// bug-00032/33/34：novel_boundary_check = 低重叠句边界语义复核（独立 stage，正常样本不出现）
type LlmStage = "classify" | "generation" | "novel_boundary_check";

interface ModelCallOptions {
  disableThinking?: boolean;
  temperature?: number;
}

/** bug-00018 空答案判定：无文本正文（content 为空），或 finish_reason=length（思考不收敛 / 截断）。
 * 其余终止原因（stop 等）不算空答案，正常走既有路径。 */
function isEmptyAnswer(
  content: ModelResponse["content"],
  finishReason: string | null
): boolean {
  const hasText = content.some(
    (item) =>
      item.type === "text" &&
      typeof item.text === "string" &&
      item.text.trim().length > 0
  );
  return !hasText || finishReason === "length";
}

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

/** feat-A012 §2.5：本次调用输出上限（请求参数与落库共用同一来源，防两处漂移） */
const MAX_TOKENS = 1000;

/** feat-A012 §2.3：CJK（含全角标点）1 token/字，其余 1 token/4 字符，累加后四舍五入 */
function estimateTokens(text: string): number {
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return Math.round(cjkCount + otherCount / 4);
}

/** feat-A012 §2.3：结构化 messages 的文本提取（字符串或 OpenAI 数组 text 项） */
function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (item: any) => item?.type === "text" && typeof item.text === "string"
      )
      .map((item: any) => item.text)
      .join("\n");
  }
  return "";
}

/** feat-A012 §2.3：基于结构化 messages 计算输入分段 token 估算；
 * system = 第一条 system 消息；user = user 消息；injected = 其余 system 消息；history / tools 恒 0 */
function computeInputBreakdown(messages: any[]): InputBreakdown {
  let system = 0;
  let user = 0;
  let injected = 0;
  let firstSystemSeen = false;
  for (const message of messages) {
    const text = messageText(message?.content);
    if (message?.role === "system") {
      if (firstSystemSeen) {
        injected += estimateTokens(text);
      } else {
        system += estimateTokens(text);
        firstSystemSeen = true;
      }
    } else if (message?.role === "user") {
      user += estimateTokens(text);
    }
  }
  return { system, user, injected, history: 0, tools: 0 };
}

// feat-A011：提示词拆分为「分类提示 + 域提示 + 自由对话提示」四常量（接口文档 §2.3 / §2.4，逐字节照录），
// 原 UNIFIED_SYSTEM_PROMPT 已删除。缓存友好：静态前缀逐字节稳定，变化内容（注入片段）恒在消息末尾。

/** 分类轮 system 提示词（§2.3）：请求体无 tools，模型只输出编号 */
export const CLASSIFY_SYSTEM_PROMPT = [
  "你是路由分类器，只输出一个数字编号，不要任何解释、标点或多余文字。",
  "1 = 《三国演义》原著检索域",
  "2 = 风云三国题库问答域",
  "99 = 其他（自由对话）",
  "不确定时倾向选 1 或 2。",
].join("\n");

/** sango-novel 域提示（§2.4）：域锁定快路径 / 分类编号 1 的生成轮 system 提示词 */
export const SANGO_NOVEL_DOMAIN_PROMPT = [
  "当前为「三国演义原著解读」场景。系统已检索《三国演义》原文并附在问题下方【已检索到的原文片段】中；请直接依据片段作答，不要再调用检索工具。",
  "1. 先给一句直接回答用户问题主体的结论，人名以召回原文为准（关羽、云长、关公均可）。",
  "2. 结论后引用原文：引语输出 [Qn]（n 为 ⟨Qn⟩ 标记序号）；无引号叙述句输出 [片段N]；引语原文与出处由服务端按字段渲染，你不得抄写，严禁输出回目、出处、段号。",
  "3. 片段中确实没有相关内容时回复「演义中未涉及」，禁止用先验知识补全。",
  "4. 不以「按原文，」开头，不输出解释、总结或格式以外的内容；提问明显不属于原著（如问候、天气）时按普通对话处理。",
  "5. 回答前，你必须先思考以下问题：",
  " 5-1 用户问题中的事件结构是：(施事者=?, 动作=?, 受事者=?)",
  " 5-2 检索文档中的事件结构是：(施事者=?, 动作=?, 受事者=?)",
  " 5-3 两者方向是否一致？如果不一致，禁止用该文档回答。",
  "6. 片段外信息不写不补：只依据注入片段作答，片段没有的内容一律不写、不以先验 / 史实补全。",
  "7. 必须直接回答用户问题本身：答案须针对问题核心作答，答非所问（如问结局却答过程）视为不合格。",
  "8. 用户问题携带的事件前提若与演义记载不符（如时间、人物、人物关系、事件归属等矛盾）：先按片段载明的演义事实说明并校正问题前提，再作答；禁止顺着错误前提硬凑答案，也禁止拒答。",
  "9. 结论允许对片段做语义等价的改述，但不得改变片段中的人名、动作方向、受事者、结果；改述句必须由所引片段语义支撑，引用指针必须指向该支撑片段。",
].join("\n");

/** fengyunsanguo 域提示（§2.4）：题库快路径 / 分类编号 2 的生成轮 system 提示词 */
export const FENGYUNSANGUO_DOMAIN_PROMPT =
  "当前为「风云三国题库」场景。系统已预先检索题库，候选题目附在问题下方【已检索到的题库候选】中；请直接依据候选作答，不要再调用检索工具：候选中含义相同的那道题只输出该题答案原文；候选为空、或候选中没有含义对应的题目（含只是字面相似、含义不同的）时，只回复「题库未收录该题，请换个问法」，禁止用题库外的知识作答、补充或改写答案。";

/** 自由对话提示（99，§2.4）：无注入生成轮 system 提示词，也是 Agent 默认 systemPrompt */
export const FREE_CHAT_SYSTEM_PROMPT =
  "你是统一对话助手，用简体中文回答用户问题。问候、闲聊与通用问题直接自由作答，简洁清楚，不加模板、不提及工具名。";

/** 域提示分派：与 DOMAIN_ROUTES 同键，域锁定后取对应生成轮提示词 */
const DOMAIN_PROMPTS: Record<string, string> = {
  fengyunsanguo: FENGYUNSANGUO_DOMAIN_PROMPT,
  "sango-novel": SANGO_NOVEL_DOMAIN_PROMPT,
};

/** feat-A011 分类编号表（接口文档 §2.2）：1~98 预留给能力域（加能力 = 加编号分支），99 恒为自由兜底 */
export const CLASSIFY_ROUTE_IDS = {
  sangoNovel: 1,
  fengyunsanguo: 2,
  freeChat: 99,
} as const;

/** feat-A011 分类轮回复解析：取回复文本首个数字（/^\d+/，先 trim）；
 * 无法解析或解析出非 1/2/99 的编号 → 一律按 99 处理，且不重试（§2.2 输出解析）。 */
export function parseClassifyRouteId(content: unknown): 1 | 2 | 99 {
  const text = Array.isArray(content)
    ? content
        .filter(
          (item: any) => item?.type === "text" && typeof item.text === "string"
        )
        .map((item: any) => item.text)
        .join("\n")
    : String(content ?? "");
  const match = /^\d+/.exec(text.trim());
  if (!match) {
    return 99;
  }
  const id = Number(match[0]);
  return id === 1 || id === 2 || id === 99 ? id : 99;
}

// feat-A004：引用硬校验的兜底结论归纳提示词（校验 / 格式不过时调用）
const CITATION_FALLBACK_CONCLUSION_PROMPT =
  "根据给定的《三国演义》原文片段，用一句话归纳结论，以「按原文，」开头；结论必须先回答用户问题的主体（例如用户问“谁”，就要写出对应人物），再写事件，禁止只复述事件。如果用户只是问名字，只回答名字即可。只依据片段内容作答，不得补充片段之外的信息，不得评价、纠正、对比原文。引用的原文片段长度以10字内为佳，最长不得超过20汉字。";

// bug-00032/33/34：结构门第三条「低重叠 → 边界语义复核」提示词（独立 stage novel_boundary_check，
// 正常样本不触发）。输入 = 用户问题 + 模型结论句 + 指向片段原文；只输出 supported / unsupported。
// 语义裁决必须走 LLM，不引入任何词表 / 关键词规则（bug-00028 复盘否决）。
export const NOVEL_BOUNDARY_CHECK_PROMPT = [
  "你是《三国演义》原著引用的边界审查员。",
  "给定：用户问题、模型结论句、片段原文。结论句中的 [片段N] 是服务端编号标记，不属于正文。",
  "判断：结论句的核心断言（人物、事件、结局、因果的事实归属）是否由该片段原文支撑。",
  "允许对片段做语义等价的改述：不改变片段中的人名、动作方向、受事者、结果，且片段原文足以推出或印证该断言 → supported。",
  "片段原文不足以支撑该断言（如结论来自先验知识、常识或个人判断），或改动了片段中的人名、动作方向、受事者、结果 → unsupported。",
  "只输出一个词：supported 或 unsupported，不要任何解释、标点或多余文字。",
].join("\n");

/** 路由目标（docs/sango-mcp-routing-design.md §二）：天气能力已下线（feat-A011），仅剩两能力域与 auto */
export type RouteTarget = "fengyunsanguo" | "sango-novel" | "auto";

/** feat-A012 §2.2：路由判定结果。route = 目标域；source = 路由来源
 * （label = L1 domain 参数命中；keyword = L2 关键词硬匹配命中；auto 未锁定 = null） */
export interface RouteDecision {
  route: RouteTarget;
  source: "label" | "keyword" | null;
}

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
 * feat-A011 天气下线：移除 get-forecast / get-alerts，仅剩 4 个能力工具。 */
const MODEL_VISIBLE_TOOLS: string[] = [
  FENGYUNSANGUO_QUERY_TOOL,
  'fengyunsanguo_quiz_command',
  'fengyunsanguo_quiz_route',
  SANGO_NOVEL_SEARCH_TOOL,
];

/** feat-A011 模型可见 description 映射表（接口文档 §1.2 全文，逐字节照录）：
 * 瘦身只发生在总台「模型可见渲染」层（resolveModelTools 白名单过滤后替换 description）；
 * MCP 传输层与 mcp-server 侧工具定义（name / description / inputSchema 原文）一字不动。 */
const MODEL_VISIBLE_DESCRIPTIONS: Record<string, string> = {
  [SANGO_NOVEL_SEARCH_TOOL]:
    "检索《三国演义》原著原文。仅当用户询问原著情节/人物/事件等需要原文依据的问题时调用；返回结构化条目数组，禁止凭记忆作答。",
  [FENGYUNSANGUO_QUERY_TOOL]:
    "风云三国题库候选召回：text 传用户原始问法，返回候选题目（题干→答案），供 LLM 判定对应题。",
  "fengyunsanguo_quiz_command":
    "风云三国随机一题状态机（本地规则，不经 LLM）：随机出题/判题/查答案，按 sessionId 维持会话。",
  "fengyunsanguo_quiz_route":
    "风云三国 L3 高置信识别（不经 LLM）：判定 text 是否为题库内问题，返回 JSON true/false。",
};

/** L1 前端标签 → 域：domain 取值与 server.ts 白名单同源，命中即跳过后续所有路由判断 */
const DOMAIN_ROUTES: Record<string, RouteTarget> = {
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
// 重叠题校正（文档 §二 第三层 4）：字 / 籍贯 在题库与文史两域都高频出现，命中后不直接路由
const AMBIGUOUS_KEYWORDS = ["字", "籍贯"];

export type LocalToolHandler = (
  args: Record<string, unknown>
) => ToolCallResult | Promise<ToolCallResult>;

/** feat-A009：检索工具调用路径（fastpath=域内快路径确定性注入；
 * tooluse 原为 LLM 自主 tool-use，feat-A011 删除工具自主决策路径后已无产生者，类型保留作历史口径） */
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
  /** feat-A013：sango-novel 域语义缓存管理器；不注入则缓存不生效（兼容存量调用） */
  cacheManager?: CacheManager;
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
      FREE_CHAT_SYSTEM_PROMPT;

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
    stage?: LlmStage,
    options?: ModelCallOptions
  ): Promise<ModelResponse> {
    if (!this.openai) {
      throw new Error("OpenAI-compatible client not initialized");
    }
    const openai = this.openai;

    // feat-A007 埋点：仅请求上下文（getTraceId 非空）且显式指定 stage 时记录，其余路径零开销
    const traceId = getTraceId();
    const logContext =
      stage != null && typeof traceId === "string" && traceId !== ""
        ? { traceId, stage }
        : null;
    const requestSummary = logContext ? summarizeJson(messages) : "";
    // feat-A012 §2.3：输入分段 token 估算（基于结构化 messages，仅 logContext 非空时计算；各段之和不与 prompt_tokens 对账）
    const inputBreakdown = logContext ? computeInputBreakdown(messages) : null;

    /** 单次请求（参数化温度 / 思考开关）：请求异常记 failed 并上抛，成功返回归一化结果与元信息。
     * feat-A012 §2.1：attempt = 调用轮次（1 = 首轮 / 2 = 变参重试），随返回对象携带，落库显式传。 */
    const callOnce = async (
      callOptions: ModelCallOptions,
      attempt: 1 | 2
    ): Promise<{
      requestAt: number;
      response: OpenAI.Chat.Completions.ChatCompletion;
      message: any;
      normalizedContent: any[];
      reasoningContent: string | null;
      finishReason: string | null;
      attempt: 1 | 2;
      temperature: number;
    }> => {
      const requestAt = Date.now();
      // feat-A013：本次调用生效温度（params / 返回 / catch 落库同源，仅算一次）
      const temperature = callOptions.temperature ?? 0.7;
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        const params: Record<string, unknown> = {
          model: this.config.model,
          messages,
          tools: this.getOpenAITools(tools),
          // bug-00018：本模型为思考模型，reasoning_tokens 计入 completion_tokens，max_tokens 同时限制
          // 「思考 + 正文」；思考不收敛时正文恒为空（放大 max_tokens 无效）。各调用点是否关闭思考
          // 的口径见 bug-00018，调用点均有对应备注。
          max_tokens: MAX_TOKENS,
          temperature,
        };
        if (callOptions.disableThinking) {
          // bug-00018：provider 实测生效参数（OpenAI SDK 类型未收录，按扩展字段透传）
          params.thinking = { type: "disabled" };
        }
        response = (await openai.chat.completions.create(
          params as any
        )) as OpenAI.Chat.Completions.ChatCompletion;
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
              attempt,
              inputBreakdown,
              maxTokens: MAX_TOKENS,
              temperature,
              status: "failed",
              errorMessage: toErrorMessage(error),
            });
          } catch {
            // 旁路：埋点失败静默，绝不影响 LLM 编排
          }
        }
        throw error;
      }

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

      return {
        requestAt,
        response,
        message,
        normalizedContent,
        reasoningContent,
        finishReason: response.choices?.[0]?.finish_reason ?? null,
        attempt,
        temperature,
      };
    };

    /** 落库一条 LLM 调用明细（success / failed + error_message），旁路：埋点失败静默 */
    const recordCall = (
      call: Awaited<ReturnType<typeof callOnce>>,
      status: "success" | "failed",
      errorMessage: string
    ): void => {
      if (!logContext) {
        return;
      }
      try {
        appendLlmCall(logContext.traceId, {
          stage: logContext.stage,
          model: this.config.model,
          requestAt: call.requestAt,
          responseAt: Date.now(),
          requestSummary,
          responseSummary: summarizeJson(call.normalizedContent),
          toolCalls: summarizeToolCalls(call.message?.tool_calls),
          promptTokens: call.response.usage?.prompt_tokens ?? null,
          completionTokens: call.response.usage?.completion_tokens ?? null,
          cachedTokens:
            call.response.usage?.prompt_tokens_details?.cached_tokens ?? null,
          reasoningTokens:
            call.response.usage?.completion_tokens_details?.reasoning_tokens ??
            null,
          attempt: call.attempt,
          inputBreakdown,
          maxTokens: MAX_TOKENS,
          temperature: call.temperature,
          finishReason: call.finishReason,
          status,
          errorMessage,
        });
      } catch {
        // 旁路：埋点失败静默，绝不影响 LLM 编排
      }
    };

    // 首轮：按调用点口径（options 缺省 = 保留思考 + temperature 0.7）
    const first = await callOnce(
      {
        disableThinking: options?.disableThinking,
        temperature: options?.temperature,
      },
      1
    );
    if (!isEmptyAnswer(first.normalizedContent, first.finishReason)) {
      recordCall(first, "success", "");
      return {
        content: first.normalizedContent,
        reasoningContent: first.reasoningContent,
      };
    }

    // bug-00018 空答案兜底：content 为空 / finish_reason=length → 变参重试 1 次
    // （temperature=0 必做；该轮若开着思考则一并关闭）。超时 / 限流 / 工具不可用不重试（异常路径直接上抛）。
    recordCall(
      first,
      "failed",
      `空答案：content 为空 / finish_reason=${first.finishReason}`
    );
    const retry = await callOnce({ disableThinking: true, temperature: 0 }, 2);
    if (isEmptyAnswer(retry.normalizedContent, retry.finishReason)) {
      recordCall(retry, "failed", "空答案：变参重试后仍为空");
      throw new Error("模型返回空答案，请稍后重试");
    }
    recordCall(retry, "success", "");
    return {
      content: retry.normalizedContent,
      reasoningContent: retry.reasoningContent,
    };
  }

  /** 上报的能力 = 模型实际可见的能力：与 processQuery 的 availableTools 同源 */
  async listTools(): Promise<MCPToolDefinition[]> {
    return this.resolveModelTools();
  }

/** feat-A010/A011：模型可见工具 = 白名单过滤后的工具定义，并替换为瘦身 description（§1.2）；
 * options.tools 注入路径同样过滤，保证「模型可见 = 白名单」恒成立；原对象不原地改动（MCP 侧原文一字不动）。 */
  private async resolveModelTools(): Promise<MCPToolDefinition[]> {
    const tools = this.options.tools ?? (await this.transport.listTools());
    return tools
      .filter((tool) => MODEL_VISIBLE_TOOLS.includes(tool.name))
      .map((tool) => {
        const description = MODEL_VISIBLE_DESCRIPTIONS[tool.name];
        return description === undefined ? tool : { ...tool, description };
      });
  }

  /** MCP 工具失败包装为 ToolExecutionError（server.ts 据此判 503）；本地工具失败原样上抛。
   * bug-00019：origin（调用方 + 发起阶段）必填，由调用点显式指定并透传给 transport 落工具明细。
   * 值域：caller ∈ {model, server}；stage ∈ {l3, fastpath, classify, generation}。
   * 其中 { caller: "model", stage: "generation" }（模型自主调用）在 feat-A011 删除 tool-use 循环后已无产生者，
   * 值域保留作历史口径（当前全部调用点均为服务端预调）。 */
  private async callTransportTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
    origin: ToolCallOrigin
  ): Promise<ToolCallResult> {
    try {
      return await this.transport.callTool(toolName, toolArgs, origin);
    } catch (error) {
      throw new ToolExecutionError(toolName, { cause: error });
    }
  }

  /** sango-novel 快路径：直接调检索工具（不经模型决策）；测试可用 localTools 注入 */
  private async searchNovel(
    query: string,
    origin: ToolCallOrigin
  ): Promise<ToolCallResult> {
    // 返回收缩到 10 条（候选人来自 mcp-server 侧 50 路候选 + 重排），与 INJECT_FRAGMENT_LIMIT 联动
    const args = { source: "sanguo-yanyi", query, limit: 10 };
    const localTool = this.options.localTools?.[SANGO_NOVEL_SEARCH_TOOL];
    return localTool
      ? await localTool(args)
      : await this.callTransportTool(SANGO_NOVEL_SEARCH_TOOL, args, origin);
  }

  /** fengyunsanguo 域快路径：直接调题库工具（不经模型决策）；测试可用 localTools 注入 */
  private async searchFengyunsanguoQuestions(
    query: string,
    origin: ToolCallOrigin
  ): Promise<ToolCallResult> {
    const args = { text: query };
    const localTool = this.options.localTools?.[FENGYUNSANGUO_QUERY_TOOL];
    return localTool
      ? await localTool(args)
      : await this.callTransportTool(FENGYUNSANGUO_QUERY_TOOL, args, origin);
  }

  private invokeModel(
    messages: any[],
    tools: MCPToolDefinition[],
    stage?: LlmStage,
    options?: ModelCallOptions
  ): Promise<ModelResponse> {
    if (this.options.modelCaller) {
      return this.options.modelCaller(messages, tools);
    }
    return this.callModel(messages, tools, stage, options);
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
    // bug-00018 口径：已给单段原文、只归纳一句结论 → 本轮应关闭思考。
    const response = await this.invokeModel(
      [
        { role: "system", content: CITATION_FALLBACK_CONCLUSION_PROMPT },
        { role: "user", content },
      ],
      [],
      "generation",
      { disableThinking: true }
    );
    return response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text!)
      .join("\n")
      .trim();
  }

  /** bug-00032/33/34：低重叠句边界语义复核（独立 stage novel_boundary_check，正常样本不触发）。
   * 输入 = 用户问题 + 结论句 + 指向片段原文；supported → 放行整句，其余（unsupported /
   * 解析失败 / 复核调用异常）→ 裁剪。复核不可用时回落字面门口径（旧确定性裁剪），保险丝不失效；
   * 判定结果经现有 LLM 明细落库（stage=novel_boundary_check，responseSummary 即 verdict）。 */
  private async checkNovelBoundarySupport(
    query: string,
    sentence: string,
    fragmentText: string
  ): Promise<"supported" | "unsupported"> {
    const content = [
      `用户问题：${query}`,
      `模型结论句：${sentence}`,
      `片段原文：${fragmentText}`,
    ].join("\n");
    try {
      // bug-00018 口径：只做二选一判定 → 关闭思考 + temperature 0，保证输出稳定
      const response = await this.invokeModel(
        [
          { role: "system", content: NOVEL_BOUNDARY_CHECK_PROMPT },
          { role: "user", content },
        ],
        [],
        "novel_boundary_check",
        { disableThinking: true, temperature: 0 }
      );
      const text = response.content
        .filter((item) => item.type === "text")
        .map((item) => item.text!)
        .join("\n")
        .trim();
      const verdict = text.toLowerCase();
      // 注意顺序：unsupported 字面包含 supported 子串，必须先判 unsupported
      if (verdict.includes("unsupported")) {
        return "unsupported";
      }
      return verdict.includes("supported") ? "supported" : "unsupported";
    } catch {
      return "unsupported";
    }
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
    // bug-00018：空答案（生成轮 finish_reason=length 且 content 为空）不得经此分支当成功返回，
    // 须按 bug-00018 的空答案兜底口径处置（重试 / 兜底结论 / 报错）。
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
      // bug-00028 单轮方案：复核轮（第二次 LLM 调用）已整体删除（负责人否决：token 与延迟翻倍）。
      // 语义裁决收进生成轮通用指令（SANGO_NOVEL_DOMAIN_PROMPT 第 6~8 条），规则层只留结构门；
      // 本步是第三条结构门「句-片段文本重叠」。
      // bug-00032/33/34（A016 验收三票，根因同源）：重叠门由「字面一票否决」改为「低重叠 →
      // 边界语义复核」——字面 n-gram 分不清「语义支撑的改述结论」与「先验断言」（两类重叠都低），
      // 把正确的改述结论句误裁（c549084b / ca7d9c6a / 275551c3 实证）。重叠 ≥ 阈值正常放行
      // （零额外调用）；重叠 < 阈值的待裁叙述句触发一次轻量 LLM 语义支撑复核（独立 stage
      // novel_boundary_check，正常样本不出现）：supported → 放行整句，unsupported → 裁剪；
      // 全部裁剪无留存 → 拒答「演义中未涉及」+ citations []（拒答口径与缓存规则不变）。
      // 引语句（[Qn]）不受此门约束（沿用服务端渲染）。
      // bug-00037（4d7a408a）：结论句不带指针、指针挂引文句时，结论断言原样逃过本门——现
      // 无指针叙述句也纳入重叠检查（对全部注入片段取最高重叠），低重叠同样走边界语义复核。
      let filtered = cleaned;
      const lowOverlap = findLowOverlapSentences(cleaned, view);
      if (lowOverlap.length > 0) {
        // bug-00039：单请求复核预算=1——逐句复核是串行 LLM 调用
        // （trace ba5bb4ec 实测单次约 1s），低重叠候选只复核 bestOverlap 最高（并列取
        // 数组最先出现）的唯一句；bestFragmentText === null（无片段参考）直接判
        // unsupported、不调 LLM；其余候选句一律直接计入 unsupported 裁剪集合（保守防
        // 无支撑内容放行，预算外不再逐句串行复核）。提示词约束答案「一句结论」，正常路径
        // 根本不触发复核，它只是格式越界时的安全网（拒答口径与 4bea3ab 一致：全部裁剪后
        // 判空 → 拒答，见下方 stripPointerMarkers 判空）。
        // bug-00040：引语片段句（整句内容均为引语）已在 findLowOverlapSentences 中豁免，
        // 不进复核候选、不裁剪、不占复核预算。
        const unsupported: string[] = [];
        let bestSentence = lowOverlap[0];
        for (const sentence of lowOverlap) {
          if (sentence.bestOverlap > bestSentence.bestOverlap) {
            bestSentence = sentence;
          }
        }
        const verdict =
          bestSentence.bestFragmentText === null
            ? "unsupported"
            : await this.checkNovelBoundarySupport(
                query,
                bestSentence.text,
                bestSentence.bestFragmentText
              );
        if (verdict !== "supported") {
          unsupported.push(bestSentence.text);
        }
        for (const sentence of lowOverlap) {
          if (sentence !== bestSentence) {
            unsupported.push(sentence.text);
          }
        }
        if (unsupported.length > 0) {
          filtered = stripAnswerSentences(cleaned, new Set(unsupported));
        }
      }
      // bug-00038：拒答判定按「去指针后的正文」——全部裁剪无留存、或只剩裸 [片段N]/[Qn]
      // 引用行（无正文）都属于无正文可答 → 拒答「演义中未涉及」+ citations []，避免渲染空正文+脚注。
      if (!stripPointerMarkers(filtered).trim()) {
        return {
          data: { answer: NOVEL_NO_HIT_ANSWER, citations: [] },
          citedChunkIds: new Set(),
        };
      }
      return {
        data: renderAnswerWithCitations(filtered, view),
        citedChunkIds: this.computeCitedChunkIds(
          filtered,
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
   * 路由判定（零 LLM）：L1 前端标签 → L2 本地关键词硬匹配（feat-A011 天气关键词分支已删除）。
   * 返回 "auto" 表示前两层未命中，交由 L3 题库高置信识别（调用方注入）与轻量分类轮处理。
   */
  resolveRoute(query: string, domain?: string): RouteDecision {
    if (domain && DOMAIN_ROUTES[domain]) {
      return { route: DOMAIN_ROUTES[domain], source: "label" };
    }
    const lowered = query.toLowerCase();
    const hit = (keywords: string[]) =>
      keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
    if (hit(FENGYUNSANGUO_KEYWORDS)) {
      return { route: "fengyunsanguo", source: "keyword" };
    }
    if (hit(NOVEL_KEYWORDS)) {
      return { route: "sango-novel", source: "keyword" };
    }
    return { route: "auto", source: null };
  }

  /** bug-00019：origin 必填——域内快路径预调均由服务端发起，发起阶段由调用点显式指定（不做推断）。 */
  private async resolveUserContent(
    query: string,
    domain: string | undefined,
    origin: ToolCallOrigin,
    tracking?: NovelTracking
  ): Promise<{
    result: string;
    novelView?: InjectionView;
    novelSearched?: boolean;
  }> {
    if (domain && DOMAIN_ROUTES[domain]) {
      if (domain === DOMAIN_ROUTES["sango-novel"]) {
        const result = await this.searchNovel(query, origin);
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
        const result = await this.searchFengyunsanguoQuestions(query, origin);
        return { result: this.collectTexts(result).join("\n") };
      }
    }
    return { result: '' };
  }

  /**
   * 处理用户提问并回答（feat-A006 结构化）：同样走三层路由判定与域内快路径
   * （L1 标签 → L2 关键词 → L3 题库高置信识别，L3 仅 auto 时生效），
   * feat-A011：L3 未命中 → 无 tools 轻量分类出编号，服务端按编号预调工具并注入；
   * 生成轮消息固定 [system: 域提示] + [user: 用户问题] + [system: 注入片段]（99 无注入），
   * 一律不携带工具定义；工具自主决策（tool-use 循环）路径已删除。
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
    // feat-A013：本次请求的缓存判定结果（sango-novel 域 lookup 产出，收尾交给 record 内部判定写缓存）
    let cacheLookup: CacheLookupResult | null = null;

    // 路由判定（L1 前端标签 → L2 关键词）：命中专用域直接走域内快路径（预调 + 注入），不经分类轮
    // feat-A012 §2.2：resolveRoute 返回 route + source（label / keyword / auto=null），
    // 后续按 L3 / 分类轮组合出完整 routeSource（vector / classify / free）
    const decision = this.resolveRoute(query, domain);
    let routeSource: RouteSource | null = decision.source;
    const lockedRoute = Object.values(DOMAIN_ROUTES).includes(decision.route)
      ? decision.route
      : null;
    let systemPrompt = this.systemPrompt;
    if (lockedRoute) {
      // feat-A013：sango-novel 域路由判定完成、检索预调之前查语义缓存（命中 = 0 次 LLM + 0 次检索）
      if (lockedRoute === DOMAIN_ROUTES['sango-novel']) {
        cacheLookup = await this.novelCacheLookup(query, routeSource);
        if (cacheLookup?.hit === true) {
          return cacheLookup.data;
        }
      }
      const result = await this.resolveUserContent(
        query,
        lockedRoute,
        // bug-00019：L1 前端标签 / L2 关键词锁域后的域内快路径预调 → fastpath
        { caller: "server", stage: "fastpath" },
        tracking
      );
      resolvedContent = result.result;
      novelView = result.novelView || null;
      novelSearched = result.novelSearched ?? false;
      systemPrompt = DOMAIN_PROMPTS[lockedRoute];
    } else {
      // L3 向量匹配注入点：只做风云三国高置信正向识别，命中 fengyunsanguo 后走题库快路径；
      // 仅 auto（L1/L2 未锁定域）时生效——domain 硬锁（fengyunsanguo/sango-novel）不得被 L3 覆盖
      const fengyunsanguoHit =
        await this.options.fengyunsanguoVectorMatcher?.(query);
      if (fengyunsanguoHit === true || fengyunsanguoHit === "fengyunsanguo") {
        routeSource = "vector";
        const { result } = await this.resolveUserContent(
          query,
          DOMAIN_ROUTES.fengyunsanguo,
          // bug-00019：L3 命中后的题库预调 → l3
          { caller: "server", stage: "l3" }
        );
        resolvedContent = result;
        systemPrompt = DOMAIN_PROMPTS.fengyunsanguo;
      } else {
        // 轻量分类轮（§2.1）：请求体无 tools，仅 [system: 分类提示] + [user: 用户问题]，
        // 模型只输出编号；服务端按编号预调工具并注入（生成轮不带工具定义）
        // bug-00018 口径：任务已确定（只判域）+ 输出已锁成编号 → 本轮应关闭思考。
        const classifyResponse = await this.invokeModel(
          [
            { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          [],
          "classify",
          { disableThinking: true }
        );
        const routeId = parseClassifyRouteId(classifyResponse.content);
        // feat-A012 §2.2：分类轮解析编号 1/2 → classify；99 / 无法解析 / 非 1/2/99 → free
        routeSource =
          routeId === CLASSIFY_ROUTE_IDS.sangoNovel ||
          routeId === CLASSIFY_ROUTE_IDS.fengyunsanguo
            ? "classify"
            : "free";
        if (routeId === CLASSIFY_ROUTE_IDS.sangoNovel) {
          // feat-A013：分类轮判定 sango-novel 完成、检索预调之前查语义缓存（route_source 已定为 classify）
          cacheLookup = await this.novelCacheLookup(query, routeSource);
          if (cacheLookup?.hit === true) {
            return cacheLookup.data;
          }
          const result = await this.resolveUserContent(
            query,
            DOMAIN_ROUTES["sango-novel"],
            // bug-00019：分类轮判定 1（原著）后的预调 → classify
            { caller: "server", stage: "classify" },
            tracking
          );
          resolvedContent = result.result;
          novelView = result.novelView || null;
          novelSearched = result.novelSearched ?? false;
          systemPrompt = DOMAIN_PROMPTS["sango-novel"];
        } else if (routeId === CLASSIFY_ROUTE_IDS.fengyunsanguo) {
          const { result } = await this.resolveUserContent(
            query,
            DOMAIN_ROUTES.fengyunsanguo,
            // bug-00019：分类轮判定 2（题库）后的预调 → classify
            { caller: "server", stage: "classify" }
          );
          resolvedContent = result;
          systemPrompt = DOMAIN_PROMPTS.fengyunsanguo;
        }
        // 99 / 无法解析 / 非 1/2/99：自由对话兜底，无注入，不重试（systemPrompt 保持默认）
      }
    }

    // 生成轮消息固定排布（缓存友好）：静态前缀（system 域提示 + user 问题）逐字节稳定，注入片段恒在末尾
    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];
    if (resolvedContent) {
      messages.push({ role: "system", content: resolvedContent });
    }
    // feat-A012 §2.2：路由判定完成（LLM 调用前）一次性回填 route_source；
    // 旁路静默（失败不影响主流程）；fallback 轮（引用校验兜底结论轮）不覆盖
    const routeTraceId = getTraceId();
    if (
      routeSource &&
      typeof routeTraceId === "string" &&
      routeTraceId !== ""
    ) {
      reportRouteSource(routeTraceId, routeSource);
    }
    // bug-00018 口径：有注入（域锁定快路径 / auto 分到 1、2）→ 任务已确定、输出已约束 → 关闭思考；
    // 仅「无注入的自由模式 99」保留思考（模型需自行作答）。
    const currentResponse = await this.invokeModel(
      messages,
      [],
      "generation",
      resolvedContent ? { disableThinking: true } : undefined
    );

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
    // feat-A013：最终 ChatData 就绪后统一调 record（写缓存内部判定，§1.4；旁路静默）
    this.recordNovelCache(query, cacheLookup, data);
    return data;
  }

  /** feat-A013：sango-novel 域路由判定完成后、检索预调前查询语义缓存。
   * 命中 → 回填 route_source（§4.1：路由判定在缓存检查之前，命中请求也必须有来源）并返回缓存答案深拷贝；
   * 未命中 / 旁路（开关关闭、embedding 降级）→ 返回判定结果（调用点保存，供收尾 record 内部判定写缓存）。 */
  private async novelCacheLookup(
    query: string,
    routeSource: RouteSource | null
  ): Promise<CacheLookupResult | null> {
    const cacheManager = this.options.cacheManager;
    if (!cacheManager) {
      return null;
    }
    const traceIdValue = getTraceId() ?? '';
    const lookup = await cacheManager.lookup(query, traceIdValue);
    if (lookup?.hit === true) {
      if (routeSource && traceIdValue !== '') {
        try {
          reportRouteSource(traceIdValue, routeSource);
        } catch {
          // 旁路：埋点失败静默，绝不影响缓存命中返回
        }
      }
    }
    return lookup;
  }

  /** feat-A013：最终 ChatData 就绪后调用 record（§1.4 写缓存内部判定；旁路静默失败不影响响应） */
  private recordNovelCache(
    query: string,
    lookup: CacheLookupResult | null,
    data: ChatData
  ): void {
    const cacheManager = this.options.cacheManager;
    if (!cacheManager) {
      return;
    }
    const traceIdValue = getTraceId() ?? '';
    try {
      cacheManager.record(query, traceIdValue, lookup, data);
    } catch {
      // 旁路：缓存写失败静默，绝不影响 /api/chat 主流程与响应
    }
  }

  /** feat-A009：注入视图实际纳入的候选 chunkId（feat-A011 起全部为快路径确定性注入，无 tool-use 路径） */
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
