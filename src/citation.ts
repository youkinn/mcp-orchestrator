// feat-A004：《三国演义》原著检索的引用硬校验模块
// 校验规则：答案断言人物集合（ID 级）⊆ 召回原文人物集合（ID 级），不成立走兜底。
// 人物 ID 化：本地别名表（封闭集合）扫描；无 ID 的次要人物退化为字符串包含校验。
// 引用与出处改服务端渲染（spec §6.3）：模型只输出指针 `[片段N]`，引用原文与出处由本模块按
// 字段渲染；注入视图只给纯原文 + 服务端编号（`[片段N]`），不带回目、段号、分数。
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

/** spec §5 检索工具出参条目（C4 定稿：裸数组，字段逐字为 id/text/chapter/title/type/segFrom/segTo） */
export interface RecallEntry {
  id?: string;
  text: string;
  /** 回号；逐条携带（单次召回的多条可来自不同回，出处只能逐条渲染） */
  chapter?: number;
  /** 回目；逐条携带 */
  title?: string;
  type?: string;
  /** 片段起点段号（同回原文出现位置，引用排序键） */
  segFrom?: number;
  /** 片段终点段号；跨段 chunk 时 segFrom != segTo */
  segTo?: number;
}

/** 召回原文片段：text 为纯原文（不含出处 / 段号 / 分数），出处由 chapter / title 字段渲染 */
export interface RecallFragment {
  text: string;
  source: string;
  chapter?: number;
  title?: string;
  /** 章内文本顺序号（chunk id 后缀 c\d+，同回引用排序的精确键） */
  chunkSeq?: number;
  /** 片段起点段号（同回原文出现位置，引用排序键；缺失片段排引用末位） */
  segFrom?: number;
  /** 片段终点段号；跨段 chunk 时 segFrom != segTo */
  segTo?: number;
}

/** 注入视图的片段条数上限：与检索返回条数联动（返回收缩到 10 条即全部注入）。
 * 放宽后第 4~10 名对模型可见——张飞题证据段排 #5，旧值 3 把它挡在模型视野外（bug-00009 同类）。 */
export const INJECT_FRAGMENT_LIMIT = 10;

/** 注入视图片段元数据：逐字可信的原文 + 出处 + 片段位置（引用排序键） */
export interface RenderedFragment {
  text: string;
  chapter?: number;
  title?: string;
  /** 章内文本顺序号（chunk id 后缀 c\d+，同回引用排序的精确键） */
  chunkSeq?: number;
  segFrom?: number;
  segTo?: number;
}

/** feat-A006 引用出处卡片：按回号递增、同回按原文出现先后排序的扁平数组；无引用时恒 [] */
export interface Citation {
  /** 命中片段原文（工具出参 text；无回目 / 段号 / 类型 / 分数） */
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

/** 注入视图：注入给模型的纯原文（带 `[片段N]` 标记）+ 全局片段编号 → 片段元数据 */
export interface InjectionView {
  text: string;
  /** 全局片段编号 → 该片段原文窗口（叙述句答案的引用目标：`[片段N]` 指针渲染用，bug-00009） */
  fragments: Map<string, RenderedFragment>;
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
        chunkSeq: parseChunkSeq(entry.id),
        title:
          typeof entry.title === "string" && entry.title.trim()
            ? entry.title.trim()
            : undefined,
        segFrom:
          typeof entry.segFrom === "number" ? entry.segFrom : undefined,
        segTo: typeof entry.segTo === "number" ? entry.segTo : undefined,
      });
    }
  }
  return fragments;
}

/** 从 chunk id（{source}:{回号4位}:c{章内序号4位}）反解章内文本顺序号；无 id / 非该格式返回 undefined */
function parseChunkSeq(id: string | undefined): number | undefined {
  if (typeof id !== "string") {
    return undefined;
  }
  const match = /:c(\d+)$/.exec(id);
  return match ? Number(match[1]) : undefined;
}
/**
 * 注入视图（spec §6.3）：纯原文 + 服务端编号。
 * 片段带 `[片段N]`；**不带回目、段号、分数**，模型无从抄写出处。
 * 注入策略（2026-09-20 定稿）：前 INJECT_HEAD_GUARANTEE 段整段保底、不裁剪、不占预算；
 * 第 6 段起仅在开关开启且预算内整段纳入，超预算丢整段、绝不段内裁剪；整段注入下编号
 * 连续无空洞。
 * feat-A017：草稿台请求级参数覆盖 —— options.topK / guarantee / budget 取代同名生产常量
 * （仅本次请求内生效，不改生产默认路径）；options 传布尔保留旧 tailFallback 调用兼容。
 */
