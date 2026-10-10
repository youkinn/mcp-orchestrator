import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOVEL_NO_HIT_ANSWER,
  SENTENCE_OVERLAP_NGRAM,
  SENTENCE_OVERLAP_THRESHOLD,
  buildFallback,
  buildInjectionView,
  buildSourceLine,
  chapterConsistencyVerdict,
  extractChapterNumber,
  findChapterLeakSentences,
  findLowOverlapSentences,
  loadAliasTable,
  pickBestFallbackFragment,
  renderAnswerWithCitations,
  scanRecallPersonIds,
  sentenceFragmentOverlap,
  splitAnswerSentences,
  stripLowOverlapSentences,
  toRecallFragments,
  validateFragmentPointers,
  verifyCitation,
  type InjectionView,
} from "../../citation.js";


test("① 别名表加载：路径指向真实 JSON 时读取生效（含 关羽=P002）", () => {
  const dir = mkdtempSync(join(tmpdir(), "a004-alias-"));
  const file = join(dir, "alias.json");
  writeFileSync(
    file,
    JSON.stringify({ 关羽: "P002", 云长: "P002", 关云长: "P002", 曹操: "P001" }),
    "utf8"
  );
  try {
    const table = loadAliasTable(file);
    assert.equal(table.get("关羽"), "P002");
    assert.equal(table.get("云长"), "P002");
    assert.equal(table.get("关云长"), "P002");
    assert.equal(table.get("曹操"), "P001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("② 别名表加载：文件未产出时回落本地 stub，且契约含核心人物", () => {
  const table = loadAliasTable(join(tmpdir(), "a004-not-exist", "alias.json"));
  assert.equal(table.get("关羽"), "P002");
  assert.equal(table.get("云长"), "P002");
  assert.equal(table.get("美髯公"), "P002");
  assert.equal(table.get("曹操"), "P001");
  assert.ok(table.size > 0, "stub 不应为空");
});

test("③ 召回侧 ID 化：扫描召回原文中的别名 → 规范 ID 集合", () => {
  const table = loadAliasTable("missing-file");
  const recall = "第五回：云长提刀出阵，温酒斩华雄。";
  const ids = scanRecallPersonIds(recall, table);
  assert.ok(ids.has("P002"), "云长 → P002（关羽）");
  assert.ok(ids.has("P013"), "华雄 → P013");
  assert.equal(ids.has("P001"), false, "原文未提曹操，不应命中 P001");
});

test("⑦ 集合包含判定·通过：断言人物 ⊆ 召回人物", () => {
  const table = loadAliasTable("missing-file");
  const recall = "云长斩华雄";
  const recallIds = scanRecallPersonIds(recall, table);
  const result = verifyCitation(
    [
      { name: "关羽", id: "P002" },
      { name: "华雄", id: "P013" },
    ],
    recall,
    recallIds
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.unverified, []);
});

test("⑧ 集合包含判定·不通过：断言出现召回原文没有的人物", () => {
  const table = loadAliasTable("missing-file");
  const recall = "云长斩华雄";
  const recallIds = scanRecallPersonIds(recall, table);
  const result = verifyCitation(
    [
      { name: "曹操", id: "P001" },
      { name: "关羽", id: "P002" },
    ],
    recall,
    recallIds
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unverified, [{ name: "曹操", id: "P001" }]);
});

test("⑨ 字符串退化·通过：次要人物名字出现在召回原文即通过", () => {
  const result = verifyCitation(
    [{ name: "潘凤", id: undefined }],
    "潘凤手提大斧而出。",
    new Set<string>()
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.unverified, []);
});

test("⑩ 字符串退化·不通过：次要人物名字未出现在召回原文则判不成立", () => {
  const result = verifyCitation(
    [{ name: "潘凤", id: undefined }],
    "云长斩华雄。",
    new Set<string>()
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unverified, [{ name: "潘凤", id: undefined }]);
});

test("⑪ 兜底输出（A006 结构化）：answer 纯结论句（无角标），citations 恰一条兜底片段（整段原文）", () => {
  const out = buildFallback(
    [
      {
        text: "云长提刀出阵，斩华雄于帐前。",
        source: "sanguo-yanyi",
        chapter: 5,
        title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      },
    ],
    "斩华雄者系关羽"
  );
  assert.equal(out.answer, "按原文，斩华雄者系关羽");
  assert.deepEqual(out.citations, [
    {
      text: "云长提刀出阵，斩华雄于帐前。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    },
  ]);
  assert.equal(out.citations.length, 1, "兜底恰一条，禁止多段拼刷");
  assert.doesNotMatch(out.answer, /段\d/, "answer 不展示段号");
  assert.doesNotMatch(out.answer, /（出处/, "answer 不再内联出处");
});

test("⑫ 检索无命中固定话术", () => {
  assert.equal(NOVEL_NO_HIT_ANSWER, "演义中未涉及");
});

test("⑬ 注入视图只给纯原文 + 服务端编号：片段带 [片段N]，不带回目/段号/分数", () => {
  const fragment = {
    text: "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”",
    source: "sanguo-yanyi",
    chapter: 73,
    title: "玄德进位汉中王　云长攻拔襄阳郡",
    segFrom: 5,
    segTo: 5,
  };
  const view = buildInjectionView([fragment]);
  assert.match(view.text, /\[片段1\]/);
  assert.match(
    view.text,
    /〔出处1〕第73回 玄德进位汉中王　云长攻拔襄阳郡/,
    "结构化出处行放出回号+回目名（bug-00004 方案 C）"
  );
  assert.doesNotMatch(
    view.text.replace(/〔出处\d+〕第\d+回[^\n]*/g, ""),
    /第73回/,
    "正文仍为纯原文：回号只出现在结构化出处行"
  );
  assert.doesNotMatch(view.text, /·\s*段\d/, "注入不带段号");
  assert.doesNotMatch(view.text, /分数|score/i, "注入不带分数");
  assert.equal(view.fragments.size, 1, "片段表应含该片段");
  assert.equal(view.fragments.get("片段1")?.text, fragment.text, "片段表保存整段原文");
  assert.equal(view.fragments.get("片段1")?.segFrom, 5, "片段表保留 segFrom 供引用排序");
  assert.equal(view.fragments.get("片段1")?.segTo, 5, "片段表保留 segTo 供引用排序");
});

test("⑬.1 整段注入：长段原文完整可见（不再按检索词窗口裁剪）", () => {
  const filler = "先叙无关内容。".repeat(40);
  const fragment = {
    text: `${filler}云长怒曰：“吾虎女安肯嫁犬子乎！”`,
    source: "sanguo-yanyi",
    chapter: 73,
  };
  const view = buildInjectionView([fragment], "云长怒曰");
  assert.ok(view.text.includes(filler), "整段注入：前 5 段不再做窗口裁剪");
  assert.ok(view.text.includes("云长怒曰：“吾虎女安肯嫁犬子乎！”"), "原文整体可见");
});

test("⑬.2 注入编号连续无空洞：整段注入下跨片段编号紧邻（bug-00009 回归）", () => {
  const fragments = [
    {
      text: "祖茂曰：“主公头上赤帻射目，可脱帻与某戴之。”是夜孙坚正遇华雄，两马相交。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    },
    {
      text: "关公曰：“酒且斟下，某去便来。”出帐提刀，飞身上马。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    },
    {
      text: "太守韩馥曰：“吾有上将潘凤，可斩华雄。”绍急令出战。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    },
  ];
  const view = buildInjectionView(fragments, "华雄是怎么死的");
  assert.deepEqual(
    [...view.fragments.keys()],
    ["片段1", "片段2", "片段3"],
    "整段注入后可见编号连续，不得留下空洞"
  );
  assert.match(view.text, /\[片段2\] 关公曰：/, "证据段整段注入可见");
});

test("⑬.3 注入策略（2026-09-20 定稿）：前 5 段整段保底，证据段排 #5 仍注入，整段叙述不走指针也可被归纳", () => {
  const filler = "无关内容。".repeat(30);
  const fragments = [
    { text: `宋宪告布曰：“买马被张飞劫走。”${filler}`, source: "sanguo-yanyi", chapter: 16, title: "吕奉先射戟辕门　曹孟德败师淯水" },
    { text: `张飞与马超斗百余合。${filler}`, source: "sanguo-yanyi", chapter: 65, title: "马超大战葭萌关　刘备自领益州牧" },
    { text: `玄德望见马超阵上人马皆倦。${filler}`, source: "sanguo-yanyi", chapter: 65, title: "马超大战葭萌关　刘备自领益州牧" },
    { text: `曹操回顾左右曰：“翼德百万军中取上将之首”。${filler}`, source: "sanguo-yanyi", chapter: 42, title: "张翼德大闹长坂桥　刘豫州败走汉津口" },
    {
      text: "范、张二贼，密入帐中，直至床前。张飞每睡不合眼；二贼以短刀刺入飞腹。飞大叫一声而亡。时年五十五。",
      source: "sanguo-yanyi",
      chapter: 81,
      title: "急兄仇张飞遇害　雪弟恨先主兴兵",
    },
    { text: `张飞怒鞭督邮。${filler}`, source: "sanguo-yanyi", chapter: 2, title: "张翼德怒鞭督邮　何国舅谋诛宦竖" },
  ];
  const view = buildInjectionView(fragments, "张飞怎么死的");
  assert.ok(view.text.includes("[片段5]"), "注入上限放宽到 10：第 5 段应注入");
  assert.ok(view.text.includes("范、张二贼，密入帐中"), "证据段叙述整体可见，模型可据此归纳");
  assert.equal(view.fragments.size, 6, "全部 6 段均在注入上限内");
});

test("⑬.4 注入策略：tailFallback=true 时前 5 段整段保底 + 第 6+ 段预算内整段纳入", () => {
  const make = (i: number) => ({
    text: `第${i}段。`.repeat(10),
    source: "sanguo-yanyi",
    chapter: i,
    title: `回目${i}`,
  });
  const fragments = Array.from({ length: 8 }, (_, i) => make(i + 1));
  const view = buildInjectionView(fragments, "问句", true);
  assert.ok(view.text.includes(`[片段5]`), "前 5 段保底注入");
  assert.ok(view.text.includes(`[片段6]`), "预算充足时第 6 段整段纳入兜底");
  assert.ok(view.text.includes("第6段。".repeat(10)), "尾部段整段注入，不裁剪");
  assert.equal(view.fragments.size, 8, "8 段均在预算内 → 全部注入");
});

test("⑬.5 注入策略：预算不足时丢整段，绝不裁半段", () => {
  const make = (i: number, len: number) => ({
    text: "甲".repeat(len),
    source: "sanguo-yanyi",
    chapter: i,
    title: `回目${i}`,
  });
  // 前 5 段每段 100 字；第 6 段极长（3000 字）远超总预算 2000
  const fragments = [
    ...Array.from({ length: 5 }, (_, i) => make(i + 1, 100)),
    make(6, 3000),
    make(7, 100),
  ];
  const view = buildInjectionView(fragments, "问句", true);
  assert.ok(view.text.includes(`[片段5]`), "前 5 段保底仍注入");
  assert.ok(!view.text.includes(`[片段6]`), "第 6 段超预算 → 整体丢弃");
  assert.ok(!view.text.includes("甲".repeat(3000)), "超预算段不得以半段形式注入");
  assert.ok(!view.text.includes(`[片段7]`), "预算被超则停止，不再看后续段");
  assert.equal(view.fragments.size, 5);
});

test("⑬.6 开关关闭（tailFallback=false）：固定只注入前 5 段整段，不注入第 6+ 段", () => {
  const make = (i: number) => ({
    text: `第${i}段。`.repeat(10),
    source: "sanguo-yanyi",
    chapter: i,
    title: `回目${i}`,
  });
  const fragments = Array.from({ length: 8 }, (_, i) => make(i + 1));
  const view = buildInjectionView(fragments, "问句", false);
  assert.ok(view.text.includes(`[片段5]`), "关闭兜底时前 5 段仍整段注入");
  assert.ok(!view.text.includes(`[片段6]`), "关闭兜底时第 6 段不注入");
  assert.ok(!view.text.includes("第6段。".repeat(10)), "第 6 段内容不在注入视图内");
  assert.equal(view.fragments.size, 5);
});

test("⑭ buildFallback 只输出最符合的一段：citations 恰一条，不拼刷多段", () => {
  const out = buildFallback(
    [
      {
        text: "孙权遣人向关羽求亲，关羽怒曰“吾虎女安肯嫁犬子乎！”",
        source: "sanguo-yanyi",
        chapter: 73,
        title: "玄德进位汉中王　云长攻拔襄阳郡",
      },
      {
        text: "却说章武元年秋八月，先主起大军至夔关。",
        source: "sanguo-yanyi",
        chapter: 82,
        title: "孙权降魏受九锡　先主征吴赏六军",
      },
    ],
    "关羽怒斥求亲使者",
    "孙权遣人向关羽求亲，关羽是怎么回复使者的"
  );
  assert.equal(out.answer, "按原文，关羽怒斥求亲使者");
  assert.equal(out.citations.length, 1, "兜底恰一条，禁止多段拼刷");
  assert.ok(out.citations[0].text.includes("吾虎女安肯嫁犬子乎"), "应输出最符合一段的原文");
  assert.ok(!out.citations[0].text.includes("章武元年"), "不应输出第二段全文");
  assert.equal(out.citations[0].chapter, 73);
  assert.equal(out.citations[0].title, "玄德进位汉中王　云长攻拔襄阳郡");
});

test("⑭.1 兜底选段不盲取 fragments[0]：干扰段在前时按结论人物锚定证据段（bug-00009）", () => {
  const out = buildFallback(
    [
      {
        text: "是夜月白风清。孙坚正遇华雄，两马相交，斗不数合。",
        source: "sanguo-yanyi",
        chapter: 5,
        title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      },
      {
        text: "众将见云长提华雄之头，掷于地上。其酒尚温。",
        source: "sanguo-yanyi",
        chapter: 5,
        title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      },
    ],
    "被关羽所杀",
    "华雄是怎么死的"
  );
  assert.ok(
    out.citations[0].text.includes("云长提华雄之头"),
    "应输出证据段（结论人物覆盖）而非 fragments[0]"
  );
  assert.ok(
    !out.citations[0].text.includes("是夜月白风清"),
    "孙坚夜战干扰段不得作为兜底片段"
  );
});

test("⑭.2 兜底选段：结论无人物时按 query 锚点稀有度（同段命中次数少者优先）", () => {
  const top = pickBestFallbackFragment(
    [
      {
        text: "孙坚夜战华雄，华雄追来，华雄躲过三箭。",
        source: "sanguo-yanyi",
        chapter: 5,
      },
      {
        text: "云长提华雄之头，掷于地上。",
        source: "sanguo-yanyi",
        chapter: 5,
      },
    ],
    "华雄是怎么死的",
    "被斩于帐前"
  );
  assert.ok(top.text.includes("云长提华雄之头"), "华雄只出现 1 次的片段更稀有，应胜出");
});

test("⑮ 指针校验：至少含一个指针，且指针全部 ∈ 本次注入片段编号集合才通过，缺指针 / 越界指针一律不通过", () => {
  const injected = new Map([
    ["片段5", { text: "范、张二贼，密入帐中，以短刀刺入飞腹。", chapter: 81, title: "急兄仇张飞遇害　雪弟恨先主兴兵" }],
  ]);
  const ok = validateFragmentPointers("张飞被范疆、张达刺死。[片段5]", injected);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.pointers, ["片段5"]);
  assert.deepEqual(ok.invalid, []);

  const missing = validateFragmentPointers("关羽拒绝了孙权的联姻。", injected);
  assert.equal(missing.ok, false, "无指针即不合法（禁止无出处结论）");

  const outOfRange = validateFragmentPointers("张飞被害[片段9]", injected);
  assert.equal(outOfRange.ok, false, "片段编号不在注入集合内即不合法");
  assert.deepEqual(outOfRange.invalid, ["片段9"]);
});

test("⑯.2 叙述段指针：`[片段N]` 从 answer 剥离（不内联原文），citations 收录该片段（bug-00009 张飞题）", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      [
        "片段5",
        {
          text: "范、张二贼，密入帐中，以短刀刺入飞腹。飞大叫一声而亡。",
          chapter: 81,
          title: "急兄仇张飞遇害　雪弟恨先主兴兵",
        },
      ],
    ]),
  };
  const out = renderAnswerWithCitations("张飞被范疆、张达刺死。[片段5]", view);
  assert.equal(out.answer, "张飞被范疆、张达刺死。");
  assert.doesNotMatch(out.answer, /密入帐中/, "叙述段指针不内联片段原文");
  assert.deepEqual(out.citations, [
    {
      text: "范、张二贼，密入帐中，以短刀刺入飞腹。飞大叫一声而亡。",
      chapter: 81,
      title: "急兄仇张飞遇害　雪弟恨先主兴兵",
    },
  ]);
  assert.doesNotMatch(out.answer, /\[片段5\]/, "指针已渲染替换");
});

test("⑯.3 片段粒度合并：同一片段被多次引用 → 一条 citation", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      [
        "片段1",
        {
          text: "云长曰：“吾虎女安肯嫁犬子乎！”",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
    ]),
  };
  const out = renderAnswerWithCitations("关羽怒拒[片段1]，并再次拒绝[片段1]。", view);
  assert.equal(out.answer, "关羽怒拒，并再次拒绝。");
  assert.equal(out.citations.length, 1, "同片段多引用合并为一条");
  assert.deepEqual(out.citations[0], {
    text: "云长曰：“吾虎女安肯嫁犬子乎！”",
    chapter: 73,
    title: "玄德进位汉中王　云长攻拔襄阳郡",
  });
});

