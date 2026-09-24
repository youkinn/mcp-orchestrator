// 演义域回答-片段支撑复核轮（bug-00028 长期机制，定稿设计 docs/novel-answer-support-check.md）：
// 语义裁决移交 LLM 复核轮（编排 stage=novel_support_check，复用生成轮同一 LLM 调用通道），
// 规则层只保留结构门（指针合法 / 人物⊆召回，见 citation.ts），词表型语义信号（死亡 / 数值同值 /
// 表字值）已删除——本模块只定义判定契约（仅 JSON）、解析与裁剪动作，不含任何语义规则。
import { extractCitePointers } from "./citation.js";

/** 复核轮 stage（llm_call_logs.stage 值域；与生成轮同一条模型 / 配置 / 日志通道） */
export const SUPPORT_CHECK_STAGE = "novel_support_check";

/** 单条引用支撑判定值 */
export type SupportVerdict = "supported" | "unsupported" | "uncertain";

/** 复核轮输出契约（仅 JSON）：逐条引用判定 + 整体判定 */
export interface SupportCheckCitation {
  pointer: string;
  support: SupportVerdict;
}

export interface SupportCheckResult {
  citations: SupportCheckCitation[];
  overall: SupportVerdict;
}

const SUPPORT_VALUES: readonly SupportVerdict[] = [
  "supported",
  "unsupported",
  "uncertain",
];

/** 复核轮 system 提示词（短 JSON 输出；语义判据，不搞字面规则） */
export const SUPPORT_CHECK_SYSTEM_PROMPT = [
  "你是《三国演义》原著问答的引用支撑校验器。",
  "系统给你三样内容：",
  "1) 生成轮注入的原文片段（带 [片段N] / ⟨Qn⟩ 标记，与生成轮所见完全一致）；",
  "2) 模型答案（含 [Qn] / [片段N] 引用指针）；",
  "3) 引用指针清单。",
  "逐条判定每条指针指向的片段是否在语义上支撑答案的结论与关键断言：",
  "- supported：片段内容支撑该断言（允许中阿数字等价、别名称谓等语义等价形式，不要求字面重合）；",
  "- unsupported：断言了片段中没有的内容（含凭先验 / 史实补全），或片段与结论无关；",
  "- uncertain：无法确定。",
  "overall 判定答案整体是否被注入片段集合支撑：有支撑引用且核心断言成立 → supported；",
  "核心断言无任何片段支撑 → unsupported；无法确定 → uncertain。",
  "只输出一个 JSON 对象，不要任何其他文字、解释或 Markdown 围栏，格式如下：",
  '{"citations":[{"pointer":"片段1","support":"supported"}],"overall":"supported"}',
].join("\n");

/** 解析复核轮输出：非 JSON / 结构不符（字段缺失、取值非法）→ null（调用方重试 1 次后按 unsupported 拒答）。
 * 容错：允许 ```json 围栏与首尾空白；其余一律严格。 */
export function parseSupportCheckResult(text: string): SupportCheckResult | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  let jsonText = trimmed;
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fence) {
    jsonText = fence[1].trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const overall = obj.overall;
  if (!SUPPORT_VALUES.includes(overall as SupportVerdict)) {
    return null;
  }
  if (!Array.isArray(obj.citations)) {
    return null;
  }
  const citations: SupportCheckCitation[] = [];
  for (const item of obj.citations) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }
    const pointer = (item as Record<string, unknown>).pointer;
    const support = (item as Record<string, unknown>).support;
    if (typeof pointer !== "string" || pointer === "") {
      return null;
    }
    if (!SUPPORT_VALUES.includes(support as SupportVerdict)) {
      return null;
    }
    citations.push({ pointer, support: support as SupportVerdict });
  }
  return { citations, overall: overall as SupportVerdict };
}

/** 按复核结果裁剪答案：未判定为 supported 的指针（unsupported / uncertain / 复核轮未覆盖）全部摘除，
 * 保留 supported 指针（含答案内重复出现）；返回裁剪后答案与保留指针（调用方按保留为空 → 拒答）。 */
export function stripUnsupportedPointers(
  answer: string,
  verdicts: SupportCheckCitation[]
): { answer: string; kept: string[] } {
  const supported = new Set(
    verdicts
      .filter((verdict) => verdict.support === "supported")
      .map((verdict) => verdict.pointer)
  );
  let filtered = answer;
  const kept: string[] = [];
  for (const pointer of extractCitePointers(answer)) {
    if (supported.has(pointer)) {
      if (!kept.includes(pointer)) {
        kept.push(pointer);
      }
      continue;
    }
    filtered = filtered.replace(
      new RegExp(`\\[${escapeRegExp(pointer)}\\]`, "g"),
      ""
    );
  }
  return { answer: filtered, kept };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
