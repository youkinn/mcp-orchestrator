// feat-A004：《三国演义》原著检索的引用硬校验模块
// 校验规则：答案断言人物集合（ID 级）⊆ 召回原文人物集合（ID 级），不成立走兜底。
// 人物 ID 化：本地别名表（封闭集合）扫描；无 ID 的次要人物退化为字符串包含校验。
import { readFileSync } from "node:fs";

export const SANGO_NOVEL_SEARCH_TOOL = "sango_novel_search";

/** 检索无命中的固定话术（prompt 能力三第 4 条） */
export const NOVEL_NO_HIT_ANSWER = "演义中未涉及";

/** 老陈 alias.json 的绝对路径，SANGO_ALIAS_PATH 的默认值；文件产出后自动生效 */
export const DEFAULT_ALIAS_PATH = "D:\\workplace\\mcp-server\\sango\\data\\alias.json";

/** 本地 stub 别名表（同一契约：别名 -> 规范 ID，P001 起按规范名去重，关羽=P002）。
 * 老陈 alias.json 尚未产出时用于测试与运行；文件到位后以 SANGO_ALIAS_PATH 指向文件为准。 */
export const STUB_ALIASES: Record<string, string> = {
  曹操: "P001",
  孟德: "P001",
  曹孟德: "P001",
  关羽: "P002",
  云长: "P002",
  关云长: "P002",
  美髯公: "P002",
  刘备: "P003",
  玄德: "P003",
  刘玄德: "P003",
  张飞: "P004",
  翼德: "P004",
  张翼德: "P004",
  诸葛亮: "P005",
  孔明: "P005",
  诸葛孔明: "P005",
  卧龙: "P005",
  赵云: "P006",
  子龙: "P006",
  赵子龙: "P006",
  吕布: "P007",
  奉先: "P007",
  吕奉先: "P007",
  貂蝉: "P008",
  董卓: "P009",
  仲颖: "P009",
  袁绍: "P010",
  本初: "P010",
  孙权: "P011",
  仲谋: "P011",
  周瑜: "P012",
  公瑾: "P012",
  华雄: "P013",
  孙坚: "P014",
  文台: "P014",
  袁术: "P015",
  公路: "P015",
  夏侯惇: "P016",
  元让: "P016",
  夏侯渊: "P017",
  妙才: "P017",
  张辽: "P018",
  文远: "P018",
  司马懿: "P019",
  仲达: "P019",
  黄忠: "P020",
  汉升: "P020",
  马超: "P021",
  孟起: "P021",
  姜维: "P022",
  伯约: "P022",
  庞统: "P023",
  士元: "P023",
  刘禅: "P024",
  阿斗: "P024",
};

/** 断言/召回中出现的一个人物：name 为原始名字，id 为规范 ID（可无，走字符串退化） */
export interface PersonMention {
  name: string;
  id?: string;
}

/** 召回原文片段：text 为原文（含出处信息由工具带回），source 为来源标识 */
export interface RecallFragment {
  text: string;
  source: string;
}


export interface CitationCheckResult {
  ok: boolean;
  unverified: PersonMention[];
}

/** 加载别名表：SANGO_ALIAS_PATH（默认指向老陈 alias.json 绝对路径）→ 文件缺失/损坏时回落本地 stub */
export function loadAliasTable(path?: string): Map<string, string> {
  const resolved = path ?? process.env.SANGO_ALIAS_PATH ?? DEFAULT_ALIAS_PATH;
  try {
    const raw = readFileSync(resolved, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const table = new Map<string, string>();
    for (const [alias, id] of Object.entries(data)) {
      if (alias.trim() && typeof id === "string") {
        table.set(alias.trim(), id);
      }
    }
    return table;
  } catch {
    return new Map(Object.entries(STUB_ALIASES));
  }
}

/** 召回原文侧同样 ID 化：扫描文本中出现的别名 → 规范 ID 集合 */
export function scanRecallPersonIds(
  recallText: string,
  aliasTable: Map<string, string>
): Set<string> {
  const ids = new Set<string>();
  for (const [alias, id] of aliasTable) {
    if (recallText.includes(alias)) {
      ids.add(id);
    }
  }
  return ids;
}

/** 集合包含判定：断言人物集合（ID 级）⊆ 召回原文人物集合（ID 级）。
 * 无 ID 的次要人物退化为字符串包含校验（名字出现在召回原文即通过），避免误杀小配角。 */
export function verifyCitation(
  asserted: PersonMention[],
  recallText: string,
  recallPersonIds: Set<string>
): CitationCheckResult {
  const unverified: PersonMention[] = [];
  for (const mention of asserted) {
    if (mention.id) {
      if (!recallPersonIds.has(mention.id)) {
        unverified.push(mention);
      }
    } else if (!mention.name || !recallText.includes(mention.name)) {
      unverified.push(mention);
    }
  }
  return { ok: unverified.length === 0, unverified };
}

/** 从白话问句提取定位关键词（2~4 字连续子串，长度降序），用于在原文中定位检索词窗口 */
function extractQueryKeys(query: string): string[] {
  const cleaned = query.replace(/[^\u4e00-\u9fa5]/g, "");
  const keys = new Set<string>();
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= cleaned.length; i++) {
      keys.add(cleaned.slice(i, i + len));
    }
  }
  return [...keys];
}