test("⑯.4 引用排序·跨回：citations 按回号递增排序下发，answer 指针剥离", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      [
        "片段1",
        {
          text: "云长勃然大怒曰：“吾虎女安肯嫁犬子乎！……”",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
          segFrom: 5,
          segTo: 5,
        },
      ],
      [
        "片段2",
        {
          text: "庞德曰：“吾奉魏王旨，特来取汝首！恐汝不信，备榇在此。”",
          chapter: 42,
          title: "张翼德大闹长坂桥　刘豫州败走汉津口",
          segFrom: 3,
          segTo: 3,
        },
      ],
    ]),
  };
  const out = renderAnswerWithCitations("关羽怒拒[片段1]；庞德扬言[片段2]。", view);
  assert.equal(out.answer, "关羽怒拒；庞德扬言。");
  assert.equal(out.citations.length, 2);
  assert.deepEqual(out.citations, [
    {
      text: "庞德曰：“吾奉魏王旨，特来取汝首！恐汝不信，备榇在此。”",
      chapter: 42,
      title: "张翼德大闹长坂桥　刘豫州败走汉津口",
    },
    {
      text: "云长勃然大怒曰：“吾虎女安肯嫁犬子乎！……”",
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
    },
  ]);
});

test("⑯.7 引用排序·同回：按 segFrom → segTo 原文出现先后排序", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      ["片段1", { text: "后段原文", chapter: 5, title: "回目五", segFrom: 5, segTo: 5 }],
      ["片段2", { text: "前段原文", chapter: 5, title: "回目五", segFrom: 2, segTo: 3 }],
    ]),
  };
  const out = renderAnswerWithCitations("先引[片段1]，后引[片段2]。", view);
  assert.equal(out.answer, "先引，后引。", "同回按原文序排列 citations");
  assert.deepEqual(
    out.citations.map((c) => c.text),
    ["前段原文", "后段原文"]
  );
});

