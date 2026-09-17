#!/usr/bin/env node
/**
 * bug-00003 注入侧验收探针：直接调用 mcp-orchestrator 生产函数 trimFragmentToWindow
 * （非复刻），复跑 dev-docs/docs/sango-recall-bench.mjs 的 24 例用例集与语料。
 *
 * 运行：node --experimental-strip-types scripts/probe/verify-injection-window.mjs
 *
 * 输出：
 *   1. 主案例（孙权遣人向关羽求亲）目标段窗口是否包含答案句「吾虎女安肯嫁犬子乎」
 *   2. 24 例中 top5 已召回正确答案的用例的注入窗口截断率（旧逻辑 vs 新逻辑）
 */
import { readFileSync } from 'node:fs';
import { SangoIndex } from 'file:///D:/workplace/mcp-server/sango/src/search/sango-index.ts';
import { tokenize } from 'file:///D:/workplace/mcp-server/sango/src/utils/text.ts';
import { trimFragmentToWindow } from '../../src/citation.ts';

const SANGO_DIR = 'D:/workplace/mcp-server/sango';
const MAIN_CASE = '孙权遣人向关羽求亲，关羽是怎么回复使者的';

const idx = new SangoIndex();
idx.load();
const origTexts = idx.docs.map((d) => d.text);
const headerOf = (d) => `【出处】第${d.chapter}回 ${d.title} · 段${d.segIndex}`;

// --- 别名归一化：与 sango-index.ts / 评测脚本同一套规则（规范名取语料最高频写法） ---
const aliasRaw = JSON.parse(readFileSync(`${SANGO_DIR}/data/alias.json`, 'utf8'));
const pidOf = new Map(Object.entries(aliasRaw));
const byPid = new Map();
for (const [name, pid] of Object.entries(aliasRaw)) {
  if (!byPid.has(pid)) byPid.set(pid, []);
  byPid.get(pid).push(name);
}
const canonOf = new Map();
for (const [pid, names] of byPid) {
  canonOf.set(pid, names.slice().sort((a, b) => (idx.df.get(b) ?? 0) - (idx.df.get(a) ?? 0))[0]);
}
const aliasNames = [...pidOf.keys()].sort((a, b) => b.length - a.length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALIAS_PATTERN = new RegExp(aliasNames.map(escapeRe).join('|'), 'g');
const norm = (text) => text.replace(ALIAS_PATTERN, (m) => canonOf.get(pidOf.get(m)));
const normTexts = origTexts.map(norm);

// --- BM25（k1=1.5, b=0.75），与评测脚本一致：V2 = 纯BM25/整段/+别名归一化 ---
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
  return Array.from({ length: bi.n }, (_, i) => i).filter((i) => score[i] > 0).sort((a, b) => score[b] - score[a]);
}
const biNorm = buildIndex(normTexts);

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
  if (origTexts.some((t) => re.test(t))) CASES.push([q, re]);
}
console.log(`有效用例 ${CASES.length}/${RAW.length}`);

// --- 旧逻辑（修复前）：取 query 关键词「最后一次出现」±60 字，逐字复刻原始实现 ---
function extractQueryKeys(query) {
  const cleaned = query.replace(/[^\u4e00-\u9fa5]/g, '');
  const keys = new Set();
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= cleaned.length; i++) keys.add(cleaned.slice(i, i + len));
  }
  return [...keys];
}
function legacyWindowOf(body, query) {
  const WINDOW = 60;
  const FALLBACK = 120;
  let start = 0;
  let end = Math.min(body.length, FALLBACK);
  for (const key of extractQueryKeys(query)) {
    let at = -1;
    let cursor = body.indexOf(key);
    while (cursor >= 0) {
      at = cursor;
      cursor = body.indexOf(key, cursor + key.length);
    }
    if (at >= 0) {
      start = Math.max(0, at - WINDOW);
      end = Math.min(body.length, at + key.length + WINDOW);
      break;
    }
  }
  return body.slice(start, end);
}

