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

// bug-00028 单轮方案·结构门第三条：句-片段文本重叠（判定纯函数，见 agent.ts applyNovelCitationGuard）。
// 答案里带 [片段N] 的叙述句与该片段做字符 n-gram 重叠判定：归一化（剔除空白标点、全角数字转半角、
// 引号内容不参与）后，句子 n-gram 命中片段集合的比例低于阈值 → 低重叠句（边界复核候选）；
// 引语句（[Qn]）不受此门约束（沿用服务端渲染）。只依赖片段文本，不引入任何词表 / 枚举。
// bug-00032/33/34：重叠门由「字面一票否决」改为「低重叠 → 边界语义复核」——重叠 < 阈值的待裁句
// 由 agent 走一次轻量 LLM 语义复核（supported 放行 / unsupported 裁剪，见 agent.ts
// checkNovelBoundarySupport）；本文件只做纯函数拆分（低重叠句挑选 + 裁剪），不发起任何 LLM 调用。

/** 句-片段重叠阈值（结构门第三条）：重叠率低于该值 → 边界语义复核候选（默认从严，0.5 起测边界） */
export const SENTENCE_OVERLAP_THRESHOLD = 0.5;
/** 句-片段重叠的字符 n-gram 长度 */
export const SENTENCE_OVERLAP_NGRAM = 2;
/** 重叠归一化：剔除引语（引号内容不参与本门判定）、全角数字转半角、剔除空白与标点 */
function normalizeOverlapText(text: string): string {
  return text
    .replace(/「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’/g, "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 字符 n-gram 集合 */
function charNgrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= text.length; i++) {
    grams.add(text.slice(i, i + n));
  }
  return grams;
}

/** 叙述句与片段的 n-gram 重叠率：句子 n-gram 命中片段集合的比例；句子不足 n 字符 → 0（从严） */
export function sentenceFragmentOverlap(
  sentence: string,
  fragmentText: string,
  n = SENTENCE_OVERLAP_NGRAM
): number {
  // 指针（[Qn] / [片段N]）是服务端编号标记，不参与文本重叠：先剔除再归一
  const sentGrams = charNgrams(
    normalizeOverlapText(sentence.replace(/\[(?:Q\d+|片段\d+)\]/g, "")),
    n
  );
  if (sentGrams.size === 0) {
    return 0;
  }
  const fragGrams = charNgrams(normalizeOverlapText(fragmentText), n);
  let hit = 0;
  for (const gram of sentGrams) {
    if (fragGrams.has(gram)) {
      hit += 1;
    }
  }
  return hit / sentGrams.size;
}

/** 去掉答案里的引用指针标记（[片段N] / [Qn]），返回句子正文（bug-00038：复核候选与拒答判定按正文） */
export function stripPointerMarkers(text: string): string {
  return text.replace(/\[(?:Q\d+|片段\d+)\]/g, "");
}

/** 把答案切成句（句末标点 / 指针为边界），[Qn] / [片段N] 指针并入所属句子 */
function splitAnswerSentences(answer: string): Array<{
  text: string;
  narrativePointers: string[];
  quotePointers: string[];
}> {
  const sentences: Array<{
    text: string;
    narrativePointers: string[];
    quotePointers: string[];
  }> = [];
  const re = /([^。！？；]*[。！？；]?)((?:\[(?:Q\d+|片段\d+)\])*)/g;
  let matched: RegExpExecArray | null;
  while ((matched = re.exec(answer)) !== null) {
    if (matched[0] === "") {
      break;
    }
    const text = (matched[1] ?? "") + (matched[2] ?? "");
    if (!text.trim()) {
      continue;
    }
    // 指针不限于句尾（bug-00037：句号前指针同样归属本句），从整句正文提取
    const narrativePointers = [...text.matchAll(/\[片段(\d+)\]/g)].map(
      (m) => `片段${m[1]}`
    );
    const quotePointers = [...text.matchAll(/\[Q(\d+)\]/g)].map(
      (m) => `Q${m[1]}`
    );
    sentences.push({ text, narrativePointers, quotePointers });
  }
  return sentences;
}

/** 低重叠叙述句（边界语义复核候选）：带 [片段N] 或与注入片段低重叠的叙述句，重叠率 < 阈值。 */
export interface LowOverlapSentence {
  /** 整句原始文本（含 [片段N] / [Qn] 指针） */
  text: string;
  /** 该句引用的叙述段指针（如 片段5）；无指针叙述句为空数组 */
  pointers: string[];
  /** 候选片段重叠率的最大值（仍 < SENTENCE_OVERLAP_THRESHOLD；无注入片段时为 0） */
  bestOverlap: number;
  /** 重叠率最高片段原文（复核参考文本；无注入片段时为 null） */
  bestFragmentText: string | null;
}