export interface InjectionViewOptions {
  /** 注入条数上限，取代 INJECT_FRAGMENT_LIMIT（草稿台 topK）；缺省用生产常量 */
  topK?: number;
  /** 保底段数，取代 INJECT_HEAD_GUARANTEE（草稿台 guarantee）；缺省用生产常量 */
  guarantee?: number;
  /** 总预算（字），取代 INJECT_TOTAL_BUDGET（草稿台 budget）；缺省用生产常量 */
  budget?: number;
  /** 尾部兜底开关；缺省 INJECT_TAIL_FALLBACK_ENABLED（草稿台恒真，只读不可覆盖） */
  tailFallback?: boolean;
}

/** 结构化出处行（bug-00004 方案 C）：〔出处N〕第N回 回目名。
 * 紧跟对应片段块末尾，位置固定、可被 prompt 定向引用；与 [片段N] 标记形态互不混淆。
 * chapter / title 缺失（草稿台无出处片段）时不输出，返回 null。 */
export function buildSourceLine(
  fragmentKey: string,
  chapter?: number,
  title?: string
): string | null {
  const match = /^片段(\d+)$/.exec(fragmentKey);
  if (!match || chapter === undefined || !title) {
    return null;
  }
  return `〔出处${match[1]}〕第${chapter}回 ${title}`;
}

export function buildInjectionView(
  fragments: RecallFragment[],
  query = "",
  options: InjectionViewOptions | boolean = {}
): InjectionView {
  const opts: InjectionViewOptions =
    typeof options === "boolean" ? { tailFallback: options } : options;
  const limit = opts.topK ?? INJECT_FRAGMENT_LIMIT;
  const guarantee = opts.guarantee ?? INJECT_HEAD_GUARANTEE;
  const budget = opts.budget ?? INJECT_TOTAL_BUDGET;
  const tailFallback = opts.tailFallback ?? INJECT_TAIL_FALLBACK_ENABLED;
  const targets = new Map<string, RenderedFragment>();
  const parts: string[] = [];
  const injected = fragments.slice(0, limit);
  // 前 INJECT_HEAD_GUARANTEE 段保底整段注入（不参与预算竞争）；
  // tailFallback=false 时固定只注入前 5 段；开启时第 6+ 段整段在预算内依次纳入，超预算丢整段。
  const picked = injected.slice(0, guarantee);
  if (tailFallback) {
    let used = picked.reduce((sum, fragment) => sum + fragment.text.length, 0);
    for (const fragment of injected.slice(guarantee)) {
      if (used + fragment.text.length > budget) {
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
      chunkSeq: fragment.chunkSeq,
      segFrom: fragment.segFrom,
      segTo: fragment.segTo,
    });
    // bug-00004 方案 C：片段块末尾附结构化出处行（回号+回目名），正文保持纯原文
    const sourceLine = buildSourceLine(
      fragmentKey,
      fragment.chapter,
      fragment.title
    );
    parts.push(
      sourceLine ? `[${fragmentKey}] ${fragment.text}\n${sourceLine}` : `[${fragmentKey}] ${fragment.text}`
    );
  });
  return { text: parts.join("\n\n"), fragments: targets };
}

/** 模型输出里的引用指针（`[片段N]` 叙述段） */
export function extractCitePointers(answer: string): string[] {
  return [...answer.matchAll(/\[片段(\d+)\]/g)].map(
    (matched) => `片段${matched[1]}`
  );
}

/** 指针校验（spec §6.4）：至少含一个指针，且指针全部 ∈ 本次注入的片段编号集合 */
export function validateFragmentPointers(
  answer: string,
  injected: Map<string, RenderedFragment>
): { ok: boolean; pointers: string[]; invalid: string[] } {
  const pointers = extractCitePointers(answer);
  const invalid = pointers.filter((ref) => !injected.has(ref));
  return { ok: pointers.length > 0 && invalid.length === 0, pointers, invalid };
}