test("⑯.9 引用排序·同回同段：segFrom/segTo 相同时按 chunkSeq（chunk id 章内序号）排序", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      // c0003 劫营段、c0002 请命段同在第68回段1（segFrom=segTo=1），键值相同
      ["片段1", { text: "劫营段", chapter: 68, title: "回目六八", chunkSeq: 3, segFrom: 1, segTo: 1 }],
      ["片段2", { text: "诗赞段", chapter: 68, title: "回目六八", chunkSeq: 4, segFrom: 2, segTo: 2 }],
      ["片段3", { text: "请命段", chapter: 68, title: "回目六八", chunkSeq: 2, segFrom: 1, segTo: 1 }],
    ]),
  };
  const out = renderAnswerWithCitations("劫[片段1]，赞[片段2]，请[片段3]。", view);
  assert.equal(out.answer, "劫，赞，请。", "同段按 chunkSeq 原文序排列 citations");
  assert.deepEqual(
    out.citations.map((c) => c.text),
    ["请命段", "劫营段", "诗赞段"]
  );
});

test("⑯.8 引用排序·键缺失：无 chapter/segFrom/segTo 的片段排最后，且相互保持引用出现顺序", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      ["片段1", { text: "无键甲", title: "回目甲" }],
      ["片段2", { text: "有键片段", chapter: 3, title: "回目三", segFrom: 1, segTo: 1 }],
      ["片段3", { text: "无键乙", title: "回目乙" }],
    ]),
  };
  const out = renderAnswerWithCitations("一[片段1]，二[片段2]，三[片段3]。", view);
  assert.equal(out.answer, "一，二，三。", "有键片段排前，无键片段按引用出现顺序排后");
  assert.deepEqual(
    out.citations.map((c) => c.text),
    ["有键片段", "无键甲", "无键乙"]
  );
});

