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
