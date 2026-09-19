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
  formatQuoteSource,
  loadAliasTable,
  pickBestFallbackFragment,
  renderAnswerWithQuotes,
  scanRecallPersonIds,
  stripOverlongModelQuotes,
  toRecallFragments,
  validateQuotePointers,
  verifyCitation,
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

test("⑪ 兜底输出格式：原文片段 + 出处（字段渲染，只到回目）+ 一句结论归纳", () => {
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
  assert.match(out, /【原文片段】/);
  assert.match(out, /云长提刀出阵，斩华雄于帐前。/);
  assert.match(out, /（出处：第5回 发矫诏诸镇应曹公　破关兵三英战吕布）/);
  assert.doesNotMatch(out, /段\d/, "出处只到回目，不展示段号");
  assert.match(out, /按原文，斩华雄者系关羽/);
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
      { qid: "Q1", text: "特来求结两家之好，请君侯思之。", offset: 4 },
      { qid: "Q2", text: "吾虎女安肯嫁犬子乎！", offset: 29 },
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
  assert.equal(view.quotes.get("Q2")!.chapter, 73, "指针表保留出处字段供服务端渲染");
});

test("⑬.1 注入视图窗口裁掉引语时，其指针一并失效（不留下查不到的指针）", () => {
  const filler = "先叙无关内容。".repeat(40);
  const fragment = {
    text: `${filler}云长怒曰：“吾虎女安肯嫁犬子乎！”`,
    source: "sanguo-yanyi",
    chapter: 73,
    quotes: [{ qid: "Q1", text: "吾虎女安肯嫁犬子乎！", offset: filler.length + 6 }],
  };
  const view = buildInjectionView([fragment], "云长怒曰");
  assert.match(view.text, /⟨Q1⟩/, "命中词在引语旁，指针应可见");
  assert.equal(view.quotes.size, 1);
});

test("⑬.2 注入编号连续无空洞：窗口裁掉片段引语时并入首条引语保底，可见编号紧邻（bug-00009）", () => {
  const filler = "先叙无关内容。".repeat(30);
  const fragments = [
    // 片段1：引语完整可见（Q1）
    {
      text: "祖茂曰：“主公头上赤帻射目，可脱帻与某戴之。”是夜孙坚正遇华雄，两马相交。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      quotes: [{ qid: "Q1", text: "主公头上赤帻射目，可脱帻与某戴之。", offset: 5 }],
    },
    // 片段2：引语在检索词窗口之前被裁掉 → 并入首条引语保底（Q2）
    {
      text: `关公曰：“酒且斟下，某去便来。”出帐提刀，飞身上马。${filler}马到中军，云长提华雄之头，掷于地上。其酒尚温。`,
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      quotes: [{ qid: "Q1", text: "酒且斟下，某去便来。", offset: 5 }],
    },
    // 片段3：引语完整可见（Q3），验证跨片段编号连续
    {
      text: "太守韩馥曰：“吾有上将潘凤，可斩华雄。”绍急令出战。",
      source: "sanguo-yanyi",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      quotes: [{ qid: "Q1", text: "吾有上将潘凤，可斩华雄。", offset: 7 }],
    },
  ];
  const view = buildInjectionView(fragments, "华雄是怎么死的");
  assert.deepEqual(
    [...view.quotes.keys()],
    ["Q1", "Q2", "Q3"],
    "窗口裁掉引语后不得留下 Q1 后直接 Q3 的编号空洞"
  );
  assert.equal(view.quotes.get("Q2")!.text, "酒且斟下，某去便来。", "证据段引语被并回窗口保底");
  assert.match(view.text, /⟨Q2⟩“酒且斟下，某去便来。”/, "并入的引语带可见编号");
});

test("⑭ buildFallback 只输出最符合的一段：多段召回不长篇大论", () => {
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
  assert.match(out, /【原文片段】/);
  assert.ok(out.includes("吾虎女安肯嫁犬子乎"), "应输出最符合一段的窗口");
  assert.ok(!out.includes("章武元年"), "不应输出第二段全文");
  assert.match(out, /（出处：第73回 玄德进位汉中王　云长攻拔襄阳郡）/);
  assert.match(out, /按原文，关羽怒斥求亲使者/);
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
  assert.ok(out.includes("云长提华雄之头"), "应输出证据段（结论人物覆盖）而非 fragments[0]");
  assert.ok(!out.includes("是夜月白风清"), "孙坚夜战干扰段不得作为兜底片段");
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

test("⑯ 服务端渲染引用与出处：指针 → 「原文」（出处：第N回 回目），不展示段号", () => {
  const injected = new Map([
    [
      "Q2",
      {
        text: "吾虎女安肯嫁犬子乎！",
        chapter: 73,
        title: "玄德进位汉中王　云长攻拔襄阳郡",
        source: "sanguo-yanyi",
      },
    ],
  ]);
  const rendered = renderAnswerWithQuotes("关羽拒绝了孙权的联姻，回以[Q2]。", injected);
  assert.equal(
    rendered,
    "关羽拒绝了孙权的联姻，回以「吾虎女安肯嫁犬子乎！」（出处：第73回 玄德进位汉中王　云长攻拔襄阳郡）。"
  );
  assert.doesNotMatch(rendered, /段\d/, "出处只到回目");
  assert.match(rendered, /「吾虎女安肯嫁犬子乎！」/, "引语原文逐字来自字段，非模型复述");
});

test("⑯.1 出处渲染：无回号时退回来源标识，不伪造回目", () => {
  assert.equal(formatQuoteSource({ chapter: 5, source: "sanguo-yanyi" }), "第5回");
  assert.equal(formatQuoteSource({ source: "sanguo-yanyi" }), "sanguo-yanyi");
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
        { qid: "Q1", text: "特来求结两家之好，请君侯思之。", offset: 4, speaker: "瑾" },
        { qid: "Q2", text: "吾虎女安肯嫁犬子乎！", offset: 29, speaker: "云长" },
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