test("⑯.5 只收被引用片段：注入 3 段只引 2 段 → citations 恰 2 条，未引段不收录", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([
      ["片段1", { text: "片段甲原文", chapter: 1, title: "回目甲" }],
      ["片段2", { text: "片段乙原文", chapter: 2, title: "回目乙" }],
      ["片段3", { text: "片段丙原文", chapter: 3, title: "回目丙" }],
    ]),
  };
  const out = renderAnswerWithCitations("引用[片段1]，再引[片段3]。", view);
  assert.equal(out.answer, "引用，再引。");
  assert.equal(out.citations.length, 2, "未被引用的片段2 不得收录");
  assert.deepEqual(
    out.citations.map((item) => item.text),
    ["片段甲原文", "片段丙原文"]
  );
});

test("⑯.6 无引用恒 []：answer 无指针时 citations 为空、answer 原样", () => {
  const view: InjectionView = {
    text: "",
    fragments: new Map([["片段1", { text: "片段甲原文", chapter: 1, title: "回目甲" }]]),
  };
  const answer = "演义中未涉及。";
  const out = renderAnswerWithCitations(answer, view);
  assert.equal(out.answer, answer);
  assert.deepEqual(out.citations, []);
});

test("⑱ 出参解析：裸数组条目逐条走字段，正文只留纯原文（出处 / 段号 / 分数不进正文）", () => {
  const entries = JSON.stringify([
    {
      id: "sanguo-yanyi:0073:c0007",
      text: "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”",
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
      type: "narration",
      segFrom: 5,
      segTo: 5,
    },
    {
      id: "sanguo-yanyi:0082:c0001",
      text: "却说章武元年秋八月，先主起大军至夔关。",
      chapter: 82,
      title: "孙权降魏受九锡　先主征吴赏六军",
      type: "narration",
      segFrom: 1,
      segTo: 1,
    },
  ]);
  const [entry, second] = toRecallFragments([entries], "sanguo-yanyi");
  assert.equal(entry.chapter, 73);
  assert.equal(entry.title, "玄德进位汉中王　云长攻拔襄阳郡");
  assert.equal(entry.segFrom, 5, "segFrom 随条目带出，供引用排序");
  assert.equal(entry.segTo, 5, "segTo 随条目带出，供引用排序");
  assert.doesNotMatch(entry.text, /【出处】/, "正文只留纯原文（I6）");
  assert.doesNotMatch(entry.text, /段5/, "段号走字段，不进正文");
  assert.equal(second.chapter, 82, "跨回召回时出处逐条渲染（文档级元数据不存在）");
  assert.equal(second.title, "孙权降魏受九锡　先主征吴赏六军");
  assert.equal(second.segFrom, 1, "segFrom 逐条带出");
});

