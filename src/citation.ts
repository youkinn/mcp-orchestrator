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

/** spec §5 语料 schema（bug-00010 出参瘦身）：一条引语只给定位，不再重复携带文本 /
 * qid / speaker——引语原文由编排侧按切片还原，出参体积随之减半。 */
export interface RecallQuote {
  /** 开引号在该条目 text 中的 1 基下标 */
  offset: number;
  /** 引语本体字数（不含两侧引号） */
  len: number;
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
  /** 该片段携带的引语（只有定位；渲染前由 buildInjectionView 还原文本并重编号） */
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
}

/** feat-A006 引用出处卡片：按引用出现顺序的扁平数组；无引用时恒 [] */
export interface Citation {
  /** 命中片段原文（工具出参 text，可含引语；无回目 / 段号 / 类型 / 分数） */
  text: string;
  /** 回号 */
  chapter?: number;
  /** 回目 */
  title?: string;
}

/** /api/chat 与 /api/sango/random 响应 data 统一形状（feat-A006） */
export interface ChatData {
  answer: string;
  citations: Citation[];
}

/** 注入视图：注入给模型的纯原文（带 `[片段N]` / `⟨Qn⟩` 标记）+ 全局 qid → 引语元数据 */
export interface InjectionView {
  text: string;
  quotes: Map<string, RenderedQuote>;
  /** 全局片段编号 → 该片段原文窗口（叙述句答案的引用目标：`[片段N]` 指针渲染用，bug-00009） */
  fragments: Map<string, RenderedQuote>;
  /** 全局引语序号 → 所属片段编号（feat-A006：同片段多引语合并为一条 citation） */
  quoteFragments: Map<string, string>;
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

/** 注入保底段数：前 N 段整段注入、不裁剪、不参与预算竞争（2026-09-20 注入策略定稿） */
export const INJECT_HEAD_GUARANTEE = 5;
/** 注入全问预算（字）：前 INJECT_HEAD_GUARANTEE 段保底可软超；其后整段在预算内依次纳入，超预算丢整段、绝不段内裁剪 */
export const INJECT_TOTAL_BUDGET = 2000;
/** 注入尾部兜底开关（代码常量，不读配置文件）：true=前 5 段整段保底 + 第 6–10 段预算兜底；false=固定只注入前 5 段整段 */
export const INJECT_TAIL_FALLBACK_ENABLED = true;

/** 一个 query key 在段内的全部出现位置 */
interface KeyAnchor {
  key: string;
  occurrences: number[];
}

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
          ? entry.quotes.filter((quote) =>
              isValidQuoteRange(quote, entry.text.length)
            )
          : undefined,
      });
    }
  }
  return fragments;
}

/** 引语定位合法性：offset / len 为整数、len 为正、开引号在正文内、且整条引语（含两侧
 * 引号）不越出正文。非法只跳过该条引语，绝不让整组 quotes 静默变空（bug-00009 同类回归：
 * quotes 全空 ⇒ 注入视图无 ⟨Qn⟩ ⇒ 指针校验失败 ⇒ 全量走兜底、引用丢失）。 */
function isValidQuoteRange(quote: RecallQuote, textLength: number): boolean {
  return (
    !!quote &&
    Number.isInteger(quote.offset) &&
    Number.isInteger(quote.len) &&
    quote.len > 0 &&
    quote.offset >= 1 &&
    quote.offset - 1 + quote.len + 2 <= textLength
  );
}

/** 按 offset / len 还原引语本体（不含两侧引号）：offset 是开引号的 1 基下标，
 * 故本体起点为 0 基的 offset（开引号下标 offset-1 再 +1）。 */
function sliceQuoteText(text: string, quote: RecallQuote): string {
  return text.slice(quote.offset, quote.offset + quote.len);
}

