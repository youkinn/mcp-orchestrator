import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFY_SYSTEM_PROMPT,
  FENGYUNSANGUO_DOMAIN_PROMPT,
  FREE_CHAT_SYSTEM_PROMPT,
  NOVEL_BOUNDARY_CHECK_PROMPT,
  SANGO_NOVEL_DOMAIN_PROMPT,
} from "../../agent.js";

/** feat-A011：统一提示词拆分后的不变量（接口文档 §2.3 / §2.4，逐字节照录，测试即文档） */
const ALL_PROMPTS = [
  CLASSIFY_SYSTEM_PROMPT,
  SANGO_NOVEL_DOMAIN_PROMPT,
  FENGYUNSANGUO_DOMAIN_PROMPT,
  FREE_CHAT_SYSTEM_PROMPT,
].join("\n");

test("① 分类提示词：§2.3 原文照录，含 1/2/99 编号与兜底取向", () => {
  assert.match(
    CLASSIFY_SYSTEM_PROMPT,
    /你是路由分类器，只输出一个数字编号，不要任何解释、标点或多余文字。/
  );
  assert.match(CLASSIFY_SYSTEM_PROMPT, /1 = 《三国演义》原著检索域/);
  assert.match(CLASSIFY_SYSTEM_PROMPT, /2 = 风云三国题库问答域/);
  assert.match(CLASSIFY_SYSTEM_PROMPT, /99 = 其他（自由对话）/);
  assert.match(CLASSIFY_SYSTEM_PROMPT, /不确定时倾向选 1 或 2。/);
});

test("② sango-novel 域提示：§2.4 原文照录，含指针 / 片段 / 兜底条款，不指示调用工具", () => {
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /当前为「三国演义原著解读」场景/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /不要再调用检索工具/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /\[Qn\]/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /\[片段N\]/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /「演义中未涉及」/);
  assert.doesNotMatch(SANGO_NOVEL_DOMAIN_PROMPT, /sango_novel_search/);
});

test("②a 演义域生成轮含事件结构方向校验（bug-00023：主宾反转 / 错误前提）", () => {
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /施事者=.*动作=.*受事者=/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /方向是否一致.*禁止用该文档回答/);
});

test("②b 演义域生成轮含改述口径（bug-00032/33/34）：允许语义等价改述，禁改四要素，指针须指向支撑片段", () => {
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /结论允许对片段做语义等价的改述/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /不得改变片段中的人名、动作方向、受事者、结果/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /改述句必须由所引片段语义支撑/);
  assert.match(SANGO_NOVEL_DOMAIN_PROMPT, /引用指针必须指向该支撑片段/);
});

test("②c 边界复核提示词与域提示改述口径一致（judge 同口径校准）", () => {
  assert.match(NOVEL_BOUNDARY_CHECK_PROMPT, /语义等价的改述/);
  assert.match(NOVEL_BOUNDARY_CHECK_PROMPT, /不改变片段中的人名、动作方向、受事者、结果/);
  assert.match(NOVEL_BOUNDARY_CHECK_PROMPT, /片段原文足以推出或印证该断言 → supported/);
  assert.match(NOVEL_BOUNDARY_CHECK_PROMPT, /片段原文不足以支撑该断言/);
  assert.match(NOVEL_BOUNDARY_CHECK_PROMPT, /改动了片段中的人名、动作方向、受事者、结果 → unsupported/);
});

test("③ fengyunsanguo 域提示：§2.4 原文照录，含固定话术与未召回兜底", () => {
  assert.match(FENGYUNSANGUO_DOMAIN_PROMPT, /当前为「风云三国题库」场景/);
  assert.match(FENGYUNSANGUO_DOMAIN_PROMPT, /不要再调用检索工具/);
  assert.match(FENGYUNSANGUO_DOMAIN_PROMPT, /「题库未收录该题，请换个问法」/);
  assert.match(FENGYUNSANGUO_DOMAIN_PROMPT, /候选为空、或候选中没有含义对应的题目/);
});

test("③a 题库域候选不相关（含义不对应 → 未收录）时不得用题库外知识作答", () => {
  assert.match(
    FENGYUNSANGUO_DOMAIN_PROMPT,
    /候选中没有含义对应的题目.*「题库未收录该题，请换个问法」/
  );
  assert.match(FENGYUNSANGUO_DOMAIN_PROMPT, /禁止用题库外的知识作答、补充或改写答案/);
});

test("④ 自由对话提示：§2.4 原文照录，自由作答不套模板不提及工具名", () => {
  assert.match(FREE_CHAT_SYSTEM_PROMPT, /你是统一对话助手，用简体中文回答用户问题。/);
  assert.match(FREE_CHAT_SYSTEM_PROMPT, /不加模板、不提及工具名/);
});

test("⑤ 统一提示词已无天气条款：四常量不含天气能力 / 工具 / 判断次序 / 分域兜底条款", () => {
  assert.doesNotMatch(ALL_PROMPTS, /get-forecast|get-alerts/);
  assert.doesNotMatch(ALL_PROMPTS, /美国天气播报/);
  assert.doesNotMatch(ALL_PROMPTS, /仅适用于美国境内/);
  assert.doesNotMatch(ALL_PROMPTS, /非美国天气域/);
  assert.doesNotMatch(ALL_PROMPTS, /出门必备/);
  assert.doesNotMatch(ALL_PROMPTS, /判断次序/);
});

test("⑥ 提示词无路由字段与多轮记忆措辞（分域规则只能写在提示词里）", () => {
  assert.doesNotMatch(ALL_PROMPTS, /scenario|service|sessionId|HTTP/i);
  assert.doesNotMatch(ALL_PROMPTS, /多轮|历史对话|上一轮|记住之前/);
});

test("⑦ 提示词保持 TS 常量（不外部化）：四常量均可直接引用且非空", () => {
  assert.ok(CLASSIFY_SYSTEM_PROMPT.length > 0);
  assert.ok(SANGO_NOVEL_DOMAIN_PROMPT.length > 0);
  assert.ok(FENGYUNSANGUO_DOMAIN_PROMPT.length > 0);
  assert.ok(FREE_CHAT_SYSTEM_PROMPT.length > 0);
});