test("⑱.1 出参解析：非裸数组（旧拼接文本 / 包裹对象 / 非法 JSON）不产出片段", () => {
  assert.deepEqual(
    toRecallFragments(
      ["【出处】第73回 玄德进位汉中王 云长攻拔襄阳郡 · 段5（叙述）\n孙权遣人向关羽求亲。"],
      "sanguo-yanyi"
    ),
    [],
    "旧拼接文本无生产者，不再兼容"
  );
  assert.deepEqual(
    toRecallFragments([JSON.stringify({ chunks: [] })], "sanguo-yanyi"),
    [],
    "包裹对象不存在，只有裸数组"
  );
  assert.deepEqual(toRecallFragments(["{ 不是 JSON"], "sanguo-yanyi"), []);
  assert.deepEqual(toRecallFragments(["[]"], "sanguo-yanyi"), []);
});

// ===== bug-00028 结构保险丝：结构门第三条「句-片段文本重叠」——纯函数级用例 =====
// bug-00032/33/34 后重叠门为「低重叠 → 边界语义复核」（复核在 agent.ts，正常样本零调用）；
// 本组只测纯函数（citation.ts）：归一化 / 重叠率 / 低重叠句挑选 / 字面裁剪边界
// （sentenceFragmentOverlap / findLowOverlapSentences / stripLowOverlapSentences）。

test("⑳ 结构门·重叠率：句子 2-gram 命中片段的比例（全文重合 → 1；无关句 → 0）", () => {
  assert.equal(
    sentenceFragmentOverlap("夏侯惇字元让。", "夏侯惇字元让，沛国谯人也。"),
    1,
    "句子 2-gram 全部命中片段"
  );
  assert.equal(
    sentenceFragmentOverlap("刘备死的时候六十三岁。", "孙权闻玄德与孙夫人已去，急召周瑜商议。"),
    0,
    "答案断言与片段零字面重叠"
  );
});

test("⑳.1 结构门·归一化：全角数字转半角、标点空白剔除", () => {
  assert.equal(sentenceFragmentOverlap("５５", "55"), 1, "全角数字转半角后同形");
  assert.equal(
    sentenceFragmentOverlap(
      "关公曰：“酒且斟下，某去便来。”出帐提刀。",
      "关公曰：“酒且斟下，某去便来。”出帐提刀，飞身上马。"
    ),
    1,
    "标点剔除后，叙述部分与片段同形"
  );
  assert.ok(
    sentenceFragmentOverlap("张飞遇害时年55岁。", "时年五十五。") < SENTENCE_OVERLAP_THRESHOLD,
    "「五十五」与「55」字面不同形 → 低重叠（语义等价不在纯文本判定职责，由边界语义复核裁决）"
  );
});

