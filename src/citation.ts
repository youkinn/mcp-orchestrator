// feat-A004：《三国演义》原著检索的引用硬校验模块
// 校验规则：答案断言人物集合（ID 级）⊆ 召回原文人物集合（ID 级），不成立走兜底。
// 人物 ID 化：本地别名表（封闭集合）扫描；无 ID 的次要人物退化为字符串包含校验。
// 引用与出处改服务端渲染（spec §6.3）：模型只输出指针 `[Qn]`，引语原文与出处由本模块按
// quotes[] / chapter / title 字段渲染；注入视图只给纯原文 + 服务端编号（`[片段N]` / `⟨Qn⟩`），
// 不带回目、段号、分数。
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

/** spec §5 语料 schema v2：一条引语（qid 只在 chunk 内唯一，注入期由服务端重编号为全局序号） */
export interface RecallQuote {
  qid: string;
  /** 引语纯原文内容（不含成对引号） */
  text: string;
  /** 引语内容在 chunk.text 中的起始下标（成对引号位于 offset-1 与 offset+text.length） */
  offset: number;
  speaker?: string;
}

/** spec §5 检索工具出参条目（C4 定稿：裸数组，字段逐字为 id/text/chapter/title/type/segFrom/segTo/quoteBalanced/quotes） */
export interface RecallEntry {
  id?: string;
  text: string;
  /** 回号；逐条携带（单次召回的多条可来自不同回，出处只能逐条渲染） */
  chapter?: number;
  /** 回目；逐条携带 */
  title?: string;
  type?: string;
  segFrom?: number;
  segTo?: number;
  quoteBalanced?: boolean;
  quotes?: RecallQuote[];
}

/** 召回原文片段：text 为纯原文（不含出处 / 段号 / 分数），出处由 chapter / title 字段渲染 */
export interface RecallFragment {
  text: string;
  source: string;
  chapter?: number;
  title?: string;
  /** 该片段携带的引语（qid 为 chunk 内序号，渲染前由 buildInjectionView 重编号） */
  quotes?: RecallQuote[];
}

/** 注入视图的片段条数上限：与检索返回条数联动（返回收缩到 10 条即全部注入）。
 * 放宽后第 4~10 名对模型可见——张飞题证据段排 #5，旧值 3 把它挡在模型视野外（bug-00009 同类）。 */
export const INJECT_FRAGMENT_LIMIT = 10;

/** 长引语安全网阈值（字）：模型输出里超过该长度的「…」视为违规抄写 */
export const MAX_MODEL_QUOTE_LENGTH = 30;

/** 引语渲染所需的元数据：逐字可信的原文 + 出处字段 */
export interface RenderedQuote {
  text: string;
  chapter?: number;
  title?: string;
  source: string;
}

/** 注入视图：注入给模型的纯原文（带 `[片段N]` / `⟨Qn⟩` 标记）+ 全局 qid → 引语元数据 */
export interface InjectionView {
  text: string;
  quotes: Map<string, RenderedQuote>;
  /** 全局片段编号 → 该片段原文窗口（叙述句答案的引用目标：`[片段N]` 指针渲染用，bug-00009） */
  fragments: Map<string, RenderedQuote>;
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
/** 注入视图全问总预算（字）：10 段召回共享，避免 limit/注入段数放宽后 token 随段数线性膨胀 */
const INJECT_TOTAL_BUDGET = 1600;
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

/** 按稀有度锚定检索词取窗口：取并集且总长受限，找不到关键词时取开头 120 字。
 * budget 可按调用方预算传入（注入视图多段共享总预算，兜底单段用默认值）。 */
function trimTextToWindow(
  text: string,
  query: string,
  budget = WINDOW_BUDGET
): string {
  const anchors: KeyAnchor[] = [];
  for (const key of extractQueryKeys(query)) {
    const occurrences: number[] = [];
    let cursor = text.indexOf(key);
    while (cursor >= 0) {
      occurrences.push(cursor);
      cursor = text.indexOf(key, cursor + key.length);
    }
    if (occurrences.length > 0) {
      anchors.push({ key, occurrences });
    }
  }
  if (anchors.length === 0) {
    return text.slice(0, WINDOW_FALLBACK);
  }
  return selectWindowSpans(text, anchors, budget)
    .map(([start, end]) => text.slice(start, end))
    .join("……");
}

/** 工具出参文本 → 结构化条目（C4 定稿：出参只有裸 JSON 数组一种形态；非数组视为无出参） */
function parseRecallEntries(text: string): RecallEntry[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) {
    return [];
  }
  try {
    const data = JSON.parse(trimmed) as unknown;
    return Array.isArray(data) ? (data as RecallEntry[]) : [];
  } catch {
    return [];
  }
}