/** 在正文内标出引语：`⟨Qn⟩` 插在开引号前，qid 从 start 起按出参 quotes 顺序连续编号。
 *
 * **前置条件：text 必须与 quote.offset 同基准。** offset 是整段 fragment.text 的 1 基下标，
 * 故当前调用方恒传整段 fragment.text；本函数不做窗口裁剪、不做偏移换算。若将来恢复窗口裁剪
 * 而把裁剪后的窗口文本传进来，落在窗口内的 offset 仍会通过校验却语义错位，静默标错 ⟨Qn⟩
 * （bug-00009 同类：标记与文本不对位 ⇒ 指针指向错误引语）。要支持窗口必须先把 offset 换算到
 * 窗口基准，或直接传整段文本。
 *
 * 定位直接取 offset（1 基 → 0 基减一），不再 indexOf 搜索——同一 chunk 内引语文本重复时
 * 也能各就各位（全量语料 7 处）。越界引语（含两侧引号超出 text 范围 / 数据非法）跳过，
 * 不标错位置；跳过只影响该条，编号仍连续无空洞。 */
function markQuotesInWindow(
  text: string,
  fragment: RecallFragment,
  start: number
): { marked: string; assigned: Array<{ qid: string; quote: RecallQuote }>; next: number } {
  const located: Array<{ at: number; qid: string; quote: RecallQuote }> = [];
  for (const quote of fragment.quotes ?? []) {
    if (!isValidQuoteRange(quote, text.length)) {
      continue;
    }
    located.push({
      at: quote.offset - 1,
      qid: `Q${start + located.length}`,
      quote,
    });
  }
  const assigned = located.map(({ qid, quote }) => ({ qid, quote }));
  let marked = text;
  // 从后往前插入，前面的下标才不被撑位移（编号顺序不受插入顺序影响）
  for (const { at, qid } of [...located].sort((a, b) => b.at - a.at)) {
    marked = marked.slice(0, at) + `⟨${qid}⟩` + marked.slice(at);
  }
  return { marked, assigned, next: start + assigned.length };
}

/**
 * 注入视图（spec §6.3）：纯原文 + 服务端编号。
 * 片段带 `[片段N]`，片段内引语带 `⟨Qn⟩`；**不带回目、段号、分数**，模型无从抄写出处。
 * 注入策略（2026-09-20 定稿）：前 INJECT_HEAD_GUARANTEE 段整段保底、不裁剪、不占预算；
 * 第 6 段起仅在开关开启且预算内整段纳入，超预算丢整段、绝不段内裁剪；整段注入下引语
 * 完整可见，编号连续无空洞（不再需要「并入首条引语」等窗口补偿逻辑）。
 */