/** 窗口单侧半径（字）：以锚点前后各取该长度 */
const WINDOW_RADIUS = 60;
/** 注入窗口总长上限（字）：多锚点并集不超过该值，避免注入随锚点数变长失控 */
const WINDOW_BUDGET = 280;
/** 未命中任何关键词时的兜底长度（字） */
const WINDOW_FALLBACK = 120;

/** 一个 query key 在段内的全部出现位置 */
interface KeyAnchor {
  key: string;
  occurrences: number[];
}

/** 段内窗口区间 [start, end) */
type WindowSpan = [number, number];

/**
 * 稀有度代理排序（编排侧无语料 df，只能看段内证据）：
 *   1. key 长度降序 —— 长 key 信息量大（「辕门射戟」优于「吕布」）；
 *   2. 段内出现次数升序 —— 同一段内出现越多，越像该段的背景主语（如主案例段内
 *      「孙权」2 次、「荆州」11 次），而非答案句的标志词；
 *   3. 首次出现位置升序 —— 仅作稳定排序兜底。
 * 旧逻辑取「最后一个 key 的最后一次出现」，长 query 里恰好把窗口钉在背景主语上，
 * 答案句被整句切掉（主案例窗口 [277,399)，答案句在 455）。
 */
function rankKeyAnchors(anchors: KeyAnchor[]): KeyAnchor[] {
  return [...anchors].sort(
    (a, b) =>
      b.key.length - a.key.length ||
      a.occurrences.length - b.occurrences.length ||
      a.occurrences[0] - b.occurrences[0]
  );
}

/** 把同一 key 相邻/重叠的窗口合并，避免同一处出现被拆成多段 */
function mergeSpans(spans: WindowSpan[]): WindowSpan[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: WindowSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) {
      last[1] = Math.max(last[1], span[1]);
    } else {
      merged.push([span[0], span[1]]);
    }
  }
  return merged;
}

/** 合并后区间总长（字） */
function totalSpanLength(spans: WindowSpan[]): number {
  return spans.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/** 按稀有度顺序取窗口并集，总长不超过 budget；返回按位置排序的区间。
 * 预算按「合并后并集长度」计算，重叠部分只算一次，避免重复锚点白吃预算。 */
function selectWindowSpans(
  body: string,
  anchors: KeyAnchor[],
  budget = WINDOW_BUDGET,
  radius = WINDOW_RADIUS
): WindowSpan[] {
  let picked: WindowSpan[] = [];
  for (const anchor of rankKeyAnchors(anchors)) {
    const spans = mergeSpans(
      anchor.occurrences.map(
        (at): WindowSpan => [
          Math.max(0, at - radius),
          Math.min(body.length, at + anchor.key.length + radius),
        ]
      )
    );
    for (const span of spans) {
      const candidate = mergeSpans([...picked, span]);
      if (totalSpanLength(candidate) > budget) {
        continue;
      }
      picked = candidate;
    }
  }
  if (picked.length === 0 && anchors.length > 0) {
    // 单个窗口就超预算（超长段 + 大 key）：至少保住最稀有 key 处的窗口
    const first = anchors[0].occurrences[0];
    const start = Math.max(0, first - radius);
    picked = [[start, Math.min(body.length, start + budget)]];
  }
  return picked;
}

/** 截取「出处头 + 最稀有检索词附近窗口」：按稀有度锚定 query 关键词，取并集且总长受限；
 * 找不到关键词时取正文开头 120 字。注入与兜底共用，避免整段全文刷屏。 */
export function trimFragmentToWindow(
  fragment: RecallFragment,
  query: string
): RecallFragment {
  const m = fragment.text.match(/^(\【出处\】[^\n]*\n?)([\s\S]*)$/);
  const header = m ? m[1] : "";
  const body = m ? m[2] : fragment.text;
  const anchors: KeyAnchor[] = [];
  for (const key of extractQueryKeys(query)) {
    const occurrences: number[] = [];
    let cursor = body.indexOf(key);
    while (cursor >= 0) {
      occurrences.push(cursor);
      cursor = body.indexOf(key, cursor + key.length);
    }
    if (occurrences.length > 0) {
      anchors.push({ key, occurrences });
    }
  }
  if (anchors.length === 0) {
    return {
      text: header + body.slice(0, WINDOW_FALLBACK),
      source: fragment.source,
    };
  }
  const text = selectWindowSpans(body, anchors)
    .map(([start, end]) => body.slice(start, end))
    .join("……");
  return { text: header + text, source: fragment.source };
}

/** 兜底输出：不做归纳生成，只输出最符合的一段（检索词附近窗口）+ 出处 + 一句结论 */
export function buildFallback(
  fragments: RecallFragment[],
  conclusion: string,
  query = ""
): string {
  const conclusionLine = conclusion.startsWith("按原文")
    ? conclusion
    : `按原文，${conclusion}`;
  if (fragments.length === 0) {
    return conclusionLine;
  }
  const top = trimFragmentToWindow(fragments[0], query);
  return [
    "【原文片段】",
    `${top.text}\n（出处：${top.source}）`,
    "",
    conclusionLine,
  ].join("\n");
}