test("⑳.2 结构门·裁剪边界：重叠 ≥ 阈值保留、< 阈值整句裁剪、全裁空串（调用方拒答）", () => {
  const view = buildInjectionView([
    {
      text: "马超与张飞在葭萌关前大战，玄德在城上观战。自白日战至夜，不分胜负。",
      source: "s",
      chapter: 65,
      title: "马超大战葭萌关　刘备自领益州牧",
    },
    {
      text: "袁绍聚众官于帐中，商议起兵。",
      source: "s",
      chapter: 9,
      title: "除暴凶吕布助司徒　犯长安李傕听贾诩",
    },
  ]);
  // 高于阈值放行：原样保留
  assert.equal(
    stripLowOverlapSentences("马超与张飞在葭萌关前大战百余合，不分胜负。[片段1]", view),
    "马超与张飞在葭萌关前大战百余合，不分胜负。[片段1]",
    "重叠 ≥ 阈值 → 完整保留"
  );
  // 低于阈值裁剪：整句连同指针移除
  assert.equal(
    stripLowOverlapSentences("马超后来投靠了袁绍。[片段2]", view),
    "",
    "重叠 < 阈值 → 整句裁剪，返回空串（调用方据此拒答）"
  );
  // 混合：高低各一句 → 只留高重叠句
  assert.equal(
    stripLowOverlapSentences(
      "马超与张飞在葭萌关前大战百余合，不分胜负。[片段1] 马超后来投靠了袁绍。[片段2]",
      view
    ),
    "马超与张飞在葭萌关前大战百余合，不分胜负。[片段1]",
    "低重叠句被裁、高重叠句保留"
  );
});

test("⑳.3 结构门·阈值常量：0.5 默认从严（低于裁剪 / 高于放行的分界），n-gram 取 2", () => {
  assert.equal(SENTENCE_OVERLAP_THRESHOLD, 0.5, "阈值常量默认 0.5（Coco 定稿，先从严测边界）");
  assert.equal(SENTENCE_OVERLAP_NGRAM, 2, "n-gram 长度默认 2（可对比 3-gram 调参）");
});

// ===== bug-00044 结构门缺陷：结论句 + 换行 [片段N] 被误裁拒答（trace 46dbc882）=====
// 根因：splitAnswerSentences 把「结论句。\n\n[片段7]」切成结论句（无指针）+ 独立指针行；
// 独立指针行被 bug-00038 豁免剔除 → 结论句变无指针叙述句 → 对全部注入片段取字面重叠最高者
// 作复核参考（错配成无关片段）→ judge 误判 unsupported → 整句裁剪 → 拒答。修复：切句后
// 后处理——纯指针行并入前一句，指针随文本归属前句；孤儿指针行（无前正文）保持原样。

test("⑳.4 结构门·bug-00044 切句后处理：结论句 + 换行 [片段N] 合并为一句且指针随文本归属前句", () => {
  const sentences = splitAnswerSentences(
    "黄巾起义是张角兄弟发动的、以黄巾裹头为标志的民变。\n\n[片段7]"
  );
  assert.equal(sentences.length, 1, "结论句 + 独立指针行合并为 1 句，不再切成无指针句 + 指针行");
  assert.deepEqual(sentences[0].narrativePointers, ["片段7"], "指针随文本归属前句（从合并后整句文本提取）");
  assert.equal(
    sentences[0].text,
    "黄巾起义是张角兄弟发动的、以黄巾裹头为标志的民变。\n\n[片段7]",
    "合并仅拼接原文本，不改写正文"
  );
});

test("⑳.5 结构门·bug-00044 孤儿指针行：无前正文的纯指针行保持原样（bug-00038 拒答路径不变）", () => {
  const sentences = splitAnswerSentences("\n[片段7]");
  assert.equal(sentences.length, 1, "孤儿指针行仍为独立 1 句");
  assert.deepEqual(sentences[0].narrativePointers, ["片段7"], "仍是带指针的句子");
  assert.equal(sentences[0].text, "\n[片段7]", "文本原样，不并入、不删除");
  const view = buildInjectionView([
    {
      text: "张角传檄四方，旬日之间，天下响应，兵至数十万。",
      source: "sanguo-yanyi",
    },
  ]);
  assert.deepEqual(findLowOverlapSentences("\n[片段7]", view), [], "纯指针句不进复核候选（正文判空路径不变）");
  assert.equal(stripLowOverlapSentences("\n[片段7]", view), "\n[片段7]", "字面裁剪不对孤儿指针行动手");
});