export function buildInjectionView(
  fragments: RecallFragment[],
  query = "",
  tailFallback = INJECT_TAIL_FALLBACK_ENABLED
): InjectionView {
  const quotes = new Map<string, RenderedQuote>();
  const targets = new Map<string, RenderedQuote>();
  const quoteFragments = new Map<string, string>();
  const parts: string[] = [];
  let next = 1;
  const injected = fragments.slice(0, INJECT_FRAGMENT_LIMIT);
  // 前 INJECT_HEAD_GUARANTEE 段保底整段注入（不参与预算竞争）；
  // tailFallback=false 时固定只注入前 5 段；开启时第 6+ 段整段在预算内依次纳入，超预算丢整段。
  const picked = injected.slice(0, INJECT_HEAD_GUARANTEE);
  if (tailFallback) {
    let used = picked.reduce((sum, fragment) => sum + fragment.text.length, 0);
    for (const fragment of injected.slice(INJECT_HEAD_GUARANTEE)) {
      if (used + fragment.text.length > INJECT_TOTAL_BUDGET) {
        break;
      }
      picked.push(fragment);
      used += fragment.text.length;
    }
  }
  picked.forEach((fragment, index) => {
    const fragmentKey = `片段${index + 1}`;
    targets.set(fragmentKey, {
      text: fragment.text,
      chapter: fragment.chapter,
      title: fragment.title,
    });
    const { marked, assigned, next: after } = markQuotesInWindow(
      fragment.text,
      fragment,
      next
    );
    next = after;
    for (const { qid, quote } of assigned) {
      quotes.set(qid, {
        text: sliceQuoteText(fragment.text, quote),
        chapter: fragment.chapter,
        title: fragment.title,
      });
      quoteFragments.set(qid, fragmentKey);
    }
    parts.push(`[${fragmentKey}] ${marked}`);
  });
  return { text: parts.join("\n\n"), quotes, fragments: targets, quoteFragments };
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

/** 上标角标字符（feat-A006）：¹²³⁴⁵⁶⁷⁸⁹⁰，下标按出现顺序从 1 起 */
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** 全局上标角标：1 → ¹，10 → ¹⁰（>9 用多字符组合），与 citations 下标一一对应 */
export function toSuperscript(index: number): string {
  return String(index)
    .split("")
    .map((digit) => SUPERSCRIPT_DIGITS[Number(digit)])
    .join("");
}

/** 解析答案里的指针：引语 `[Qn]`（连同所属片段编号）或叙述段 `[片段N]`；未注册返回 null */
function resolvePointerRef(
  ref: string,
  view: InjectionView
): { quote: RenderedQuote; fragmentKey: string } | null {
  const quote = ref.startsWith("Q")
    ? view.quotes.get(ref)
    : view.fragments.get(ref);
  if (!quote) {
    return null;
  }
  const fragmentKey = ref.startsWith("Q")
    ? view.quoteFragments.get(ref)
    : ref;
  return fragmentKey ? { quote, fragmentKey } : null;
}

/** 服务端渲染引用与出处（feat-A006）：`[Qn]` 引语指针 → 「引文」+ 全局上标角标，
 * `[片段N]` 叙述段指针 → 仅全局上标角标（不内联原文，answer 只放结论，原文进 citations 卡片）；
 * 不再内联出处；citations 按引用出现顺序、片段粒度合并（同片段多引语合并为一条，
 * 角标数量 = 片段数量），只收被引用片段；未注册的指针原样保留。 */
export function renderAnswerWithCitations(
  answer: string,
  view: InjectionView
): ChatData {
  const citations: Citation[] = [];
  const citedIndexes = new Map<string, number>();
  const rendered = answer.replace(/\[(Q\d+|片段\d+)\]/g, (whole, ref: string) => {
    const resolved = resolvePointerRef(ref, view);
    if (!resolved) {
      return whole;
    }
    let index = citedIndexes.get(resolved.fragmentKey);
    if (index === undefined) {
      index = citations.length + 1;
      citedIndexes.set(resolved.fragmentKey, index);
      const fragment = view.fragments.get(resolved.fragmentKey);
      citations.push({
        text: fragment?.text ?? resolved.quote.text,
        chapter: fragment?.chapter ?? resolved.quote.chapter,
        title: fragment?.title ?? resolved.quote.title,
      });
    }
    if (ref.startsWith("Q")) {
      return `「${resolved.quote.text}」${toSuperscript(index)}`;
    }
    return toSuperscript(index);
  });
  return { answer: rendered, citations };
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
 * 兜底输出（feat-A006 结构化）：不做归纳生成，answer 放结论句（带角标 ¹），
 * citations 恰一条兜底片段（整段、不裁剪；chunk 上限 400 字，天然防刷屏，禁止多段拼刷）。
 * 选段走 pickBestFallbackFragment（结论人物 + query 锚点稀有度），不再盲取 fragments[0]；
 * 无原文可引用不得编造（citations 恒 []）。
 */
export function buildFallback(
  fragments: RecallFragment[],
  conclusion: string,
  query = ""
): ChatData {
  const conclusionLine = conclusion.startsWith("按原文")
    ? conclusion
    : `按原文，${conclusion}`;
  if (fragments.length === 0) {
    return { answer: conclusionLine, citations: [] };
  }
  const top = pickBestFallbackFragment(fragments, query, conclusion);
  return {
    answer: `${conclusionLine}${toSuperscript(1)}`,
    citations: [
      {
        text: top.text,
        chapter: top.chapter,
        title: top.title,
      },
    ],
  };
}

// ===== bug-00028：生成轮后置支撑护栏（零 LLM 规则判定）=====
// 触发位置：引用硬校验「指针合法 + 人物断言成立」之后、渲染之前（agent.ts applyNovelCitationGuard）。
// 判定：答案的每条结构化引用（[Qn] / [片段N] → 注入片段）是否支撑结论，逐条给失败原因；
//   1. person   — 片段不含答案断言人物（别名 ID 级，无 ID 人物退化为名字包含）——每片段级收紧，
//                 原 verifyCitation 是召回全量人物，无法抓到「人物出现在别的片段、引用却挂到本题」；
//   2. numeric  — 答案出现数值（阿拉伯 / 中文，含十百千万组合）时，片段须含同值数值（原样或等价形式）；
//   3. zi-value — 表字问句（问「字什么/字是什么」）时，答案表字值须出现在片段中（例：妙才）；
//   4. death    — 答案宣称死亡事件（病逝/遇害/被杀/而亡/卒/薨…）时，片段须含死亡证据词；
//   一律字面 / 数值包含性匹配，0 次 LLM；失败即认为该引用不支撑结论。
// 灰色地带与取舍（交付说明同步 dev-docs）：
//   - 人物未别名化（范疆/张达/马腾等）时人物锚点中性化：答案无人物才跳过；
//     「范、张二贼」式缩写无法字面关联，故不做术语包含硬门（否则误杀合法答案，见 agent-novel ⑦）。
//   - 数值以「原样包含 / 中阿互转同值」双通道判；「六十有三」式变体无法解析 → 判不支撑（A004 宁拒勿猜）。
//   - 表字值只做值包含，不做「该值挂在哪个人名下」的归属核对（例：答「夏侯渊字元让」引夏侯惇段会漏过，
//     属 alias 归一化副作用族，方向 C 范围外）。
//   - 死亡证据词限定强死亡字（死/亡/卒/薨/殁/殒/逝 及 遇害/被杀/被斩 等多字词），不含单字「杀/害」
//     （杀向/欲害 常见于战争叙事，误杀面大）。
//   - 无以上信号的纯叙述声明（人物锚点成立即放行）属护栏盲区：零 LLM 下不可判，记录待方向 B 检索覆盖。
// ======================================================================

/** 中文数字字符（十百千万为进位单位，非法字符外任何字都会中断该 token） */
const CN_NUMERAL_CHARS = /[〇零一二两三四五六七八九十百千万]+/g;
const CN_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 中文数字 → 阿拉伯数（0~99999999，万以上按万节分解）；无法解析返回 null。
 * 纯数字串（无单位）按逐位拼接（二零二六 → 2026）；有单位按「数字×单位」累计（六十三 → 63，十三 → 13）。 */
export function toArabicNumeral(zh: string): number | null {
  if (!zh || zh.length > 32) {
    return null;
  }
  const hasUnit = [...zh].some((ch) => CN_UNITS[ch] !== undefined);
  if (!hasUnit) {
    let value = 0;
    for (const ch of zh) {
      const digit = CN_DIGITS[ch];
      if (digit === undefined) {
        return null;
      }
      value = value * 10 + digit;
    }
    return value;
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of zh) {
    const d = CN_DIGITS[ch];
    if (d !== undefined) {
      digit = d;
      continue;
    }
    const unit = CN_UNITS[ch];
    if (unit === undefined) {
      return null;
    }
    if (unit === 10000) {
      section = (section + digit) * unit;
      total += section;
      section = 0;
      digit = 0;
    } else {
      section += (digit || 1) * unit;
      digit = 0;
    }
  }
  return total + section + digit;
}

/** 文本中出现的数值（阿拉伯 token + 中文数字 token，原样返回） */
function extractNumerals(text: string): string[] {
  return [
    ...[...text.matchAll(/\d+/g)].map((matched) => matched[0]),
    ...[...text.matchAll(CN_NUMERAL_CHARS)].map((matched) => matched[0]),
  ];
}

/** 文本中全部数值的阿拉伯等价（可解析的），供中阿同值对照 */
function numeralValuesOf(text: string): Set<number> {
  const values = new Set<number>();
  for (const token of extractNumerals(text)) {
    if (/^\d+$/.test(token)) {
      values.add(Number(token));
      continue;
    }
    const value = toArabicNumeral(token);
    if (value !== null) {
      values.add(value);
    }
  }
  return values;
}

/** 片段是否含答案数值：原文包含 / 中阿同值（片段侧解析对照）任一成立 */
function fragmentContainsNumeral(fragmentText: string, token: string): boolean {
  if (fragmentText.includes(token)) {
    return true;
  }
  const value = /^\d+$/.test(token) ? Number(token) : toArabicNumeral(token);
  if (value === null) {
    return false;
  }
  if (fragmentText.includes(String(value))) {
    return true;
  }
  return numeralValuesOf(fragmentText).has(value);
}

/** 表字问句：问「字什么 / 字是什么 / 字叫啥 / 表字」 */
const ZI_QUESTION_PATTERN = /字(?:是|为|叫)?(?:什么|啥|何)|表字/;

/** 答案里的表字值：紧随「字 / 表字」后的 1~12 个非标点字符 */
const ZI_VALUE_PATTERN = /(?:表字|字)([^，。；、！？…\s]{1,12})/;

/** 答案宣称「死亡事件」的信号（覆盖 bug-00028 例 1 的病逝；不含单字 死/杀/害，降低误触发） */
const ANSWER_DEATH_SIGNAL =
  /(?:病逝|病故|去世|逝世|身亡|遇害|被杀|被斩|斩首|阵亡|丧命|殒命|刺死|杀死|战死|病死|冤死|死于|之死|死时|而亡|卒|薨|殁|殒|终年)/;

/** 片段侧死亡证据词（同信号口径；单字 死/亡/卒/薨/殁/殒/逝 亦可，不含 杀/害） */
const FRAGMENT_DEATH_EVIDENCE =
  /(?:遇害|被杀|被斩|斩首|阵亡|丧命|殒命|刺死|杀死|战死|病死|死于|而亡|遇难|病逝|病故|薨|殁|殒|[死亡卒])/;

/** bug-00028 支撑判定失败原因（null = 支撑成立） */
export type SupportFailureReason =
  | "person"
  | "numeric"
  | "zi-value"
  | "death"
  | null;

/** 单条片段支撑判定：fragmentText 为该引用对应的整段注入原文（fragment 级，非引语窗口） */
export function evaluateFragmentSupport(
  fragmentText: string,
  answer: string,
  query: string,
  aliasTable: Map<string, string>
): SupportFailureReason {
  // 1. 人物锚点（每片段级）：答案断言人物须出现在被引用片段
  const personsInAnswer = scanRecallPersonIds(answer, aliasTable);
  if (personsInAnswer.size > 0) {
    const personsInFragment = scanRecallPersonIds(fragmentText, aliasTable);
    let overlap = false;
    for (const id of personsInAnswer) {
      if (personsInFragment.has(id)) {
        overlap = true;
        break;
      }
    }
    if (!overlap) {
      return "person";
    }
  }
  // 2. 数值：答案每个数值都须在片段中有同值证据（原样或中阿互转）
  // 先剥离指针标记（[Q1] / [片段5] 内的编号是引用下标，不是答案声明的数值）
  const claimText = answer.replace(/\[(?:Q\d+|片段\d+)\]/g, "");
  for (const token of extractNumerals(claimText)) {
    if (!fragmentContainsNumeral(fragmentText, token)) {
      return "numeric";
    }
  }
  // 3. 表字问句：表字值须出现在片段中（例 2：妙才不在 ch5 → 不支撑）
  if (ZI_QUESTION_PATTERN.test(query)) {
    const matched = ZI_VALUE_PATTERN.exec(answer);
    if (matched?.[1] && !fragmentText.includes(matched[1])) {
      return "zi-value";
    }
  }
  // 4. 死亡事件：答案有死亡信号 → 片段须含死亡证据（例 1：衣带诏段无 → 不支撑）
  if (ANSWER_DEATH_SIGNAL.test(answer) && !FRAGMENT_DEATH_EVIDENCE.test(fragmentText)) {
    return "death";
  }
  return null;
}

/** 逐条引用过滤：去掉不支撑结论的指针（保留其答案正文，仅移除指针本身与对应引用卡片）。
 * 返回剔除后的答案 + 保留 / 剔除的指针列表；kept.length===0 即「无任何支撑引用」→ 由调用方拒答。 */
export function filterUnsupportedPointers(
  answer: string,
  view: InjectionView,
  query: string,
  aliasTable: Map<string, string>
): { answer: string; kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  let filtered = answer;
  for (const pointer of extractCitePointers(answer)) {
    const resolved = resolvePointerRef(pointer, view);
    if (!resolved) {
      dropped.push(pointer);
      filtered = filtered.replace(new RegExp(`\\[${escapeRegExp(pointer)}\\]`, "g"), "");
      continue;
    }
    const fragmentText = view.fragments.get(resolved.fragmentKey)?.text ?? "";
    const reason = evaluateFragmentSupport(fragmentText, answer, query, aliasTable);
    if (reason === null) {
      kept.push(pointer);
    } else {
      dropped.push(pointer);
      filtered = filtered.replace(new RegExp(`\\[${escapeRegExp(pointer)}\\]`, "g"), "");
    }
  }
  return { answer: filtered, kept, dropped };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
