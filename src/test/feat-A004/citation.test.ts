import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_MODEL_QUOTE_LENGTH,
  NOVEL_NO_HIT_ANSWER,
  buildFallback,
  buildInjectionView,
  loadAliasTable,
  pickBestFallbackFragment,
  renderAnswerWithCitations,
  scanRecallPersonIds,
  stripOverlongModelQuotes,
  toRecallFragments,
  toSuperscript,
  validateQuotePointers,
  verifyCitation,
  type InjectionView,
} from "../../citation.js";
import {
  parseSupportCheckResult,
  stripUnsupportedPointers,
} from "../../supportCheck.js";

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

test("⑪ 兜底输出（A006 结构化）：answer 结论句带角标 ¹，citations 恰一条兜底片段（整段原文）", () => {
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
  assert.equal(out.answer, "按原文，斩华雄者系关羽¹");
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
test("⑬ 注入视图只给纯原文 + 服务端编号：片段带 [片段N]、引语带 ⟨Qn⟩，不带回目/段号/分数", () => {
  const fragment = {
    text: "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”",
    source: "sanguo-yanyi",
    chapter: 73,
    title: "玄德进位汉中王　云长攻拔襄阳郡",
    quotes: [
      { offset: 4, len: 15 },
      { offset: 29, len: 10 },
    ],
  };
  const view = buildInjectionView([fragment]);
  assert.match(view.text, /\[片段1\]/);
  assert.match(view.text, /⟨Q1⟩“特来求结两家之好/);
  assert.match(view.text, /⟨Q2⟩“吾虎女安肯嫁犬子乎！”/);
  assert.doesNotMatch(view.text, /第73回/, "注入不回目，模型无从抄写出处");
  assert.doesNotMatch(view.text, /·\s*段\d/, "注入不带段号");
  assert.doesNotMatch(view.text, /分数|score/i, "注入不带分数");
  assert.equal(view.quotes.size, 2, "指针表应含两条可见引语");
  assert.equal(
    view.quotes.get("Q1")!.text,
    "特来求结两家之好，请君侯思之。",
    "引语文本由 offset/len 切片还原"
  );
  assert.equal(view.fragments.size, 1, "叙述段指针表应含该片段窗口");
  assert.equal(view.quotes.get("Q2")!.chapter, 73, "指针表保留出处字段供服务端渲染");
  assert.equal(view.quoteFragments.get("Q1"), "片段1", "Q1 归属片段1");
  assert.equal(view.quoteFragments.get("Q2"), "片段1", "Q2 归属片段1（同片段）");
});

test("⑬.1 整段注入：长段引语完整可见并可引用（不再按检索词窗口裁剪）", () => {
  const filler = "先叙无关内容。".repeat(40);
  const fragment = {
    text: `${filler}云长怒曰：“吾虎女安肯嫁犬子乎！”`,
    source: "sanguo-yanyi",
    chapter: 73,
    quotes: [{ offset: filler.length + 6, len: 10 }],
  };
  const view = buildInjectionView([fragment], "云长怒曰");
  assert.ok(view.text.includes(filler), "整段注入：前 5 段不再做窗口裁剪");
  assert.match(view.text, /⟨Q1⟩/, "命中词在引语旁，指针应可见");
  assert.equal(view.quotes.size, 1);
});

test("⑬.2 注入编号连续无空洞：整段注入下跨片段编号紧邻（bug-00009 回归）", () => {
  const filler = "先叙无关内容。".repeat(30);
  const fragments = [
    // 片段1：引语完整可见（Q1）
    {
      text: "祖茂曰：“主公头上赤帻射目，可脱帻与某戴之。”是夜孙坚正遇华雄，两马相交。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      quotes: [{ offset: 5, len: 17 }],
    },
    // 片段2：整段注入 → 引语完整可见（Q2）
    {
      text: `关公曰：“酒且斟下，某去便来。”出帐提刀，飞身上马。${filler}马到中军，云长提华雄之头，掷于地上。其酒尚温。`,
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      quotes: [{ offset: 5, len: 10 }],
    },
    // 片段3：引语完整可见（Q3），验证跨片段编号连续
    {
      text: "太守韩馥曰：“吾有上将潘凤，可斩华雄。”绍急令出战。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      quotes: [{ offset: 7, len: 12 }],
    },
  ];
  const view = buildInjectionView(fragments, "华雄是怎么死的");
  assert.deepEqual(
    [...view.quotes.keys()],
    ["Q1", "Q2", "Q3"],
    "整段注入后可见编号连续，不得留下 Q1 后直接 Q3 的空洞"
  );
  assert.equal(view.quotes.get("Q2")!.text, "酒且斟下，某去便来。", "证据段引语被并回窗口保底");
  assert.equal(view.quoteFragments.get("Q2"), "片段2", "跨片段引语归属各自片段");
  assert.match(view.text, /⟨Q2⟩“酒且斟下，某去便来。”/, "并入的引语带可见编号");
});

test("⑬.3 注入策略（2026-09-20 定稿）：前 5 段整段保底，证据段排 #5 仍注入，整段叙述（无引语）不走指针也可被归纳", () => {
  const filler = "无关内容。".repeat(30);
  const fragments = [
    { text: `宋宪告布曰：“买马被张飞劫走。”${filler}`, source: "sanguo-yanyi", chapter: 16, title: "吕奉先射戟辕门　曹孟德败师淯水", quotes: [] },
    { text: `张飞与马超斗百余合。${filler}`, source: "sanguo-yanyi", chapter: 65, title: "马超大战葭萌关　刘备自领益州牧", quotes: [] },
    { text: `玄德望见马超阵上人马皆倦。${filler}`, source: "sanguo-yanyi", chapter: 65, title: "马超大战葭萌关　刘备自领益州牧", quotes: [] },
    { text: `曹操回顾左右曰：“翼德百万军中取上将之首”。${filler}`, source: "sanguo-yanyi", chapter: 42, title: "张翼德大闹长坂桥　刘豫州败走汉津口", quotes: [] },
    {
      text: "范、张二贼，密入帐中，直至床前。张飞每睡不合眼；二贼以短刀刺入飞腹。飞大叫一声而亡。时年五十五。",
      source: "sanguo-yanyi",
      chapter: 81,
      title: "急兄仇张飞遇害　雪弟恨先主兴兵",
      quotes: [],
    },
    { text: `张飞怒鞭督邮。${filler}`, source: "sanguo-yanyi", chapter: 2, title: "张翼德怒鞭督邮　何国舅谋诛宦竖", quotes: [] },
  ];
  const view = buildInjectionView(fragments, "张飞怎么死的");
  assert.ok(view.text.includes("[片段5]"), "注入上限放宽到 10：第 5 段应注入");
  assert.ok(view.text.includes("范、张二贼，密入帐中"), "证据段叙述整体可见，模型可据此归纳");
  assert.equal(view.quotes.size, 0, "该题无引语可指针，兜底路径负责叙述窗口输出");
});

test("⑬.4 注入策略：tailFallback=true 时前 5 段整段保底 + 第 6+ 段预算内整段纳入", () => {
  const make = (i: number) => ({
    text: `第${i}段。`.repeat(10),
    source: "sanguo-yanyi",
    chapter: i,
    title: `回目${i}`,
    quotes: [],
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
    quotes: [],
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
    quotes: [],
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
  assert.equal(out.answer, "按原文，关羽怒斥求亲使者¹");
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

test("⑮ 指针校验：指针 ∈ 本次注入 qid 集合才通过，缺指针 / 越界指针一律不通过", () => {
  const injected = new Map([
    ["Q1", { text: "特来求结两家之好。", chapter: 73, source: "sanguo-yanyi" }],
    ["Q2", { text: "吾虎女安肯嫁犬子乎！", chapter: 73, source: "sanguo-yanyi" }],
  ]);
  const ok = validateQuotePointers("关羽拒绝了孙权的联姻，回以[Q2]。", injected);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.pointers, ["Q2"]);
  assert.deepEqual(ok.invalid, []);

  const missing = validateQuotePointers("关羽拒绝了孙权的联姻。", injected);
  assert.equal(missing.ok, false, "无指针即不合法（禁止无出处结论）");

  const outOfRange = validateQuotePointers("关羽回以[Q9]。", injected);
  assert.equal(outOfRange.ok, false, "指针不在本次注入集合内即不合法");
  assert.deepEqual(outOfRange.invalid, ["Q9"]);
});

test("⑮.1 指针校验支持叙述段指针：`[片段N]` ∈ 本次注入片段编号集合才通过（bug-00009）", () => {
  const injected = new Map([
    ["Q1", { text: "吾虎女安肯嫁犬子乎！", chapter: 73, source: "sanguo-yanyi" }],
  ]);
  const targets = new Map([
    ["片段5", { text: "范、张二贼，密入帐中，以短刀刺入飞腹。", chapter: 81, source: "sanguo-yanyi" }],
  ]);
  const ok = validateQuotePointers("张飞被范疆、张达刺死。[片段5]", injected, targets);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.pointers, ["片段5"]);
  assert.deepEqual(ok.invalid, []);
  const unknown = validateQuotePointers("张飞被害[片段9]", injected, targets);
  assert.equal(unknown.ok, false, "片段编号不在注入集合内即不合法");
  assert.deepEqual(unknown.invalid, ["片段9"]);
  const noTargets = validateQuotePointers("张飞被害[片段5]", injected);
  assert.equal(noTargets.ok, false, "未携带片段指针表时 [片段N] 判非法（向后兼容）");
});

test("⑯ 服务端渲染（A006）：`[Qn]` → 「引文」+ 全局上标角标，出处下沉 citations", () => {
  const view: InjectionView = {
    text: "",
    quotes: new Map([
      [
        "Q2",
        {
          text: "吾虎女安肯嫁犬子乎！",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
    ]),
    fragments: new Map([
      [
        "片段1",
        {
          text: "云长勃然大怒曰：“吾虎女安肯嫁犬子乎！……”",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
    ]),
    quoteFragments: new Map([["Q2", "片段1"]]),
  };
  const out = renderAnswerWithCitations("关羽拒绝了孙权的联姻，回以[Q2]。", view);
  assert.equal(out.answer, "关羽拒绝了孙权的联姻，回以「吾虎女安肯嫁犬子乎！」¹。");
  assert.deepEqual(out.citations, [
    {
      text: "云长勃然大怒曰：“吾虎女安肯嫁犬子乎！……”",
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
    },
  ]);
  assert.doesNotMatch(out.answer, /（出处|段\d/, "不再内联出处，任何展示位无段号");
});

test("⑯.1 上标角标：¹²³⁴⁵⁶⁷⁸⁹⁰ 字符集，>9 用多字符组合（第 10 条 → ¹⁰）", () => {
  assert.equal(toSuperscript(1), "¹");
  assert.equal(toSuperscript(3), "³");
  assert.equal(toSuperscript(9), "⁹");
  assert.equal(toSuperscript(10), "¹⁰");
  assert.equal(toSuperscript(21), "²¹");
  assert.equal(toSuperscript(100), "¹⁰⁰");
});

test("⑯.2 叙述段指针：`[片段N]` → 仅角标（不内联原文），citations 收录该片段（bug-00009 张飞题）", () => {
  const view: InjectionView = {
    text: "",
    quotes: new Map(),
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
    quoteFragments: new Map(),
  };
  const out = renderAnswerWithCitations("张飞被范疆、张达刺死。[片段5]", view);
  assert.equal(
    out.answer,
    "张飞被范疆、张达刺死。¹"
  );
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

test("⑯.3 片段粒度合并：多引语同片段 → 一条 citation，角标相同", () => {
  const view: InjectionView = {
    text: "",
    quotes: new Map([
      [
        "Q1",
        {
          text: "特来求结两家之好，请君侯思之。",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
      [
        "Q2",
        {
          text: "吾虎女安肯嫁犬子乎！",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
    ]),
    fragments: new Map([
      [
        "片段1",
        {
          text: "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
    ]),
    quoteFragments: new Map([
      ["Q1", "片段1"],
      ["Q2", "片段1"],
    ]),
  };
  const out = renderAnswerWithCitations(
    "关羽怒拒[Q2]，使者此前曾[Q1]。",
    view
  );
  assert.equal(
    out.answer,
    "关羽怒拒「吾虎女安肯嫁犬子乎！」¹，使者此前曾「特来求结两家之好，请君侯思之。」¹。"
  );
  assert.equal(out.citations.length, 1, "同片段多引语合并为一条（角标数量=片段数量）");
  assert.deepEqual(out.citations[0], {
    text: "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”",
    chapter: 73,
    title: "玄德进位汉中王　云长攻拔襄阳郡",
  });
});

test("⑯.4 角标与 citations 下标一一对应：两条跨回引用 → ¹²，按首次出现顺序", () => {
  const view: InjectionView = {
    text: "",
    quotes: new Map([
      [
        "Q2",
        {
          text: "吾虎女安肯嫁犬子乎！",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
      [
        "Q4",
        {
          text: "特来取汝首！",
          chapter: 74,
          title: "庞令明抬榇决死战　关云长放水淹七军",
        },
      ],
    ]),
    fragments: new Map([
      [
        "片段1",
        {
          text: "云长勃然大怒曰：“吾虎女安肯嫁犬子乎！……”",
          chapter: 73,
          title: "玄德进位汉中王　云长攻拔襄阳郡",
        },
      ],
      [
        "片段2",
        {
          text: "庞德曰：“吾奉魏王旨，特来取汝首！恐汝不信，备榇在此。”",
          chapter: 74,
          title: "庞令明抬榇决死战　关云长放水淹七军",
        },
      ],
    ]),
    quoteFragments: new Map([
      ["Q2", "片段1"],
      ["Q4", "片段2"],
    ]),
  };
  const out = renderAnswerWithCitations(
    "关羽怒拒[Q2]；庞德扬言[Q4]。",
    view
  );
  assert.equal(
    out.answer,
    "关羽怒拒「吾虎女安肯嫁犬子乎！」¹；庞德扬言「特来取汝首！」²。"
  );
  assert.equal(out.citations.length, 2);
  assert.deepEqual(out.citations, [
    {
      text: "云长勃然大怒曰：“吾虎女安肯嫁犬子乎！……”",
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
    },
    {
      text: "庞德曰：“吾奉魏王旨，特来取汝首！恐汝不信，备榇在此。”",
      chapter: 74,
      title: "庞令明抬榇决死战　关云长放水淹七军",
    },
  ]);
});

test("⑯.5 只收被引用片段：注入 3 段只引 2 段 → citations 恰 2 条，未引段不收录", () => {
  const view: InjectionView = {
    text: "",
    quotes: new Map([["Q1", { text: "引语甲", chapter: 1, title: "回目甲" }]]),
    fragments: new Map([
      ["片段1", { text: "片段甲原文", chapter: 1, title: "回目甲" }],
      ["片段2", { text: "片段乙原文", chapter: 2, title: "回目乙" }],
      ["片段3", { text: "片段丙原文", chapter: 3, title: "回目丙" }],
    ]),
    quoteFragments: new Map([["Q1", "片段1"]]),
  };
  const out = renderAnswerWithCitations("引用[Q1]，再引[片段3]。", view);
  assert.equal(out.answer, "引用「引语甲」¹，再引²。");
  assert.equal(out.citations.length, 2, "未被引用的片段2 不得收录");
  assert.deepEqual(
    out.citations.map((item) => item.text),
    ["片段甲原文", "片段丙原文"]
  );
});

test("⑯.6 无引用恒 []：answer 无指针时 citations 为空、answer 原样", () => {
  const view: InjectionView = {
    text: "",
    quotes: new Map(),
    fragments: new Map([["片段1", { text: "片段甲原文", chapter: 1, title: "回目甲" }]]),
    quoteFragments: new Map(),
  };
  const answer = "演义中未涉及。";
  const out = renderAnswerWithCitations(answer, view);
  assert.equal(out.answer, answer);
  assert.deepEqual(out.citations, []);
});

test("⑰ 长引语安全网：超 30 字的「…」视为违规抄写被丢弃，短引语原样保留", () => {
  const long = "吾虎女安肯嫁犬子乎！不看汝弟之面，立斩汝首！再休多言！汝可速回。";
  assert.ok(long.length > MAX_MODEL_QUOTE_LENGTH);
  const answer = `关羽拒绝了孙权的联姻，回以「${long}」，态度强硬[Q2]。`;
  const stripped = stripOverlongModelQuotes(answer);
  assert.ok(!stripped.includes(long), "超长抄写应被丢弃");
  assert.match(stripped, /\[Q2\]/, "指针保留，原文改由字段渲染");
  assert.equal(
    stripOverlongModelQuotes("关羽回以「虎女安肯嫁犬子乎」[Q2]。"),
    "关羽回以「虎女安肯嫁犬子乎」[Q2]。",
    "短引语不属于违规抄写"
  );
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
      quoteBalanced: true,
      quotes: [
        { offset: 4, len: 15 },
        { offset: 29, len: 10 },
      ],
    },
    {
      id: "sanguo-yanyi:0082:c0001",
      text: "却说章武元年秋八月，先主起大军至夔关。",
      chapter: 82,
      title: "孙权降魏受九锡　先主征吴赏六军",
      type: "narration",
      segFrom: 1,
      segTo: 1,
      quoteBalanced: true,
      quotes: [],
    },
  ]);
  const [entry, second] = toRecallFragments([entries], "sanguo-yanyi");
  assert.equal(entry.chapter, 73);
  assert.equal(entry.title, "玄德进位汉中王　云长攻拔襄阳郡");
  assert.doesNotMatch(entry.text, /【出处】/, "正文只留纯原文（I6）");
  assert.doesNotMatch(entry.text, /段5/, "段号走字段，不进正文");
  assert.equal(entry.quotes?.length, 2);
  assert.equal(second.chapter, 82, "跨回召回时出处逐条渲染（文档级元数据不存在）");
  assert.equal(second.title, "孙权降魏受九锡　先主征吴赏六军");
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
});

test("⑲ 出参瘦身（bug-00010）：quotes[] 只给 {offset,len}，引语文本按切片还原且与原文逐字一致", () => {
  const text =
    "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”";
  const entries = JSON.stringify([
    {
      id: "sanguo-yanyi:0073:c0007",
      text,
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
      type: "narration",
      quotes: [
        { offset: 4, len: 15 },
        { offset: 29, len: 10 },
      ],
    },
  ]);
  const [entry] = toRecallFragments([entries], "sanguo-yanyi");
  assert.equal(entry.quotes?.length, 2, "合法定位全部保留，不得静默丢 quotes");
  const view = buildInjectionView([entry]);
  assert.deepEqual([...view.quotes.keys()], ["Q1", "Q2"]);
  entry.quotes!.forEach((quote, index) => {
    const restored = view.quotes.get(`Q${index + 1}`)!.text;
    assert.equal(
      text.slice(quote.offset - 1, quote.offset - 1 + quote.len + 2),
      `“${restored}”`,
      `Q${index + 1}：切片（含两侧引号）与原文逐字一致`
    );
  });
  assert.equal(view.quotes.get("Q1")!.text, "特来求结两家之好，请君侯思之。");
  assert.equal(view.quotes.get("Q2")!.text, "吾虎女安肯嫁犬子乎！");
});

test("⑲.1 同 chunk 内引语文本重复：按 offset 各就各位（修正 indexOf 一律指向首处的既有缺陷）", () => {
  const text = "布曰：“某愿往。”布又曰：“某愿往。”";
  const view = buildInjectionView([
    {
      text,
      source: "sanguo-yanyi",
      chapter: 3,
      title: "议温明董卓叱丁原　馈金珠李肃说吕布",
      quotes: [
        { offset: 4, len: 4 },
        { offset: 14, len: 4 },
      ],
    },
  ]);
  assert.equal(
    view.text,
    "[片段1] 布曰：⟨Q1⟩“某愿往。”布又曰：⟨Q2⟩“某愿往。”",
    "两条同名引语各标各的位置，不挤在同一处"
  );
  assert.equal(view.quotes.get("Q1")!.text, "某愿往。");
  assert.equal(view.quotes.get("Q2")!.text, "某愿往。");
  assert.deepEqual(
    [view.quoteFragments.get("Q1"), view.quoteFragments.get("Q2")],
    ["片段1", "片段1"],
    "同片段两条引语各占一个指针"
  );
});

test("⑲.2 非法 / 越界 offset、len：只跳过该条，不崩、不插错标记，编号仍连续（不得静默丢整组）", () => {
  const text =
    "瑾曰：“特来求结两家之好，请君侯思之。”云长勃然大怒曰：“吾虎女安肯嫁犬子乎！”";
  const entries = JSON.stringify([
    {
      id: "sanguo-yanyi:0073:c0007",
      text,
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
      quotes: [
        { offset: 4, len: 15 },
        { offset: 0, len: 15 },
        { offset: 4, len: 0 },
        { offset: 4, len: 99 },
        { offset: 4.5, len: 3 },
        { offset: 4, len: "15" },
        { offset: 29, len: 10 },
      ],
    },
  ]);
  const [entry] = toRecallFragments([entries], "sanguo-yanyi");
  assert.equal(entry.quotes?.length, 2, "只跳过非法定位，合法引语照常保留");
  const view = buildInjectionView([entry]);
  assert.deepEqual([...view.quotes.keys()], ["Q1", "Q2"], "编号从 1 起连续、无空洞");
  assert.equal(
    view.text,
    "[片段1] 瑾曰：⟨Q1⟩“特来求结两家之好，请君侯思之。”云长勃然大怒曰：⟨Q2⟩“吾虎女安肯嫁犬子乎！”",
    "非法定位不插标记，合法引语的标记落在开引号前"
  );
  const direct = buildInjectionView([
    {
      text: "甲曰：“乙。”",
      source: "sanguo-yanyi",
      quotes: [
        { offset: 99, len: 2 },
        { offset: 4, len: 2 },
      ],
    },
  ]);
  assert.equal(
    direct.text,
    "[片段1] 甲曰：⟨Q1⟩“乙。”",
    "越界定位跳过，合法定位照常编号"
  );
});


// ===== bug-00028：复核轮判定契约（novel_support_check）——纯函数级用例 =====
// 语义裁决移交 LLM 复核轮（supportCheck.ts），词表型信号（死亡 / 数值同值 / 表字值）已删除，
// 本组只测契约 JSON 的解析（熔断）与按 support 值的裁剪动作，不测任何语义规则。

test("⑳ 复核轮契约：正常 JSON 解析（supported / unsupported 混合 + overall）", () => {
  const parsed = parseSupportCheckResult(
    '{"citations":[{"pointer":"片段1","support":"supported"},{"pointer":"Q1","support":"unsupported"}],"overall":"supported"}'
  );
  assert.deepEqual(parsed, {
    citations: [
      { pointer: "片段1", support: "supported" },
      { pointer: "Q1", support: "unsupported" },
    ],
    overall: "supported",
  });
});

test("⑳.1 复核轮契约·uncertain 取值合法：不属于放宽动作，由调用方按 unsupported 拒答", () => {
  const parsed = parseSupportCheckResult(
    '{"citations":[{"pointer":"片段1","support":"uncertain"}],"overall":"uncertain"}'
  );
  assert.deepEqual(parsed, {
    citations: [{ pointer: "片段1", support: "uncertain" }],
    overall: "uncertain",
  });
});

test("⑳.2 复核轮契约·解析失败熔断：非 JSON / 空串 / 围栏外多余文字 → null（调用方重试 1 次后按 unsupported 拒答）", () => {
  assert.equal(parseSupportCheckResult("马超投靠刘备后病逝。"), null, "散文输出非契约 JSON");
  assert.equal(parseSupportCheckResult(""), null, "空输出");
  assert.equal(parseSupportCheckResult("   \n  "), null, "纯空白输出");
  assert.equal(
    parseSupportCheckResult('解释了半天 {"overall":"supported","citations":[]} 结尾'),
    null,
    "JSON 前后夹带解释文字 → 非严格 JSON"
  );
});

test("⑳.3 复核轮契约·```json 围栏容错：围栏包裹的合法 JSON 可解析（模型偶发围栏不判死）", () => {
  const fenced = [
    "```json",
    '{"citations":[{"pointer":"片段1","support":"supported"}],"overall":"supported"}',
    "```",
  ].join("\n");
  const parsed = parseSupportCheckResult(fenced);
  assert.equal(parsed?.overall, "supported");
  assert.equal(parsed?.citations[0]?.pointer, "片段1");
});

test("⑳.4 复核轮契约·字段缺失熔断：overall 缺 / citations 非数组 / pointer 空 / support 非法 → null", () => {
  assert.equal(
    parseSupportCheckResult('{"citations":[],"overall":"judged"}'),
    null,
    "overall 取值非法"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":[],"overall":null}'),
    null,
    "overall 缺失（null）"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":[],"overall":"supported","extra":1}')?.overall,
    "supported",
    "多余字段容忍，不影响契约字段校验"
  );
  assert.equal(
    parseSupportCheckResult('[{"pointer":"片段1","support":"supported"}]'),
    null,
    "顶层数组（非对象）→ 熔断"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":{},"overall":"supported"}'),
    null,
    "citations 非数组 → 熔断"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":[{"pointer":"","support":"supported"}],"overall":"supported"}'),
    null,
    "pointer 为空串 → 熔断"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":[{"pointer":"片段1"}],"overall":"supported"}'),
    null,
    "support 缺失 → 熔断"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":[{"pointer":"片段1","support":"maybe"}],"overall":"supported"}'),
    null,
    "support 取值非法 → 熔断"
  );
  assert.equal(
    parseSupportCheckResult('{"citations":[null],"overall":"supported"}'),
    null,
    "citations 条目非对象 → 熔断"
  );
});

test("⑳.5 裁剪·部分支撑：只留 supported 引用、摘除 unsupported / uncertain / 未覆盖指针，正文不动", () => {
  const { answer, kept } = stripUnsupportedPointers(
    "夏侯渊随曹操讨吕布，大破之。[片段1][片段2]",
    [
      { pointer: "片段1", support: "supported" },
      { pointer: "片段2", support: "unsupported" },
    ]
  );
  assert.deepEqual(kept, ["片段1"]);
  assert.equal(answer, "夏侯渊随曹操讨吕布，大破之。[片段1]", "被摘除指针只去掉标记，正文原样保留");
});

test("⑳.6 裁剪·uncertain 与未覆盖指针同样摘除（宁缺毋滥）；复核轮漏判的指针不保留", () => {
  const { answer, kept } = stripUnsupportedPointers(
    "斩华雄者系关羽，原文见[Q1]，另有[片段3]。",
    [
      { pointer: "Q1", support: "uncertain" },
      { pointer: "片段3", support: "supported" },
    ]
  );
  assert.deepEqual(kept, ["片段3"]);
  assert.equal(answer, "斩华雄者系关羽，原文见，另有[片段3]。", "uncertain 指针摘除、未覆盖指针摘除");
});

test("⑳.7 裁剪·全不支撑 → kept 空（调用方据此拒答「演义中未涉及」）；重复出现一并摘除", () => {
  const { answer, kept } = stripUnsupportedPointers(
    "马超投靠刘备后，最终病逝。[片段2][片段2]",
    [{ pointer: "片段2", support: "unsupported" }]
  );
  assert.deepEqual(kept, []);
  assert.equal(answer, "马超投靠刘备后，最终病逝。", "指针全部摘除、重复出现一并摘除");
});