test("⑳.6 结构门·bug-00044 低重叠结论复核参考：合并后 bestFragmentText 取结论所引片段原文，不再错配无关片段", () => {
  // 注入 7 段：片段4 是与结论字面重叠最高的干扰段（旧逻辑错配成复核参考），
  // 片段7 才是结论实际所引的片段（低重叠）——合并后只按所引指针取参考
  const view = buildInjectionView([
    { text: "曹操于官渡大破袁绍，尽收冀州之地。", source: "sanguo-yanyi" },
    { text: "刘备三顾茅庐，诸葛亮隆中对策。", source: "sanguo-yanyi" },
    { text: "周瑜火烧赤壁，曹军大败北还。", source: "sanguo-yanyi" },
    { text: "黄巾起义，以黄巾裹头为号。", source: "sanguo-yanyi" },
    { text: "关羽千里走单骑，过五关斩六将。", source: "sanguo-yanyi" },
    { text: "赵云长坂坡七进七出，救出阿斗。", source: "sanguo-yanyi" },
    { text: "张角传檄四方，旬日之间，天下响应，兵至数十万。", source: "sanguo-yanyi" },
  ]);
  const answer = "黄巾起义是张角兄弟发动的、以黄巾裹头为标志的民变。\n\n[片段7]";
  const low = findLowOverlapSentences(answer, view);
  assert.equal(low.length, 1, "合并后仅结论句 1 个低重叠候选（指针行已并入，不再单独成句）");
  assert.deepEqual(low[0].pointers, ["片段7"], "候选带所引片段指针");
  assert.ok(low[0].bestOverlap < SENTENCE_OVERLAP_THRESHOLD, "与所引片段仍低重叠 → 走边界语义复核路径");
  assert.deepEqual(
    low[0].referenceFragments.map((fragment) => fragment.text),
    ["张角传檄四方，旬日之间，天下响应，兵至数十万。"],
    "复核参考取结论所引片段（片段7）原文，而非字面重叠最高的无关片段（片段4）"
  );
});

// ===== bug-00004 方案 C：结构化出处行（回号类问句放开回号+回目名，段号仍不放）=====

test("㉑ bug-00004 buildSourceLine：仅 chapter/title 齐全时输出〔出处N〕第N回 回目名，否则 null", () => {
  assert.equal(
    buildSourceLine("片段1", 73, "玄德进位汉中王　云长攻拔襄阳郡"),
    "〔出处1〕第73回 玄德进位汉中王　云长攻拔襄阳郡",
    "编号 N 与片段号一致"
  );
  assert.equal(buildSourceLine("片段1", undefined, "回目"), null, "缺 chapter 不输出");
  assert.equal(buildSourceLine("片段1", 73, undefined), null, "缺 title 不输出");
  assert.equal(buildSourceLine("片段X", 73, "回目"), null, "非 片段N 键不输出");
});

