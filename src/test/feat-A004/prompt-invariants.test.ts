import { test } from "node:test";
import assert from "node:assert/strict";
import { UNIFIED_SYSTEM_PROMPT } from "../../agent.js";

/** feat-A004 能力三 6 条不变量（定稿，措辞微调后语义不得改） */
const NOVEL_RULES = [
  "1. 回答前必须先调用 sango_novel_search 工具检索《三国演义》原文。",
  "2. 只依据工具返回的原文作答：人物、情节、数字都必须能在原文里找到。",
  "3. 人名一律以召回原文为准：原文写谁就是谁，不得按常识/记忆替换、不得补别名、不得解释成别人。",
  "4. 原文里没有相关内容的问句，必须回答「演义中未涉及」，禁止用先验知识补全。",
  "5. 不评价、不纠正、不对比：不得说原文写错，不得提正史/影视/游戏，不得出现「实际上是…」这类转折。",
];

test("① prompt·能力三：6 条生成约束不变量原文照搬（第 6 条 = 引语指针格式）", () => {
  assert.match(
    UNIFIED_SYSTEM_PROMPT,
    /【能力三 ·《三国演义》原著检索（sango_novel_search）】/
  );
  for (const rule of NOVEL_RULES) {
    assert.ok(
      UNIFIED_SYSTEM_PROMPT.includes(rule),
      `原著检索规则原文缺失：${rule}`
    );
  }
});

test("①.1 prompt·能力三：标题声明条数与实际规则条数一致（防漂移）", () => {
  assert.match(
    UNIFIED_SYSTEM_PROMPT,
    /调了之后怎么答（以下 6 条必须严格遵守）：/
  );
  for (let i = 1; i <= 6; i++) {
    assert.ok(
      UNIFIED_SYSTEM_PROMPT.includes(`${i}. `),
      `能力三规则 ${i} 缺失`
    );
  }
});

test("② prompt·能力三调用时机：sango_novel_search 参数契约（source/query/limit 默认 5）", () => {
  assert.match(
    UNIFIED_SYSTEM_PROMPT,
    /什么时候调：用户询问《三国演义》原著情节、人物、事件等需要原文依据的问题时/
  );
  assert.match(UNIFIED_SYSTEM_PROMPT, /sango_novel_search/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /source=sanguo-yanyi/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /query=用户白话问句/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /limit 默认 5/);
});

test("③ prompt·判断次序：三个专用域互斥命中即停，原著检索并入且不破坏既有次序锚点", () => {
  assert.match(UNIFIED_SYSTEM_PROMPT, /【判断次序（自上而下，命中即停）】/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /三个专用域互斥，按语义命中即停/);
  // 既有 A003 次序锚点必须原样保留（不回归）
  const order = UNIFIED_SYSTEM_PROMPT.indexOf("【判断次序（自上而下，命中即停）】");
  const sangoStep = UNIFIED_SYSTEM_PROMPT.indexOf("1. 意图是否命中风云三国");
  const novelStep = UNIFIED_SYSTEM_PROMPT.indexOf(
    "1.1 意图是否命中《三国演义》原著情节 / 人物 / 事件等需要原文依据的问句"
  );
  const weatherStep = UNIFIED_SYSTEM_PROMPT.indexOf("2. 意图是否命中美国境内城市");
  const fallbackStep = UNIFIED_SYSTEM_PROMPT.indexOf("3. 以上都未命中");

  assert.ok(order > -1, "缺少判断次序小节");
  assert.ok(sangoStep > order, "题库判断应在次序小节内");
  assert.ok(novelStep > sangoStep, "原著检索判断应排在题库之后（可放在题库之后）");
  assert.ok(weatherStep > novelStep, "天气判断应排在原著检索之后");
  assert.ok(fallbackStep > weatherStep, "兜底应排在三个专用域之后");
});

test("④ prompt·分域兜底：原著检索域无命中 / 校验不过 → 原文片段 + 出处 + 结论归纳", () => {
  assert.match(UNIFIED_SYSTEM_PROMPT, /原著检索域/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /检索无命中/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /引用校验不过/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /原文片段 \+ 出处/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /结论归纳/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /按原文，斩华雄者系关羽/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /演义中未涉及/);
});

test("⑤ prompt·总原则与输出格式约束同步为三项能力", () => {
  assert.match(UNIFIED_SYSTEM_PROMPT, /你有三项专用能力/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /《三国演义》原著检索（sango_novel_search）/);
  assert.match(UNIFIED_SYSTEM_PROMPT, /只有天气域、题库域与原著检索域有强制格式/);
});
