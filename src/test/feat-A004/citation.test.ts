import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOVEL_NO_HIT_ANSWER,
  buildFallback,
  loadAliasTable,
  scanRecallPersonIds,
  trimFragmentToWindow,
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

test("⑪ 兜底输出格式：原文片段 + 出处 + 一句结论归纳", () => {
  const out = buildFallback(
    [{ text: "第五回：云长提刀斩华雄于帐前。", source: "sanguo-yanyi" }],
    "斩华雄者系关羽"
  );
  assert.match(out, /【原文片段】/);
  assert.match(out, /第五回：云长提刀斩华雄于帐前。/);
  assert.match(out, /（出处：sanguo-yanyi）/);
  assert.match(out, /按原文，斩华雄者系关羽/);
});

test("⑫ 检索无命中固定话术", () => {
  assert.equal(NOVEL_NO_HIT_ANSWER, "演义中未涉及");
});
test("⑬ trimFragmentToWindow：出处头保留 + 只取检索词附近窗口，不长篇大论", () => {
  const filler = "先叙无关内容。".repeat(40); // 240 字无关前置
  const key = "孙权遣人向关羽求亲，关羽怒曰“吾虎女安肯嫁犬子乎！”";
  const tailText = "后叙无关内容。".repeat(40);
  const fragment = {
    text: `【出处】第73回 玄德进位汉中王 云长攻拔襄阳郡 · 段5（叙述）\n${filler}${key}${tailText}`,
    source: "sanguo-yanyi",
  };
  const trimmed = trimFragmentToWindow(fragment, "孙权遣人向关羽求亲，关羽是怎么回复使者的");
  assert.ok(trimmed.text.startsWith("【出处】第73回"), "出处头应保留");
  assert.ok(trimmed.text.includes("求亲"), "窗口应包含检索词附近原文");
  assert.ok(trimmed.text.length < fragment.text.length, "应截短原文，禁止整段全文刷屏");
});

test("⑭ buildFallback 只输出最符合的一段：多段召回不长篇大论", () => {
  const out = buildFallback(
    [
      {
        text: "【出处】第73回 玄德进位汉中王 云长攻拔襄阳郡 · 段5（叙述）\n孙权遣人向关羽求亲，关羽怒曰“吾虎女安肯嫁犬子乎！”",
        source: "sanguo-yanyi",
      },
      {
        text: "【出处】第82回 孙权降魏受九锡 先主征吴赏六军 · 段1（叙述）\n却说章武元年秋八月，先主起大军至夔关。",
        source: "sanguo-yanyi",
      },
    ],
    "关羽怒斥求亲使者",
    "孙权遣人向关羽求亲，关羽是怎么回复使者的"
  );
  assert.match(out, /【原文片段】/);
  assert.ok(out.includes("吾虎女安肯嫁犬子乎"), "应输出最符合一段的窗口");
  assert.ok(!out.includes("章武元年"), "不应输出第二段全文");
  assert.match(out, /按原文，关羽怒斥求亲使者/);
});