test("㉑.1 bug-00004 buildInjectionView：多片段各附结构化出处行，正文仍为纯原文（回号只出现在结构化行）", () => {
  const view = buildInjectionView([
    {
      text: "玄德遂与关、张二人结为兄弟，誓同生死。",
      source: "sanguo-yanyi",
      chapter: 1,
      title: "宴桃园豪杰三结义　斩黄巾英雄首立功",
    },
    {
      text: "吕布出阵搦战，张飞挺矛直取，关羽舞刀夹攻，玄德掣双股剑助战。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    },
    {
      text: "孔明奄然归天，姜维等悲恸不已。",
      source: "sanguo-yanyi",
      // 无 chapter/title：不出结构化行，正文照常注入
    },
  ]);
  assert.match(
    view.text,
    /\[片段1\] 玄德遂与关、张二人结为兄弟，誓同生死。\n〔出处1〕第1回 宴桃园豪杰三结义　斩黄巾英雄首立功/,
    "片段1 附出处行（回号+回目名）"
  );
  assert.match(
    view.text,
    /〔出处2〕第5回 发矫诏诸镇应曹公　破关兵三英战吕布/,
    "片段2 附出处行（回号+回目名）"
  );
  assert.ok(!view.text.includes("〔出处3〕"), "无 chapter/title 的片段不出结构化行");
  const body = view.text.replace(/〔出处\d+〕第\d+回[^\n]*/g, "");
  assert.doesNotMatch(body, /第1回|第5回/, "正文仍为纯原文：回号只出现在结构化出处行");
  assert.doesNotMatch(body, /宴桃园豪杰三结义|三英战吕布/, "正文不含回目名");
});

test("㉑.2 bug-00004 findChapterLeakSentences：非回号类问句结论含「第N回」或回目名 → 确定性裁剪候选（0 LLM）", () => {
  const view = buildInjectionView([
    {
      text: "玄德遂与关、张二人结为兄弟，誓同生死。",
      source: "sanguo-yanyi",
      chapter: 1,
      title: "宴桃园豪杰三结义　斩黄巾英雄首立功",
    },
  ]);
  assert.deepEqual(
    findChapterLeakSentences("关羽的武器是青龙偃月刀。", view),
    [],
    "普通结论不含回号/回目名 → 不裁剪"
  );
  assert.deepEqual(
    findChapterLeakSentences("关羽的武器是青龙偃月刀，出自第一回。[片段1]", view),
    ["关羽的武器是青龙偃月刀，出自第一回。[片段1]"],
    "结论含中文回号 → 命中（整句连同指针）"
  );
  assert.deepEqual(
    findChapterLeakSentences("这个说法见于第104回。[片段1]", view),
    ["这个说法见于第104回。[片段1]"],
    "结论含阿拉伯回号 → 命中"
  );
  assert.deepEqual(
    findChapterLeakSentences("关羽的武器是青龙偃月刀，见宴桃园豪杰三结义斩黄巾英雄首立功一回。[片段1]", view),
    ["关羽的武器是青龙偃月刀，见宴桃园豪杰三结义斩黄巾英雄首立功一回。[片段1]"],
    "结论含回目名（去空白匹配）→ 命中"
  );
});

test("㉑.3 bug-00004 低重叠复核候选 bestSourceLine：回号类问句复核参考可并入结构化出处行", () => {
  const view = buildInjectionView([
    {
      text: "玄德遂与关、张二人结为兄弟，誓同生死。",
      source: "sanguo-yanyi",
      chapter: 1,
      title: "宴桃园豪杰三结义　斩黄巾英雄首立功",
    },
  ]);
  const low = findLowOverlapSentences("刘备第一次出场在第一回。\n\n[片段1]", view);
  assert.equal(low.length, 1, "回号类结论句与片段正文低重叠 → 进复核候选");
  assert.deepEqual(
    low[0].referenceFragments.map((fragment) => fragment.sourceLine),
    ["〔出处1〕第1回 宴桃园豪杰三结义　斩黄巾英雄首立功"],
    "候选携带所引片段的结构化出处行，复核参考 = 片段原文 + 出处行"
  );
});

test("㉛.7 bug-00004 未闭环·extractChapterNumber：回号提取与归一（阿拉伯 / 全角 / 中文数字）", () => {
  assert.equal(extractChapterNumber("吕布最早登场于第3回。"), 3, "阿拉伯数字");
  assert.equal(extractChapterNumber("吕布最早登场于第三回。"), 3, "中文数字");
  assert.equal(extractChapterNumber("发生在第４３回。"), 43, "全角阿拉伯数字");
  assert.equal(extractChapterNumber("发生在第43回。"), 43, "多位阿拉伯");
  assert.equal(extractChapterNumber("〔出处1〕第29回 小霸王怒斩于吉　碧眼儿坐领江东"), 29, "出处行回号");
  assert.equal(extractChapterNumber("一百二十回"), null, "无「第」前缀不算回号");
  assert.equal(extractChapterNumber("吕布在议温明董卓叱丁原一回登场。"), null, "只写回目名（无第N回）→ null");
  assert.equal(extractChapterNumber(""), null, "空串 → null");
});

test("㉛.8 bug-00004 未闭环·chapterConsistencyVerdict（bug-00057 多片段）：结论回号与所引任一片段出处行一致 → supported；都取不到回号 → null", () => {
  const source3 = "〔出处1〕第3回 议温明董卓叱丁原　馈金珠李肃说吕布";
  const source29 = "〔出处1〕第29回 小霸王怒斩于吉　碧眼儿坐领江东";
  const source31 = "〔出处2〕第31回 曹操大宴铜雀台　孔明三气周公瑾";
  assert.equal(chapterConsistencyVerdict("吕布最早登场于第3回。", [source3]), "supported", "回号一致 → supported");
  assert.equal(chapterConsistencyVerdict("吕布最早登场于第三回。", [source3]), "supported", "中文数字归一后一致 → supported");
  assert.equal(chapterConsistencyVerdict("鲁肃初次登场是在第43回。", [source29]), "unsupported", "回号不一致（第43 vs 第29）→ unsupported");
  assert.equal(chapterConsistencyVerdict("吕布在议温明董卓叱丁原一回登场。", [source3]), null, "结论无第N回（只写回目名）→ null（交复核 LLM）");
  assert.equal(chapterConsistencyVerdict("吕布最早登场于第3回。", []), null, "无出处行 → null");
  assert.equal(chapterConsistencyVerdict("吕布最早登场于第3回。", [null]), null, "出处行取不到回号 → null");
  assert.equal(chapterConsistencyVerdict("", [source3]), null, "空结论 → null");
  assert.equal(chapterConsistencyVerdict("吕布最早登场于第3回。", [source29, source3]), "supported", "bug-00057：任一所引片段回号一致 → supported");
  assert.equal(chapterConsistencyVerdict("吕布最早登场于第3回。", [source29, source31]), "unsupported", "所有所引片段回号都不一致 → unsupported");
});
test("㊲ bug-00057 结构门·复核参考片段集：带指针句取所引全部合法片段（原文 + 出处行），所引指针全不可解析 → 参考为空", () => {
  const view = buildInjectionView([
    {
      text: "何进遣人召外兵入京，欲尽诛宦官。",
      source: "sanguo-yanyi",
      chapter: 3,
      title: "议温明董卓叱丁原　馈金珠李肃说吕布",
    },
    {
      text: "张让等伏兵于嘉德殿，何进入宫被围，遂遇害。",
      source: "sanguo-yanyi",
      chapter: 3,
      title: "议温明董卓叱丁原　馈金珠李肃说吕布",
    },
  ]);
  const low = findLowOverlapSentences("何进欲诛宦官而未成，反遭宦官杀害。[片段1][片段2]", view);
  assert.equal(low.length, 1, "跨段合并叙述结论句与所引两片段各自低重叠 → 进复核候选");
  assert.deepEqual(
    low[0].referenceFragments.map((fragment) => fragment.pointer),
    ["片段1", "片段2"],
    "复核参考 = 结论句所引全部合法片段（按指针顺序去重）"
  );
  assert.deepEqual(
    low[0].referenceFragments.map((fragment) => fragment.sourceLine),
    [
      "〔出处1〕第3回 议温明董卓叱丁原　馈金珠李肃说吕布",
      "〔出处2〕第3回 议温明董卓叱丁原　馈金珠李肃说吕布",
    ],
    "逐片段携带结构化出处行（回号类判据取用）"
  );
  assert.ok(low[0].bestOverlap < SENTENCE_OVERLAP_THRESHOLD, "bestOverlap 仍为句-片段重叠最大值（触发条件不变）");
  const orphan = findLowOverlapSentences("某句断言。[片段9]", view);
  assert.equal(orphan.length, 1, "所引指针不可解析仍是低重叠候选");
  assert.deepEqual(orphan[0].referenceFragments, [], "所引指针全不可解析 → 参考片段集为空（沿用 unsupported 且不调 LLM）");
});