// bug-00028 单轮方案·结构门第三条：句-片段文本重叠（判定纯函数，见 agent.ts applyNovelCitationGuard）。
// 答案里带 [片段N] 的叙述句与该片段做字符 n-gram 重叠判定：归一化（剔除空白标点、全角数字转半角）
// 后，句子 n-gram 命中片段集合的比例低于阈值 → 低重叠句（边界复核候选）。只依赖片段文本，
// 不引入任何词表 / 枚举。
// bug-00032/33/34：重叠门由「字面一票否决」改为「低重叠 → 边界语义复核」——重叠 < 阈值的待裁句
// 由 agent 走一次轻量 LLM 语义复核（supported 放行 / unsupported 裁剪，见 agent.ts
// checkNovelBoundarySupport）；本文件只做纯函数拆分（低重叠句挑选 + 裁剪），不发起任何 LLM 调用。

/** 句-片段重叠阈值（结构门第三条）：重叠率低于该值 → 边界语义复核候选（默认从严，0.5 起测边界） */
export const SENTENCE_OVERLAP_THRESHOLD = 0.5;
/** 句-片段重叠的字符 n-gram 长度 */
export const SENTENCE_OVERLAP_NGRAM = 2;
/** 重叠归一化：全角数字转半角、剔除空白与标点 */
function normalizeOverlapText(text: string): string {
  return text
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
  // 指针（[片段N]）是服务端编号标记，不参与文本重叠：先剔除再归一
  const sentGrams = charNgrams(
    normalizeOverlapText(sentence.replace(/\[片段\d+\]/g, "")),
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

/** 去掉答案里的引用指针标记（[片段N]），返回句子正文（bug-00038：复核候选与拒答判定按正文） */
export function stripPointerMarkers(text: string): string {
  return text.replace(/\[片段\d+\]/g, "");
}

/** 把答案切成句（句末标点 / 指针为边界），[片段N] 指针并入所属句子 */
export function splitAnswerSentences(answer: string): Array<{
  text: string;
  narrativePointers: string[];
}> {
  const sentences: Array<{
    text: string;
    narrativePointers: string[];
  }> = [];
  const re = /([^。！？；]*[。！？；]?)((?:\[片段\d+\])*)/g;
  let matched: RegExpExecArray | null;
  while ((matched = re.exec(answer)) !== null) {
    if (matched[0] === "") {
      break;
    }
    const text = (matched[1] ?? "") + (matched[2] ?? "");
    if (!text.trim()) {
      continue;
    }
    // bug-00044：模型输出「结论句。\n\n[片段N]」会被正则切成「结论句」+ 独立指针行
    // （trace 46dbc882：结论句无指针 → 对全部注入片段错配无关片段作复核参考 → 误裁拒答）。
    // 后处理：纯指针行（去掉 [片段N] 后正文为空）且前面存在有正文句子时，拼到前句末尾，
    // 指针随文本归属前句（本函数从整句文本提取 narrativePointers，拼接后自然生效）；
    // 前面没有有正文句子的孤儿指针行保持原样（bug-00038 拒答路径不受影响）。
    const last = sentences[sentences.length - 1];
    if (
      last !== undefined &&
      stripPointerMarkers(text).trim() === "" &&
      stripPointerMarkers(last.text).trim() !== ""
    ) {
      const mergedText = last.text + text;
      last.text = mergedText;
      last.narrativePointers = [...mergedText.matchAll(/\[片段(\d+)\]/g)].map(
        (m) => `片段${m[1]}`
      );
      continue;
    }
    // 指针不限于句尾（bug-00037：句号前指针同样归属本句），从整句正文提取
    const narrativePointers = [...text.matchAll(/\[片段(\d+)\]/g)].map(
      (m) => `片段${m[1]}`
    );
    sentences.push({ text, narrativePointers });
  }
  return sentences;
}

/** 复核参考片段（bug-00057）：结论句所引单片段的原文 + 结构化出处行（〔出处N〕第N回 回目名）。 */
export interface LowOverlapFragment {
  /** 片段指针（如 片段5） */
  pointer: string;
  /** 片段原文 */
  text: string;
  /** 该片段的结构化出处行（回号类判据取用）；章节 / 回目缺失时为 null */
  sourceLine: string | null;
}

/** 低重叠叙述句（边界语义复核候选）：带 [片段N] 或与注入片段低重叠的叙述句，重叠率 < 阈值。 */
export interface LowOverlapSentence {
  /** 整句原始文本（含 [片段N] 指针） */
  text: string;
  /** 该句引用的叙述段指针（如 片段5）；无指针叙述句为空数组 */
  pointers: string[];
  /** 候选片段重叠率的最大值（仍 < SENTENCE_OVERLAP_THRESHOLD；无注入片段时为 0） */
  bestOverlap: number;
  /** 复核参考片段集（bug-00057）：带指针句 = 该句所引全部可解析片段（按指针首现顺序去重）；
   * 无指针句 = 全注入片段中重叠率最高的那一个；所引指针全不可解析 / 无注入片段时为 []。
   * 复核 LLM 以整组片段为准判定支撑，回号类判据取各片段出处行。 */
  referenceFragments: LowOverlapFragment[];
}

/** 结构门第三条·低重叠句挑选（纯函数）：返回需要边界语义复核的叙述句。
 * 带 [片段N] 的句子取其引用片段的最大重叠率；无指针叙述句（bug-00037：结论句不带指针时，
 * 结论断言会逃过本门）对全部注入片段取最大重叠率。重叠率低于阈值即列为复核候选，
 * 由调用方按判定结果用 stripAnswerSentences 放行（不裁剪）或裁剪。
 * bug-00039：单请求复核预算=1（生成轮之后边界语义复核至多 1 次）——调用方（agent.ts）
 * 只复核 bestOverlap 最高（并列取数组最先出现）的唯一候选句，其余候选直接按
 * unsupported 裁剪；本文件只做纯函数拆分（挑选 + 裁剪），不发起任何 LLM 调用。
 * bug-00038：去掉 [片段N] 标记后无正文的纯指针句先行剔除，不进复核候选。 */
export function findLowOverlapSentences(
  answer: string,
  view: InjectionView
): LowOverlapSentence[] {
  const low: LowOverlapSentence[] = [];
  for (const sentence of splitAnswerSentences(answer)) {
    // bug-00038：纯指针句（去掉 [片段N] 后无正文）不进复核候选——结论句被裁光后
    // 仅剩的裸引用行会因零字数零重叠被判低重叠句触发 LLM 复核（trace ba5bb4ec 的额外
    // 调用来源），且正文为空仍可能判 supported 保留，最终渲染出「空正文+脚注」。
    if (!stripPointerMarkers(sentence.text).trim()) {
      continue;
    }
    // 归一化后无正文（纯标点句）不构成复核候选
    if (normalizeOverlapText(stripPointerMarkers(sentence.text)) === "") {
      continue;
    }
    if (sentence.narrativePointers.length === 0) {
      // bug-00037：结论句不带指针时结论断言会逃过本门——无指针叙述句纳入全片段重叠检查
      let bestOverlap = 0;
      let bestFragmentKey: string | undefined;
      let bestFragment: RenderedFragment | undefined;
      for (const [fragmentKey, fragment] of view.fragments.entries()) {
        const overlap = sentenceFragmentOverlap(sentence.text, fragment.text);
        if (bestFragment === undefined || overlap > bestOverlap) {
          bestOverlap = overlap;
          bestFragment = fragment;
          bestFragmentKey = fragmentKey;
        }
      }
      if (bestOverlap < SENTENCE_OVERLAP_THRESHOLD) {
        // bug-00057 契约 4：无指针叙述句口径不变——全注入片段取重叠最高那一个作参考
        low.push({
          text: sentence.text,
          pointers: [],
          bestOverlap,
          referenceFragments:
            bestFragmentKey && bestFragment
              ? [
                  {
                    pointer: bestFragmentKey,
                    text: bestFragment.text,
                    sourceLine: buildSourceLine(
                      bestFragmentKey,
                      bestFragment.chapter,
                      bestFragment.title
                    ),
                  },
                ]
              : [],
        });
      }
      continue;
    }
    // bug-00057 契约 1：带指针句的复核参考 = 该句所引全部合法片段（原文 + 出处行），
    // 不再只取字面重叠最高的单个片段；bestOverlap 仍取句-片段重叠最大值（触发条件不变）。
    let bestOverlap = 0;
    const referenceFragments: LowOverlapFragment[] = [];
    const seenPointers = new Set<string>();
    for (const pointer of sentence.narrativePointers) {
      if (seenPointers.has(pointer)) {
        continue;
      }
      const fragment = view.fragments.get(pointer);
      if (!fragment) {
        continue;
      }
      seenPointers.add(pointer);
      referenceFragments.push({
        pointer,
        text: fragment.text,
        sourceLine: buildSourceLine(pointer, fragment.chapter, fragment.title),
      });
      const overlap = sentenceFragmentOverlap(sentence.text, fragment.text);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
      }
    }
    if (bestOverlap < SENTENCE_OVERLAP_THRESHOLD) {
      low.push({
        text: sentence.text,
        pointers: sentence.narrativePointers,
        bestOverlap,
        referenceFragments,
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

/** bug-00004 方案 C：非回号类问句的确定性裁剪（0 LLM）——返回含「第N回」或注入回目名的
 * 整句（连同指针），供护栏按现有 stripAnswerSentences 裁掉，守住「非回号类问句不输出回目」。
 * 回号正则覆盖阿拉伯 / 中文数字；回目名按注入视图 title 去空白后包含判定（模型可能不带全角空格）。 */
export function findChapterLeakSentences(
  answer: string,
  view: InjectionView
): string[] {
  const titles = [...view.fragments.values()]
    .map((fragment) => fragment.title)
    .filter((title): title is string => Boolean(title));
  const chapterRe = /第[0-9０-９一二三四五六七八九十百千零〇]+回/;
  const leaked: string[] = [];
  for (const sentence of splitAnswerSentences(answer)) {
    const body = stripPointerMarkers(sentence.text).replace(/\s/g, "");
    if (chapterRe.test(body)) {
      leaked.push(sentence.text);
      continue;
    }
    if (titles.some((title) => body.includes(title.replace(/\s/g, "")))) {
      leaked.push(sentence.text);
    }
  }
  return leaked;
}

/** 回号一致性核对（bug-00004 未闭环，负责人 2026-09-29 拍板；bug-00057 扩展为多片段）：
 * 回号/回目类问句复核判据显式放行——结论回号与所引任一片段〔出处N〕结构化出处行回号一致 → supported
 * （「首次/最初/最早」是问句口径，不要求单段证明极值）。确定性核对 0 LLM；
 * 结论句无回号（如只写回目名）→ 交复核 LLM（prompt 已补判据 + 示例兜底）。
 * 中文数字 / 阿拉伯数字 / 全角数字统一归一到 int 比较。 */

const CN_NUM_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字 → int（回号 1~120 范围够用；不在此范围的输入返回 null） */
function chineseNumberToInt(text: string): number | null {
  let total = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
    } else if (ch in CN_NUM_DIGITS) {
      current = CN_NUM_DIGITS[ch];
    } else {
      return null;
    }
  }
  return total + current;
}

/** 提取句中首个回号「第N回」并归一到 int；无回号 / 无法解析返回 null。
 * 全角阿拉伯转半角后走 Number；中文数字走 chineseNumberToInt。 */
export function extractChapterNumber(text: string): number | null {
  const match = /第([0-9０-９一二三四五六七八九十百千零〇]+)回/.exec(text);
  if (!match) {
    return null;
  }
  const raw = match[1];
  if (/^[0-9０-９]+$/.test(raw)) {
    const n = Number(raw.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return chineseNumberToInt(raw);
}

/** 回号一致性判据（bug-00057 扩展为多片段）：结论回号与所引任一片段〔出处N〕行回号一致 → "supported"；
 * 结论回号与所有出处行回号都不一致（且至少一行可取到回号）→ "unsupported"；
 * 结论无回号 / 所有出处行都取不到回号（如结论只写回目名）→ null（交复核 LLM 兜底）。 */
export function chapterConsistencyVerdict(
  sentence: string,
  sourceLines: ReadonlyArray<string | null>
): "supported" | "unsupported" | null {
  const sentenceChapter = extractChapterNumber(sentence);
  if (sentenceChapter === null) {
    return null;
  }
  const sourceChapters = sourceLines
    .map((line) => (line ? extractChapterNumber(line) : null))
    .filter((chapter): chapter is number => chapter !== null);
  if (sourceChapters.length === 0) {
    return null;
  }
  return sourceChapters.includes(sentenceChapter) ? "supported" : "unsupported";
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

/** 解析答案里的指针：叙述段 `[片段N]`；未注册返回 null */
function resolvePointerRef(
  ref: string,
  view: InjectionView
): RenderedFragment | null {
  return view.fragments.get(ref) ?? null;
}

/** 服务端渲染引用与出处（feat-A006）：`[片段N]` 指针从 answer 剥离（不输出角标），原文与出处进
 * citations 卡片（不内联原文、不内联出处）；citations 按片段粒度合并（同片段多引用合并为一条），
 * 只收被引用片段；并按回号递增、同回按原文出现先后
 * （chunkSeq → segFrom → segTo）排序后下发——无回号 / 无位置的片段排最后、相互保持引用出现顺序。 */
export function renderAnswerWithCitations(
  answer: string,
  view: InjectionView
): ChatData {
  // 第一遍：按引用出现顺序收集被引用片段（去重）
  const cited: Array<{ fragmentKey: string; fragment: RenderedFragment }> = [];
  const seen = new Set<string>();
  const pointerRe = /\[片段(\d+)\]/g;
  let pointerMatch: RegExpExecArray | null;
  while ((pointerMatch = pointerRe.exec(answer)) !== null) {
    const fragmentKey = `片段${pointerMatch[1]}`;
    if (seen.has(fragmentKey)) {
      continue;
    }
    seen.add(fragmentKey);
    const fragment = resolvePointerRef(fragmentKey, view);
    if (fragment) {
      cited.push({ fragmentKey, fragment });
    }
  }
  // 第二遍：排序（chapter → chunkSeq → segFrom → segTo；排序键缺失的排最后、保持原相对顺序）
  const keyed: Array<{ fragmentKey: string; fragment: RenderedFragment }> = [];
  const unkeyed: Array<{ fragmentKey: string; fragment: RenderedFragment }> = [];
  for (const entry of cited) {
    const { chapter, chunkSeq, segFrom, segTo } = entry.fragment;
    if (
      Number.isFinite(chapter) &&
      (Number.isFinite(chunkSeq) ||
        (Number.isFinite(segFrom) && Number.isFinite(segTo)))
    ) {
      keyed.push(entry);
    } else {
      unkeyed.push(entry);
    }
  }
  keyed.sort(
    (a, b) =>
      a.fragment.chapter! - b.fragment.chapter! ||
      (a.fragment.chunkSeq ?? a.fragment.segFrom ?? 0) -
        (b.fragment.chunkSeq ?? b.fragment.segFrom ?? 0) ||
      (a.fragment.segTo ?? 0) - (b.fragment.segTo ?? 0)
  );
  const ordered = [...keyed, ...unkeyed];
  // 第三遍：剥离所有 `[片段N]` 指针，answer 只留结论正文（不再输出上标角标）
  const rendered = answer.replace(/\[片段\d+\]/g, "");
  const citations: Citation[] = ordered.map(({ fragment }) => ({
    text: fragment.text,
    chapter: fragment.chapter,
    title: fragment.title,
  }));
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
 * 兜底输出（feat-A006 结构化）：不做归纳生成，answer 放结论句（无角标），
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
    answer: conclusionLine,
    citations: [
      {
        text: top.text,
        chapter: top.chapter,
        title: top.title,
      },
    ],
  };
}

/** feat-A017 差异三态（§4.4）：
 * - consistent：发送清单中被结果引用的条目序号（1 基，对应 chunks 下标 + 1）；
 * - missing：清单中未被引用的条目序号；
 * - extra：结果引用但不属于清单的引用（正常恒空；非空即异常信号，页面高亮 / CLI 打 ! 标注，不作静默吞掉）。
 * 单一实现点：判定在服务端生成管线内完成（引用归属片段已知，无需事后文本比对）。
 */
export interface DraftbenchDiff {
  consistent: number[];
  missing: number[];
  extra: Citation[];
}

/**
 * 由「已引用片段的清单下标（0 基）」重算差异三态；citations 与已归属片段数不齐（渲染失配等异常）
 * 时，尾部引用归入 extra 而非静默吞掉。
 */
export function computeDraftbenchDiff(
  citedIndexes: Iterable<number>,
  listLength: number,
  citations: Citation[]
): DraftbenchDiff {
  const cited = new Set<number>();
  for (const raw of citedIndexes) {
    if (Number.isInteger(raw) && raw >= 0 && raw < listLength) {
      cited.add(raw);
    }
  }
  const consistent = [...cited].sort((a, b) => a - b).map((index) => index + 1);
  const missing: number[] = [];
  for (let index = 0; index < listLength; index++) {
    if (!cited.has(index)) {
      missing.push(index + 1);
    }
  }
  const attributable = cited.size;
  const extra =
    citations.length > attributable ? citations.slice(attributable) : [];
  return { consistent, missing, extra };
}