/** 工具出参文本 → 召回片段：解析裸数组条目，元数据（chapter / title）逐条携带，正文只留纯原文 */
export function toRecallFragments(
  texts: string[],
  source: string
): RecallFragment[] {
  const fragments: RecallFragment[] = [];
  for (const text of texts) {
    for (const entry of parseRecallEntries(text)) {
      if (!entry || typeof entry.text !== "string" || !entry.text.trim()) {
        continue;
      }
      fragments.push({
        text: entry.text,
        source,
        chapter: typeof entry.chapter === "number" ? entry.chapter : undefined,
        title:
          typeof entry.title === "string" && entry.title.trim()
            ? entry.title.trim()
            : undefined,
        quotes: Array.isArray(entry.quotes)
          ? entry.quotes.filter(
              (quote) => quote && typeof quote.text === "string" && quote.text
            )
          : undefined,
      });
    }
  }
  return fragments;
}

/** 在窗口文本内标出引语：`⟨Qn⟩` 插在开引号前，qid 从 start 起按可见引语连续编号。
 * 只认完整可见的 `“……“XXX”……”` 引语——被窗口切半的引语模型本就看不清，不允许引用。
 * 先裁窗口再编号 ⇒ 可见编号天然连续，不会出现「Q1 后直接 Q3」的空洞引模型误用。 */
function markQuotesInWindow(
  text: string,
  fragment: RecallFragment,
  start: number
): { marked: string; assigned: Array<{ qid: string; quote: RecallQuote }>; next: number } {
  const located: Array<{ at: number; quote: RecallQuote }> = [];
  for (const quote of fragment.quotes ?? []) {
    if (!quote || !quote.text) {
      continue;
    }
    const at = text.indexOf(`“${quote.text}”`);
    if (at >= 0) {
      located.push({ at, quote });
    }
  }
  located.sort((a, b) => a.at - b.at);
  const assigned = located.map((item, index) => ({
    qid: `Q${start + index}`,
    quote: item.quote,
  }));
  let marked = text;
  for (let index = assigned.length - 1; index >= 0; index--) {
    marked =
      marked.slice(0, located[index].at) +
      `⟨${assigned[index].qid}⟩` +
      marked.slice(located[index].at);
  }
  return { marked, assigned, next: start + assigned.length };
}

/** 窗口保底一条引语：检索词窗口把片段引语全部裁掉时，把片段首条引语原文并入窗口尾部，
 * 否则该片段一个可用指针都没有（华雄题证据段引语在锚点窗口之前即此场景，见 bug-00009）。 */
function mergeFirstQuoteIntoWindow(
  windowText: string,
  fragment: RecallFragment
): string {
  const first = (fragment.quotes ?? []).find((quote) => quote && quote.text);
  if (!first) {
    return windowText;
  }
  const quoteText = `“${first.text}”`;
  if (windowText.includes(quoteText)) {
    return windowText;
  }
  return fragment.text.includes(quoteText)
    ? `${windowText}……${quoteText}`
    : windowText;
}

/**
 * 注入视图（spec §6.3）：纯原文 + 服务端编号。
 * 片段带 `[片段N]`，片段内引语带 `⟨Qn⟩`；**不带回目、段号、分数**，模型无从抄写出处。
 * 流程：先按检索词裁窗口，再对窗口内可见引语连续编号（无空洞）；窗口裁掉全部引语时并入
 * 首条引语保底，保证每个片段至少有一个可用指针。
 */
