// feat-A004：《三国演义》原著检索的引用硬校验模块
// 校验规则：答案断言人物集合（ID 级）⊆ 召回原文人物集合（ID 级），不成立走兜底。
// 人物 ID 化：别名表（封闭集合）优先，未命中走全量 NER；无 ID 的次要人物退化为字符串包含校验。
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

export type PersonNameExtractor = (text: string) => Promise<string[]>;
export type NERIdResolver = (name: string) => Promise<string[]>;

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

/** 单个人名解析：别名表（封闭集合）命中优先；未命中走全量 NER 生成候选，取首个 ID */
export async function resolvePersonName(
  name: string,
  aliasTable: Map<string, string>,
  nerResolver: NERIdResolver
): Promise<PersonMention> {
  const aliasId = aliasTable.get(name);
  if (aliasId) {
    return { name, id: aliasId };
  }
  const candidates = await nerResolver(name);
  return { name, id: candidates[0] ?? undefined };
}

/** 从答案识别断言人物集合（ID 级）：模型提取人名 → 别名表优先 → 未命中走 NER */
export async function buildAssertedPersons(
  answer: string,
  aliasTable: Map<string, string>,
  extractNames: PersonNameExtractor,
  nerResolver: NERIdResolver
): Promise<PersonMention[]> {
  const names = await extractNames(answer);
  const mentions: PersonMention[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    mentions.push(await resolvePersonName(trimmed, aliasTable, nerResolver));
  }
  return mentions;
}

/** 集合包含判定：断言人物集合（ID 级）⊆ 召回原文人物集合（ID 级）。
 * 别名表未命中且 NER 未给 ID 的次要人物退化为字符串包含校验（名字出现在召回原文即通过），避免误杀小配角。 */
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

/** 兜底输出：不做归纳生成，只输出「原文片段 + 出处」并补一句结论归纳 */
export function buildFallback(
  fragments: RecallFragment[],
  conclusion: string
): string {
  const conclusionLine = conclusion.startsWith("按原文")
    ? conclusion
    : `按原文，${conclusion}`;
  const blocks = fragments.map(
    (fragment) => `${fragment.text}\n（出处：${fragment.source}）`
  );
  return ["【原文片段】", ...blocks, "", conclusionLine].join("\n");
}