/** 结构门第三条·低重叠句挑选（纯函数）：返回需要边界语义复核的叙述句。
 * 带 [片段N] 的句子取其引用片段的最大重叠率；无指针叙述句（bug-00037：结论句不带指针、
 * 指针挂在引文句时，结论断言会逃过本门）对全部注入片段取最大重叠率。引语句（[Qn]）
 * 不受本门约束（服务端渲染）；重叠率低于阈值即列为复核候选，由调用方按判定结果
 * 用 stripAnswerSentences 放行（不裁剪）或裁剪。
 * bug-00039：单请求复核预算=1（生成轮之后边界语义复核至多 1 次）——调用方（agent.ts）
 * 只复核 bestOverlap 最高（并列取数组最先出现）的唯一候选句，其余候选直接按
 * unsupported 裁剪；本文件只做纯函数拆分（挑选 + 裁剪），不发起任何 LLM 调用。
 * bug-00038：去掉 [片段N]/[Qn] 标记后无正文的纯指针句先行剔除，不进复核候选。 */
export function findLowOverlapSentences(
  answer: string,
  view: InjectionView
): LowOverlapSentence[] {
  const low: LowOverlapSentence[] = [];
  for (const sentence of splitAnswerSentences(answer)) {
    // bug-00038：纯指针句（去掉 [片段N]/[Qn] 后无正文）不进复核候选——结论句被裁光后
    // 仅剩的裸引用行会因零字数零重叠被判低重叠句触发 LLM 复核（trace ba5bb4ec 的额外
    // 调用来源），且正文为空仍可能判 supported 保留，最终渲染出「空正文+脚注」。
    if (!stripPointerMarkers(sentence.text).trim()) {
      continue;
    }
    // bug-00040：去掉指针后非空、但重叠归一化后为空（整句内容均为引语）→ 不进复核候选、不裁剪、
    // 不占复核预算。模型引文行如 [Q19]“……！……！” 被句切分后（！为句边界）会产生“……！/……”等
    // 无指针引语片段句：引语内容在重叠归一化时被剔除 → 必低重叠 → 之前每次都会逐句进复核（纯浪费调用）；
    // 引语本就由指针 + 字段渲染提供，无需复核。
    if (normalizeOverlapText(stripPointerMarkers(sentence.text)) === "") {
      continue;
    }
    if (sentence.narrativePointers.length === 0) {
      // bug-00037：引语句（[Qn]，服务端渲染）不受重叠门约束；纯无指针叙述句纳入全片段重叠检查
      if (sentence.quotePointers.length > 0) {
        continue;
      }
      let bestOverlap = 0;
      let bestFragment: RenderedQuote | undefined;
      for (const fragment of view.fragments.values()) {
        const overlap = sentenceFragmentOverlap(sentence.text, fragment.text);
        if (bestFragment === undefined || overlap > bestOverlap) {
          bestOverlap = overlap;
          bestFragment = fragment;
        }
      }
      if (bestOverlap < SENTENCE_OVERLAP_THRESHOLD) {
        low.push({
          text: sentence.text,
          pointers: [],
          bestOverlap,
          bestFragmentText: bestFragment?.text ?? null,
        });
      }
      continue;
    }
    let bestOverlap = 0;
    let bestFragment: RenderedQuote | undefined;
    for (const pointer of sentence.narrativePointers) {
      const fragment = view.fragments.get(pointer);
      if (!fragment) {
        continue;
      }
      const overlap = sentenceFragmentOverlap(sentence.text, fragment.text);
      // 首个可解析片段即作为复核参考（零重叠也应给到片段文本），重叠更高才替换
      if (bestFragment === undefined || overlap > bestOverlap) {
        bestOverlap = overlap;
        bestFragment = fragment;
      }
    }
    if (bestOverlap < SENTENCE_OVERLAP_THRESHOLD) {
      low.push({
        text: sentence.text,
        pointers: sentence.narrativePointers,
        bestOverlap,
        bestFragmentText: bestFragment?.text ?? null,
      });
    }
  }
  return low;
}

/** 结构门第三条·裁剪（纯函数）：把命中文本的整句（连同指针）从答案中移除，返回剩余答案。 */
export function stripAnswerSentences(
  answer: string,
  dropTexts: ReadonlySet<string>
): string {
  return splitAnswerSentences(answer)
    .filter((sentence) => !dropTexts.has(sentence.text))
    .map((sentence) => sentence.text)
    .join("");
}

/** 结构门第三条·字面裁剪（零 LLM 兼容口径，保留给纯函数用例 / 复核不可用时的保守回落）：
 * 直接裁剪所有低重叠叙述句。返回裁剪后答案（调用方按空串 → 拒答「演义中未涉及」+ citations []）。 */
export function stripLowOverlapSentences(
  answer: string,
  view: InjectionView
): string {
  const low = findLowOverlapSentences(answer, view);
  if (low.length === 0) {
    return answer;
  }
  return stripAnswerSentences(
    answer,
    new Set(low.map((sentence) => sentence.text))
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