export function buildInjectionView(
  fragments: RecallFragment[],
  query = ""
): InjectionView {
  const quotes = new Map<string, RenderedQuote>();
  const targets = new Map<string, RenderedQuote>();
  const parts: string[] = [];
  let next = 1;
  const injected = fragments.slice(0, INJECT_FRAGMENT_LIMIT);
  // 多段共享总预算：段数越多单段窗口越短，余额给到命中答案句的段（引语保底不受此限）
  const perBudget = Math.max(
    WINDOW_FALLBACK,
    Math.min(
      WINDOW_BUDGET,
      Math.floor(INJECT_TOTAL_BUDGET / Math.max(1, injected.length))
    )
  );
  injected.forEach((fragment, index) => {
    const windowed = trimTextToWindow(fragment.text, query, perBudget);
    const visible = mergeFirstQuoteIntoWindow(windowed, fragment);
    targets.set(`片段${index + 1}`, {
      text: windowed,
      chapter: fragment.chapter,
      title: fragment.title,
      source: fragment.source,
    });
    const { marked, assigned, next: after } = markQuotesInWindow(
      visible,
      fragment,
      next
    );
    next = after;
    for (const { qid, quote } of assigned) {
      quotes.set(qid, {
        text: quote.text,
        chapter: fragment.chapter,
        title: fragment.title,
        source: fragment.source,
      });
    }
    parts.push(`[片段${index + 1}] ${marked}`);
  });
  return { text: parts.join("\n\n"), quotes, fragments: targets };
}

/** 模型输出里的引用指针（`[Qn]` 引语 / `[片段N]` 叙述段） */
export function extractCitePointers(answer: string): string[] {
  return [
    ...[...answer.matchAll(/\[(Q\d+)\]/g)].map((matched) => matched[1]),
    ...[...answer.matchAll(/\[片段(\d+)\]/g)].map(
      (matched) => `片段${matched[1]}`
    ),
  ];
}

/** 模型输出里的引语指针（`[Qn]`） */
export function extractQuotePointers(answer: string): string[] {
  return extractCitePointers(answer).filter((ref) => ref.startsWith("Q"));
}

/** 指针校验（spec §6.4）：至少含一个指针，且指针全部 ∈ 本次注入的 qid / 片段编号集合 */
export function validateQuotePointers(
  answer: string,
  injected: Map<string, RenderedQuote>,
  injectedFragments?: Map<string, RenderedQuote>
): { ok: boolean; pointers: string[]; invalid: string[] } {
  const pointers = extractCitePointers(answer);
  const invalid = pointers.filter((ref) =>
    ref.startsWith("Q") ? !injected.has(ref) : !injectedFragments?.has(ref)
  );
  return { ok: pointers.length > 0 && invalid.length === 0, pointers, invalid };
}

/** 长引语安全网（spec §6.4）：丢弃模型违规抄写的超长「…」（其原文由指针 + 字段渲染提供） */
export function stripOverlongModelQuotes(answer: string): string {
  return answer.replace(/「([^」]*)」/g, (whole, inner: string) =>
    inner.length > MAX_MODEL_QUOTE_LENGTH ? "" : whole
  );
}

/** 出处渲染：只到回目、不展示段号（spec §6.6）；无回号时退回来源标识 */
export function formatQuoteSource(quote: {
  chapter?: number;
  title?: string;
  source: string;
}): string {
  if (typeof quote.chapter === "number") {
    return quote.title
      ? `第${quote.chapter}回 ${quote.title}`
      : `第${quote.chapter}回`;
  }
  return quote.source;
}

/** 服务端渲染引用与出处（spec §6.4 步骤 3）：`[Qn]` → 引语、`[片段N]` → 叙述段窗口，
 * 均渲染为 `「原文」（出处：第N回 回目）`；未注册的指针原样保留。 */