// --- 新逻辑：调用生产函数（带【出处】头，与运行时片段形态一致） ---
function newWindowOf(docIndex, query) {
  const d = idx.docs[docIndex];
  const fragment = { text: `${headerOf(d)}\n${origTexts[docIndex]}`, source: 'sanguo-yanyi' };
  return trimFragmentToWindow(fragment, query).text;
}
/** 去掉【出处】头，只留正文窗口，便于与旧逻辑同口径比较长度 */
function bodyOfWindow(text) {
  return text.replace(/^\【出处\】[^\n]*\n?/, '');
}

// ========== 验收 1：主案例 ==========
console.log('\n=== 验收 1：主案例「' + MAIN_CASE + '」===');
const mainDocIndex = idx.docs.findIndex((d) => d.chapter === 73 && d.segIndex === 5);
console.log(`目标段：第73回 段5（docs[${mainDocIndex}]），段长 ${origTexts[mainDocIndex].length}，答案句位置 ${origTexts[mainDocIndex].indexOf('吾虎女安肯嫁犬子乎')}`);
const ANSWER = '吾虎女安肯嫁犬子乎';
const legacyMain = legacyWindowOf(origTexts[mainDocIndex], MAIN_CASE);
const newMain = newWindowOf(mainDocIndex, MAIN_CASE);
console.log(`  修复前窗口 len=${legacyMain.length} 含答案句=${legacyMain.includes(ANSWER)}`);
console.log(`  修复后窗口 len=${newMain.length} 含答案句=${newMain.includes(ANSWER)}`);
console.log('  修复后窗口原文：');
console.log('  ' + newMain.replace(/\n/g, '\n  '));

// 主案例 top5 名次（V2 配置），确认目标段确实在注入范围内
const mainRankOrder = bm25(biNorm, MAIN_CASE, true);
const mainRank = mainRankOrder.indexOf(mainDocIndex) + 1;
console.log(`  目标段 V2 纯BM25+别名归一化 名次：#${mainRank > 0 ? mainRank : 'miss'}`);

// ========== 验收 2：24 例截断率 ==========
console.log('\n=== 验收 2：24 例注入窗口截断率（top5 已召回正确答案的用例）===');
let tested = 0;
let legacyCut = 0;
let newCut = 0;
const legacyCutCases = [];
const newCutCases = [];
for (const [q, re] of CASES) {
  const top = bm25(biNorm, q, true).slice(0, 5).find((i) => re.test(origTexts[i]));
  if (top === undefined) continue;
  tested++;
  if (!re.test(legacyWindowOf(origTexts[top], q))) {
    legacyCut++;
    legacyCutCases.push(q);
  }
  if (!re.test(newWindowOf(top, q))) {
    newCut++;
    newCutCases.push(q);
  }
}
console.log(`  可测 ${tested} 例`);
console.log(`  修复前：窗口截掉答案句 ${legacyCut} 例（${Math.round((legacyCut / tested) * 100)}%）`);
for (const c of legacyCutCases) console.log(`     ✗ ${c}`);
console.log(`  修复后：窗口截掉答案句 ${newCut} 例（${Math.round((newCut / tested) * 100)}%）`);
for (const c of newCutCases) console.log(`     ✗ ${c}`);
if (newCutCases.length === 0) console.log('     （无剩余被截用例）');

// ========== 附：注入长度分布（确认未失控） ==========
const bodyLens = CASES.map(([q, re]) => {
  const top = bm25(biNorm, q, true).slice(0, 5).find((i) => re.test(origTexts[i]));
  return top === undefined ? null : bodyOfWindow(newWindowOf(top, q)).length;
}).filter((n) => n !== null);
const legacyLens = CASES.map(([q, re]) => {
  const top = bm25(biNorm, q, true).slice(0, 5).find((i) => re.test(origTexts[i]));
  return top === undefined ? null : legacyWindowOf(origTexts[top], q).length;
}).filter((n) => n !== null);
const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(`\n=== 附：单段注入窗口正文长度（不含【出处】头）===`);
console.log(`  修复前：max=${Math.max(...legacyLens)} avg=${avg(legacyLens)}`);
console.log(`  修复后：max=${Math.max(...bodyLens)} avg=${avg(bodyLens)}（预算上限 ${280}，重叠合并后计长）`);
console.log(`  折算 5 段注入总量：修复前 ~${avg(legacyLens) * 5} 字 → 修复后 ~${avg(bodyLens) * 5} 字`);
