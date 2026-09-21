// feat-A009 编排侧诊断回填辅助（story-A009-03 编排部分）
// 职责：从检索工具出参提取诊断与行号、按「片段 → 候选」映射回填 injected/cited、
// 按 (trace_id, seq) 旁路落库。不依赖文本比对——映射走工具出参条目 id（chunkId）与注入视图编号。
import {
  INJECT_FRAGMENT_LIMIT,
  INJECT_HEAD_GUARANTEE,
  INJECT_TOTAL_BUDGET,
  INJECT_TAIL_FALLBACK_ENABLED,
  type RecallFragment,
} from "./citation.js";
import { appendRetrievalLog } from "./storage/logs.js";
import type { ToolCallResult } from "./types.js";

/** 从检索工具出参提取诊断载荷与工具明细行号（transport 已透传 retrievalSeq） */
export interface RetrievalMeta {
  diagnostics: Record<string, unknown> | null;
  seq: number | null;
}

export function extractRetrievalMeta(result: ToolCallResult): RetrievalMeta {
  const meta = result._meta;
  if (
    !meta ||
    typeof meta.diagnostics !== "object" ||
    meta.diagnostics === null
  ) {
    return { diagnostics: null, seq: null };
  }
  const seq = typeof meta.retrievalSeq === "number" ? meta.retrievalSeq : null;
  return {
    diagnostics: meta.diagnostics as Record<string, unknown>,
    seq,
  };
}

/** 解析工具出参条目取 chunkId：与 citation.toRecallFragments 同遍历序、同跳过规则
 * （空文本条目跳过），故返回数组与 collectTexts→toRecallFragments 的片段一一对齐。 */
export function extractEntryChunkIds(
  result: ToolCallResult
): Array<string | null> {
  const chunkIds: Array<string | null> = [];
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") {
      continue;
    }
    const text = item.text.trim();
    if (!text || !text.startsWith("[")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    for (const entry of parsed) {
      if (
        !entry ||
        typeof (entry as { text?: unknown }).text !== "string" ||
        !(entry as { text: string }).text.trim()
      ) {
        continue;
      }
      const id = (entry as { id?: unknown }).id;
      chunkIds.push(typeof id === "string" && id.trim() ? id : null);
    }
  }
  return chunkIds;
}

/** 复刻 citation.buildInjectionView 的注入选取策略（前 INJECT_HEAD_GUARANTEE 段整段保底
 * + 第 6+ 段预算内整段纳入），返回被选中片段在原数组中的下标；与 buildInjectionView 的
 * 「片段N」编号（picked 内 1 基位置）一致。 */
export function computePickedIndices(fragments: RecallFragment[]): number[] {
  const limited = fragments.slice(0, INJECT_FRAGMENT_LIMIT);
  const picked: number[] = [];
  const head = Math.min(limited.length, INJECT_HEAD_GUARANTEE);
  for (let i = 0; i < head; i++) {
    picked.push(i);
  }
  if (INJECT_TAIL_FALLBACK_ENABLED) {
    let used = picked.reduce((sum, index) => sum + limited[index].text.length, 0);
    for (let i = INJECT_HEAD_GUARANTEE; i < limited.length; i++) {
      if (used + limited[i].text.length > INJECT_TOTAL_BUDGET) {
        break;
      }
      picked.push(i);
      used += limited[i].text.length;
    }
  }
  return picked;
}

/** 回填 injected/cited 到诊断：funnel.injected/cited = candidates 内被标记条数（去重 chunk 计数）；
 * candidates[].injected/cited = 逐条布尔（同一映射）。不做降级回填（§9-5）。 */
export function fillDiagnostics(
  diagnostics: Record<string, unknown>,
  injectedChunkIds: ReadonlySet<string>,
  citedChunkIds: ReadonlySet<string>
): void {
  const candidates = Array.isArray(diagnostics.candidates)
    ? (diagnostics.candidates as unknown[])
    : [];
  let injectedCount = 0;
  let citedCount = 0;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const chunkId = record.chunkId;
    const injected =
      typeof chunkId === "string" && injectedChunkIds.has(chunkId);
    const cited = typeof chunkId === "string" && citedChunkIds.has(chunkId);
    record.injected = injected;
    record.cited = cited;
    if (injected) {
      injectedCount++;
    }
    if (cited) {
      citedCount++;
    }
  }
  const funnel = diagnostics.funnel;
  if (funnel && typeof funnel === "object") {
    (funnel as Record<string, unknown>).injected = injectedCount;
    (funnel as Record<string, unknown>).cited = citedCount;
  }
}

export type RetrievalPersister = (
  traceId: string,
  seq: number,
  diagnostics: unknown
) => void;

/** 旁路落库（§3.3/§6）：回填失败 / 落库失败都不得影响 /api/chat 主流程与响应，仅告警。 */
export function persistRetrievalDiagnostics(
  traceId: string | null,
  seq: number | null,
  diagnostics: Record<string, unknown>,
  persister: RetrievalPersister = appendRetrievalLog
): void {
  if (!traceId || seq === null) {
    return;
  }
  try {
    persister(traceId, seq, diagnostics);
  } catch (error) {
    // 旁路：诊断落库失败静默，不影响响应；查询接口该工具 diagnostics 为 null
    console.error(
      "[recall-diagnostics] persist retrieval diagnostics failed (bypass):",
      error
    );
  }
}