export function renderAnswerWithQuotes(
  answer: string,
  injected: Map<string, RenderedQuote>,
  injectedFragments?: Map<string, RenderedQuote>
): string {
  return answer.replace(/\[(Q\d+|片段\d+)\]/g, (whole, ref: string) => {
    const quote = ref.startsWith("Q")
      ? injected.get(ref)
      : injectedFragments?.get(ref);
    return quote
      ? `「${quote.text}」（出处：${formatQuoteSource(quote)}）`
      : whole;
  });
}

/** query 锚点稀有度：命中最稀有 key 的 [key 长度, -段内出现次数, -首次位置]；无命中为 null。
 * 与窗口锚定同一套排序（长 key 信息量大；同长时段内出现越少越像答案句标志，如证据段
 * 「华雄」只 1 次 vs 孙坚夜战段 3 次）。 */
function anchorScore(
  text: string,
  query: string
): [number, number, number] | null {
  const anchors: KeyAnchor[] = [];
  for (const key of extractQueryKeys(query)) {
    const occurrences: number[] = [];
    let cursor = text.indexOf(key);
    while (cursor >= 0) {
      occurrences.push(cursor);
      cursor = text.indexOf(key, cursor + key.length);
    }
    if (occurrences.length > 0) {
      anchors.push({ key, occurrences });
    }
  }
  const ranked = rankKeyAnchors(anchors);
  if (ranked.length === 0) {
    return null;
  }
  const best = ranked[0];
  return [best.key.length, -best.occurrences.length, -best.occurrences[0]];
}

function isAnchorBetter(
  a: [number, number, number] | null,
  b: [number, number, number] | null
): boolean {
  if (a && b) {
    return (
      a[0] > b[0] ||
      (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))
    );
  }
  return a !== null && b === null;
}

/**
 * 兜底选段：不盲取 fragments[0]（相关度排序会被实体高频干扰段把持，如孙坚夜战段）。
 * 双层评分，逐层决出：
 *   1. 结论断言人物覆盖 —— 结论是归纳出的真答案，用其人物锚定证据段（如「被关羽所杀」→
 *      选含「云长/关羽」的段，排除纯「华雄」共现的夜战段）；
 *   2. query 锚点稀有度 —— 结论无人物（如「被斩于帐前」）时退化为纯锚点比较。
 * 平局保持原顺序（工具相关度降序）。
 */
export function pickBestFallbackFragment(
  fragments: RecallFragment[],
  query = "",
  conclusion = ""
): RecallFragment {
  const aliasTable = loadAliasTable();
  const asserted = scanRecallPersonIds(conclusion, aliasTable);
  let best = fragments[0];
  let bestAssert = -1;
  let bestAnchor: [number, number, number] | null = null;
  for (const fragment of fragments) {
    const assertHit = asserted.size
      ? [...scanRecallPersonIds(fragment.text, aliasTable)].filter((id) =>
          asserted.has(id)
        ).length
      : 0;
    const anchor = anchorScore(fragment.text, query);
    const better =
      assertHit > bestAssert ||
      (assertHit === bestAssert && isAnchorBetter(anchor, bestAnchor));
    if (better) {
      best = fragment;
      bestAssert = assertHit;
      bestAnchor = anchor;
    }
  }
  return best;
}

/**
 * 兜底输出（spec §6.4 步骤 4）：不做归纳生成，只输出最符合的一段 + 出处 + 一句结论。
 * 原文取纯原文窗口（不含 `[片段N]` / `⟨Qn⟩` 注入标记），出处由 chapter / title 字段渲染、只到回目。
 * 选段走 pickBestFallbackFragment（先裁窗口再编号的同套锚点口径），不再盲取 fragments[0]。
 */
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
  const top = pickBestFallbackFragment(fragments, query, conclusion);
  return [
    "【原文片段】",
    `${trimTextToWindow(top.text, query)}\n（出处：${formatQuoteSource(top)}）`,
    "",
    conclusionLine,
  ].join("\n");
}
