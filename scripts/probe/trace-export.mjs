#!/usr/bin/env node
/**
 * trace-export.mjs — 按 traceId 导出单条整链路日志（排查快照）
 *
 * 纪律（负责人 2026-09-25 拍板）：
 * - 执行人：负责人；Coco 不自跑（token 控制）。
 * - 只导单条链路（约 500 行）；chunkId 反查只列 ID、不批量导出（防 3W/5000 行大文件）。
 * - chunkId 反查后的批量勾选下载由日志页「一键导出」承载（页面轨）。
 *
 * 用法：
 *   node scripts/probe/trace-export.mjs <traceId> [输出路径]   # 导出单条链路
 *   node scripts/probe/trace-export.mjs --list <chunkId>       # 列出命中该 chunk 的 traceId（不导出）
 * 相对输出路径固定解析到 data/trace-exports/ 下，不随当前目录漂移。
 * 环境变量：LOGS_DB 覆盖日志库路径（默认 data/logs.db）。
 * 只读打开数据库；不落任何业务表。
 */
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PATH = process.env.LOGS_DB ?? resolve(ROOT, "data/logs.db");

const ARGS = process.argv.slice(2);
const db = new Database(DB_PATH, { readonly: true });

const TRACE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// —— 模式二：chunkId 反查，只列命中 traceId，不导出文件 ——
if (ARGS[0] === "--list") {
  const chunkId = ARGS[1];
  if (!chunkId) {
    console.error("usage: node scripts/probe/trace-export.mjs --list <chunkId>");
    process.exit(1);
  }
  const rows = db.prepare("SELECT trace_id, diagnostics FROM tool_retrieval_logs").all();
  const hits = [];
  for (const row of rows) {
    let d;
    try {
      d = JSON.parse(row.diagnostics);
    } catch {
      continue;
    }
    if (Array.isArray(d.candidates) && d.candidates.some((c) => c && c.chunkId === chunkId)) {
      hits.push(row.trace_id);
    }
  }
  if (hits.length === 0) {
    console.error(`未找到命中该 chunk 的链路：${chunkId}（需与 diagnostics candidates[].chunkId 精确匹配）`);
    process.exit(2);
  }
  console.log(`命中 ${hits.length} 条链路（扫描检索诊断表 ${rows.length} 行）：`);
  for (const t of hits.slice(0, 10)) console.log(`- ${t}`);
  if (hits.length > 10) console.log(`（其余 ${hits.length - 10} 条略；需要某条用 traceId 单独导出）`);
  db.close();
  process.exit(0);
}

// —— 模式一：traceId 导出单条链路 ——
const input = ARGS[0];
const outArg = ARGS[1];
if (!input || ARGS.includes("--help")) {
  console.error(`usage: node scripts/probe/trace-export.mjs <traceId> [输出路径]
  node scripts/probe/trace-export.mjs --list <chunkId>   # 反查 chunk 命中的 traceId 列表`);
  process.exit(input ? 0 : 1);
}

if (!TRACE_RE.test(input)) {
  console.error(`输入不是 traceId（${input}）。若你只有 chunkId，请用 --list 反查 traceId。`);
  process.exit(1);
}

const request = db.prepare("SELECT * FROM request_logs WHERE trace_id = ?").get(input);
if (!request) {
  console.error(`未找到该 traceId：${input}（30 天保留期内？请核对 UUID）`);
  process.exit(2);
}

const getRequest = db.prepare("SELECT * FROM request_logs WHERE trace_id = ?");
const getLlm = db.prepare("SELECT * FROM llm_call_logs WHERE trace_id = ? ORDER BY seq");
const getTool = db.prepare("SELECT * FROM tool_call_logs WHERE trace_id = ? ORDER BY seq");
const getRetr = db.prepare("SELECT * FROM tool_retrieval_logs WHERE trace_id = ? ORDER BY seq");
const getCache = db.prepare("SELECT * FROM cache_logs WHERE trace_id = ?");

const traces = [
  {
    traceId: input,
    request: getRequest.get(input) ?? null,
    llmCalls: getLlm.all(input),
    toolCalls: getTool.all(input),
    retrievalDiagnostics: getRetr.all(input).map((row) => {
      let parsed = null;
      try {
        parsed = JSON.parse(row.diagnostics);
      } catch {
        parsed = { parseError: true, rawHead: String(row.diagnostics).slice(0, 200) };
      }
      return { seq: row.seq, created_at: row.created_at, diagnostics: parsed };
    }),
    cache: getCache.get(input) ?? null,
  },
];

const out = {
  exportedAt: new Date().toISOString(),
  schemaVersion: "1",
  logDb: DB_PATH,
  input,
  mode: "traceId",
  matchedTraceIds: [input],
  traces,
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const safeInput = input.replace(/[^0-9a-zA-Z_-]/g, "_");
const defaultOut = resolve(ROOT, "data", "trace-exports", `${stamp}-${safeInput}.json`);
const outPath = outArg
  ? isAbsolute(outArg)
    ? outArg
    : resolve(ROOT, "data", "trace-exports", outArg)
  : defaultOut;
mkdirSync(dirname(outPath), { recursive: true });
const outStr = JSON.stringify(out, null, 2);
const lineCount = outStr.split("\n").length;
const kb = Math.round(Buffer.byteLength(outStr, "utf8") / 1024);
writeFileSync(outPath, outStr, "utf8");
db.close();

const t = traces[0];
console.log(`${t.traceId}  ${String(t.request?.user_input ?? "").slice(0, 40)}  status=${t.request?.status ?? "?"}  llm=${t.llmCalls.length}  tool=${t.toolCalls.length}  cache=${t.cache ? "有" : "无"}  约 ${lineCount} 行 / ${kb} KB`);
console.log("导出文件:", outPath);
