#!/usr/bin/env node
/**
 * 三国演义检索召回质量 · 评测脚本（探针 B，feat-A004 K2 固化）
 *
 * 出处：dev-docs/docs/sango-recall-quality.md（§2 诊断方法 / §4 提升方案 / §5 探针 B）
 * 落点：mcp-orchestrator/scripts/probe/recall-bench.mjs
 *
 * 直接打 SangoIndex，不经模型、不经 MCP，秒级出结果，可作 CI 回归。
 * 运行：node --experimental-strip-types scripts/probe/recall-bench.mjs
 *
 * 段级语料取自构建期中间产物 `_segments/`：SangoIndex 的语料已改为 schema v2 的 `chunks[]`，
 * 段级数据不再从索引取（见 dev-docs/docs/sango-corpus-spec.md §5）。
 *
 * 输出：
 *   1. 4 种检索配置的 @1/@3/@5 召回命中率（V0=现状 search() 混合召回，V1–V3=纯 BM25 演进）
 *   2. 主案例「孙权遣人向关羽求亲」的目标段排名
 *   3. 注入窗口二阶截断率（窗口口径同源 citation.ts trimTextToWindow，本脚本内联实现）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 路径解析：默认以脚本自身位置向上三级为工作区根（scripts/probe → scripts → mcp-orchestrator → workplace），
// 与同目录 verify-injection-window.mjs 的 import.meta.dirname 口径一致；可用环境变量覆盖。
const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');
const SANGO_DIR = resolve(process.env.SANGO_DIR ?? resolve(WORKSPACE_ROOT, 'mcp-server', 'sango'));
const DEV_DOCS_DIR = resolve(process.env.SANGO_DEV_DOCS_DIR ?? resolve(WORKSPACE_ROOT, 'dev-docs'));

const { SangoIndex } = await import(pathToFileURL(resolve(SANGO_DIR, 'src', 'search', 'sango-index.ts')).href);
const { tokenize } = await import(pathToFileURL(resolve(SANGO_DIR, 'src', 'utils', 'text.ts')).href);

const MAIN_CASE = '孙权遣人向关羽求亲，关羽是怎么回复使者的';

// --- 段级语料：构建期中间产物 _segments/sanguo-yanyi/{001..120}.json（{ source, chapter, title, segments[] }）---
const SEGMENTS_DIR = resolve(SANGO_DIR, 'data', 'corpus', '_segments', 'sanguo-yanyi');
function loadSegments() {
  const files = existsSync(SEGMENTS_DIR)
    ? readdirSync(SEGMENTS_DIR).filter((f) => /^\d{3}\.json$/.test(f)).sort()
    : [];
  if (files.length === 0) {
    console.error(`[probe] 段级语料不存在或为空：${SEGMENTS_DIR}`);
    console.error('[probe] 该产物由 build_corpus.py 生成，请先重建语料：');
    console.error(`[probe]   py -3 ${resolve(SANGO_DIR, 'scripts', 'build_corpus.py')}`);
    console.error(`[probe] 段级 schema 见 ${resolve(DEV_DOCS_DIR, 'docs', 'sango-corpus-spec.md')} §5`);
    process.exit(1);
  }
  const out = [];
  for (const f of files) {
    const file = resolve(SEGMENTS_DIR, f);
    const ch = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(ch.segments)) {
      console.error(`[probe] 段级语料格式非法（应为 { source, chapter, title, segments[] }）：${file}`);
      process.exit(1);
    }
    for (const seg of ch.segments) {
      out.push({ chapter: ch.chapter, title: ch.title, segIndex: seg.index, type: seg.type, text: seg.text });
    }
  }
  return out;
}
const docs = loadSegments();
const origTexts = docs.map((d) => d.text);
const docKey = new Map();
docs.forEach((d, i) => docKey.set(`${d.chapter}:${d.segIndex}`, i));

// 显式传 dataDir：SangoIndex 默认取模块自身相对路径，传参才能让 SANGO_DIR 覆盖生效
const idx = new SangoIndex(resolve(SANGO_DIR, 'data'));
idx.load();

// 规范名选取依据：段级原始文本 df（与 sango-index.ts loadAliases 同口径：原始未归一化文本的 df）
const segDf = new Map();
for (const t of origTexts) for (const tok of new Set(tokenize(t))) segDf.set(tok, (segDf.get(tok) ?? 0) + 1);

// --- 别名归一化：规范名取该 PID 下语料内最高频写法（P002→云长 / P006→孙权 / P004→孔明） ---
const aliasRaw = JSON.parse(readFileSync(`${SANGO_DIR}/data/alias.json`, 'utf8'));
const pidOf = new Map(Object.entries(aliasRaw));
const byPid = new Map();
for (const [name, pid] of Object.entries(aliasRaw)) {
  if (!byPid.has(pid)) byPid.set(pid, []);
  byPid.get(pid).push(name);
}
const canonOf = new Map();
for (const [pid, names] of byPid) {
  canonOf.set(pid, names.slice().sort((a, b) => (segDf.get(b) ?? 0) - (segDf.get(a) ?? 0))[0]);
}
const aliasNames = [...pidOf.keys()].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALIAS_PATTERN = new RegExp(aliasNames.map(escapeRe).join('|'), 'g');
const norm = (text) => text.replace(ALIAS_PATTERN, (m) => canonOf.get(pidOf.get(m)));
const normTexts = origTexts.map(norm);

// --- chunk 切窗 250 字（按句边界，记录回指段号） ---
function chunkSegments(texts, size) {
  const chunks = [];
  const docOf = [];
  for (let i = 0; i < texts.length; i++) {
    const sentences = texts[i].split(/(?<=[。！？；])/).filter((s) => s.trim());
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > size && buf) {
        chunks.push(buf);
        docOf.push(i);
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf) {
      chunks.push(buf);
      docOf.push(i);
    }
  }
  return { chunks, docOf };
}
const CH = chunkSegments(normTexts, 250);

// --- BM25（k1=1.5, b=0.75） ---
function buildIndex(texts) {
  const toks = texts.map(tokenize);
  const postings = new Map();
  const df = new Map();
  toks.forEach((tt, i) => {
    const tf = new Map();
    for (const t of tt) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, f] of tf) {
      df.set(t, (df.get(t) ?? 0) + 1);
      const arr = postings.get(t) ?? [];
      arr.push({ d: i, tf: f });
      postings.set(t, arr);
    }
  });
  const avg = toks.reduce((a, t) => a + t.length, 0) / texts.length;
  return { toks, postings, df, avg, n: texts.length };
}
function bm25(bi, query, useNorm) {
  const qTokens = tokenize(useNorm ? norm(query) : query);
  const score = new Float64Array(bi.n);
  for (const t of qTokens) {
    const posts = bi.postings.get(t);
    if (!posts) continue;
    const df = bi.df.get(t) ?? 0;
    const idf = Math.log(1 + (bi.n - df + 0.5) / (df + 0.5));
    for (const p of posts) {
      const dl = bi.toks[p.d].length;
      score[p.d] += idf * ((p.tf * 2.5) / (p.tf + 1.5 * (0.25 + 0.75 * (dl / bi.avg))));
    }
  }
  return Array.from({ length: bi.n }, (_, i) => i)
    .filter((i) => score[i] > 0)
    .sort((a, b) => score[b] - score[a]);
}

// --- V0：现状 search()（BM25 + 真向量混合，Step 2 起 query 侧运行期 BGE-M3 编码）；
//     出参已改为结构化条目数组，用 chapter + segFrom 折算回段下标 ---
async function ranksFromSearch(query, limit) {
  const out = await idx.search(query, limit);
  if (!Array.isArray(out) || out.length === 0) return [];
  const ranks = [];
  for (const e of out) {
    // docKey 口径为 `chapter:segIndex`；跨段条目取 segFrom
    const k = docKey.get(`${e.chapter}:${e.segFrom}`);
    if (k !== undefined) ranks.push(k);
  }
  return ranks;
}

// --- 用例集（问句, 答案正则）；正则须至少命中 1 段，否则剔除（正则与语料表述不符） ---
const RAW = [
  ['孙权遣人向关羽求亲，关羽是怎么回复使者的', /虎女安肯嫁犬子/],
  ['关羽求亲', /虎女安肯嫁犬子/],
  ['关羽怎么拒绝孙权的联姻', /虎女安肯嫁犬子/],
  ['关羽为何辱骂孙权', /虎女安肯嫁犬子/],
  ['诸葛瑾去荆州做什么', /虎女安肯嫁犬子/],
  ['曹操献刀', /献刀/],
  ['关羽水淹七军', /水淹七军/],
  ['曹操割发代首', /割发/],
  ['张辽威震逍遥津', /逍遥津/],
  ['吕布辕门射戟', /射戟/],
  ['许褚裸衣斗马超', /裸衣/],
  ['关羽刮骨疗毒', /刮骨/],
  ['关羽单刀赴会', /单刀赴会/],
  ['诸葛亮骂死王朗', /骂死/],
  ['赵云截江救阿斗', /截江/],
  ['诸葛亮空城计', /空城/],
  ['关羽斩颜良', /斩颜良/],
  ['张飞喝断当阳桥', /当阳桥/],
  ['刘备托孤', /托孤/],
  ['七擒孟获', /孟获/],
  ['火烧赤壁', /赤壁/],
  ['三顾茅庐', /三顾/],
  ['桃园结义', /桃园结义/],
  ['曹操煮酒论英雄', /煮酒/],
  ['诸葛亮隆中对', /隆中/],
];
const CASES = [];
for (const [q, re] of RAW) {
  const hits = origTexts.filter((t) => re.test(t)).length;
  if (hits >= 1) CASES.push([q, re]);
  else console.log(`  [剔除] ${q} → 正则命中 0 段（正则与语料表述不符）`);
}
console.log(`有效用例 ${CASES.length}/${RAW.length}\n`);

// --- 段级折算排名：同段多 chunk 只记最好名次 ---
function bestRank(order, docOf, re) {
  const best = new Map();
  order.forEach((i, pos) => {
    const d = docOf ? docOf[i] : i;
    if (!best.has(d)) best.set(d, pos + 1);
  });
  const hit = [...best.entries()]
    .filter(([d]) => re.test(origTexts[d]))
    .sort((a, b) => a[1] - b[1])[0];
  return hit ? hit[1] : -1;
}

const biOrig = buildIndex(origTexts);
const biNorm = buildIndex(normTexts);
const biChunk = buildIndex(CH.chunks);
const CONFIGS = [
  ['V0 现状：混合召回/整段/无别名', async (q, re) => bestRank(await ranksFromSearch(q, 50), null, re)],
  ['V1 纯BM25/整段/无别名', (q, re) => bestRank(bm25(biOrig, q, false), null, re)],
  ['V2 纯BM25/整段/+别名归一化', (q, re) => bestRank(bm25(biNorm, q, true), null, re)],
  ['V3 纯BM25/chunk250/+别名归一化', (q, re) => bestRank(bm25(biChunk, q, true), CH.docOf, re)],
];
console.log('配置'.padEnd(32) + '@1'.padEnd(9) + '@3'.padEnd(9) + '@5');
const allRanks = {};
for (const [label, fn] of CONFIGS) {
  const ranks = await Promise.all(CASES.map(([q, re]) => fn(q, re)));
  allRanks[label] = ranks;
  const hit = (n) => `${ranks.filter((r) => r > 0 && r <= n).length}/${CASES.length}`;
  console.log(label.padEnd(32) + hit(1).padEnd(7) + hit(3).padEnd(7) + hit(5));
}

// --- 主案例排名 ---
const mainIdx = CASES.findIndex(([q]) => q === MAIN_CASE);
if (mainIdx >= 0) {
  console.log(`\n=== 主案例排名（目标：第73回 段5）===`);
  for (const [label] of CONFIGS) {
    const r = allRanks[label][mainIdx];
    console.log(`  ${label.padEnd(32)} #${r < 0 ? 'miss' : r}`);
  }
}

// --- 注入窗口二阶截断率（窗口口径同源 citation.ts trimTextToWindow，本脚本内联实现） ---
function extractQueryKeys(query) {
  const cleaned = query.replace(/[^\u4e00-\u9fa5]/g, '');
  const keys = new Set();
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= cleaned.length; i++) keys.add(cleaned.slice(i, i + len));
  }
  return [...keys];
}
function windowOf(body, query) {
  const WINDOW = 60;
  const FALLBACK = 120;
  let start = 0;
  let end = Math.min(body.length, FALLBACK);
  for (const key of extractQueryKeys(query)) {
    let idx2 = -1;
    let cursor = body.indexOf(key);
    while (cursor >= 0) {
      idx2 = cursor;
      cursor = body.indexOf(key, cursor + key.length);
    }
    if (idx2 >= 0) {
      start = Math.max(0, idx2 - WINDOW);
      end = Math.min(body.length, idx2 + key.length + WINDOW);
      break;
    }
  }
  return body.slice(start, end);
}
let tested = 0;
let cut = 0;
const cutCases = [];
for (const [q, re] of CASES) {
  const top = bm25(biNorm, q, true).slice(0, 5).find((i) => re.test(origTexts[i]));
  if (top === undefined) continue;
  tested++;
  if (!re.test(windowOf(origTexts[top], q))) {
    cut++;
    cutCases.push(q);
  }
}
console.log('\n=== 注入窗口二阶截断（top5 已召回正确答案的用例）===');
console.log(`  可测 ${tested} 例，窗口截掉答案句 ${cut} 例（${Math.round((cut / tested) * 100)}%）`);
for (const c of cutCases) console.log(`   ✗ ${c}`);
