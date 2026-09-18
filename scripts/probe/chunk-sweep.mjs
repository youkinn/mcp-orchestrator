#!/usr/bin/env node
/**
 * 三国演义语料 chunk 切分 · 决策证据（探针 B，feat-A004 K2 固化）
 *
 * 出处：dev-docs/docs/sango-corpus-spec.md（§3 切分算法的参考实现 / §7 评测固化）
 * 落点：mcp-orchestrator/scripts/probe/chunk-sweep.mjs
 *
 * 运行：node --experimental-strip-types scripts/probe/chunk-sweep.mjs
 *
 * 段级语料取自构建期中间产物 `_segments/`：SangoIndex 的语料已改为 schema v2 的 `chunks[]`，
 * 段级数据不再从索引取（见 dev-docs/docs/sango-corpus-spec.md §5）。
 *
 * 口径与 sango-recall-bench.mjs 同源：同一语料、同一 24 例基准、同一 BM25 参数
 * （k1=1.5 / b=0.75）、同一别名归一化（语料侧与 query 侧同时做）。
 * 注入窗口二阶截断口径见 recall-bench.mjs（本脚本不产出该指标）。
 *
 * 指标口径：
 *   @k           答案段（含判定正则的段）折算后的排名命中率（同段多 chunk 取最好名次）
 *   750/1000覆盖 按排名累加 chunk 字数至预算上限，答案是否已进入注入（最贴近真实注入约束）
 *   top5重复     top5 内存在共享整句的 chunk 对（重叠量化的直接读数）
 *   引号断       含引号的 chunk 中 “/” 不配对的占比（引语被切断的度量）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 路径解析：默认以脚本自身位置向上三级为工作区根（scripts/probe → scripts → mcp-orchestrator → workplace），
// 与同目录 verify-injection-window.mjs 的 import.meta.dirname 口径一致；可用环境变量覆盖。
const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../..');
const SANGO_DIR = resolve(process.env.SANGO_DIR ?? resolve(WORKSPACE_ROOT, 'mcp-server', 'sango'));
const DEV_DOCS_DIR = resolve(process.env.SANGO_DEV_DOCS_DIR ?? resolve(WORKSPACE_ROOT, 'dev-docs'));

const { tokenize } = await import(pathToFileURL(resolve(SANGO_DIR, 'src', 'utils', 'text.ts')).href);

const MAIN_CASE = '孙权遣人向关羽求亲，关羽是怎么回复使者的';
const OPEN = '\u201c';
const CLOSE = '\u201d';

// ===================== 切分算法（规范 §3 的参考实现） =====================
const splitSentences = (t) => t.split(/(?<=[。！？；])/).filter((s) => s.trim());
const quoteDelta = (s) =>
  (s.match(new RegExp(OPEN, 'g')) ?? []).length - (s.match(new RegExp(CLOSE, 'g')) ?? []).length;

/** 步骤 1：切句。步骤 2（可选）：引语未配平则向后并句，上限 quoteMax（0 = 不并句） */
function toUnits(text, quoteMax) {
  const out = [];
  for (const s of splitSentences(text)) {
    const prev = out[out.length - 1];
    if (quoteMax > 0 && prev && prev.open > 0 && prev.s.length + s.length <= quoteMax) {
      prev.s += s;
      prev.open = Math.max(0, prev.open + quoteDelta(s));
    } else {
      out.push({ s, open: Math.max(0, quoteDelta(s)) });
    }
  }
  return out;
}

/**
 * 步骤 3：顺序装箱到 target，不在 unit 内部切分（至少装 1 个 unit）。
 * closeQuoteCap > 0 时，箱尾引语未配平则继续吞入后续 unit 至配平或达上限；
 * 吞入的 unit 计入 end，下一箱从 end 继续，保证不重复、不遗漏（不变量 I1）。
 */
function packUnits(units, target, closeQuoteCap = 0) {
  const out = [];
  let start = 0;
  while (start < units.length) {
    let end = start;
    let len = 0;
    while (end < units.length && (len === 0 || len + units[end].s.length <= target)) {
      len += units[end].s.length;
      end++;
    }
    if (closeQuoteCap > 0) {
      let depth = units.slice(start, end).reduce((d, u) => d + quoteDelta(u.s), 0);
      while (depth > 0 && end < units.length && len + units[end].s.length <= closeQuoteCap) {
        depth += quoteDelta(units[end].s);
        len += units[end].s.length;
        end++;
      }
    }
    out.push(units.slice(start, end));
    if (end >= units.length) break;
    start = end;
  }
  return out;
}

/** 成对引语抽取：栈式配对，返回 [[open, close]]，按出现顺序（构建期，§3 步骤 6 / §5 quotes[]） */
function quotePairs(t) {
  const pairs = [];
  const stack = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === OPEN) stack.push(i);
    else if (t[i] === CLOSE && stack.length) pairs.push([stack.pop(), i]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/** 说话人：开引号前 14 字内 `X曰：“` 的 X；抽不到为 null */
const SPEAKER_RE = /([\u4e00-\u9fa5]{1,4})(曰|云|问|答|喝|叱|骂)：“$/;

/** 步骤 6：抽取 chunk 内的引语表（§5 quotes[]） */
function extractQuotes(text) {
  return quotePairs(text).map(([o, c], i) => {
    const head = text.slice(Math.max(0, o - 14), o + 1);
    const m = head.match(SPEAKER_RE);
    return { qid: `Q${i + 1}`, text: text.slice(o + 1, c), offset: o + 1, speaker: m ? m[1] : null };
  });
}

/** 步骤 4+5+6：按回组装（跨段）+ 尾部碎片软下限 + 可选重叠 + 引语表；记录 gid/partIdx/partN 供 I3 判据使用 */
function buildChunks(docs, { target, quoteMax = 0, crossSeg = true, minTarget = 0, overlapSent = 0, closeQuoteCap = 0, isolateType = true, mergeNext = false }) {
  const chunks = [];
  const emit = (items, type, gid, partIdx, partN) => {
    if (!items.length) return;
    const segs = [...new Set(items.map((x) => x.seg))];
    const text = items.map((x) => x.s).join('');
    chunks.push({
      text, segs, type, gid, partIdx, partN,
      chapter: docs[segs[0]].chapter,
      title: docs[segs[0]].title,
      firstSeg: docs[segs[0]].segIndex,
      lastSeg: docs[segs[segs.length - 1]].segIndex,
    });
  };
  for (const ch of [...new Set(docs.map((d) => d.chapter))]) {
    const idxs = docs.map((d, i) => (d.chapter === ch ? i : -1)).filter((i) => i >= 0);
    const groups = [];
    for (const i of idxs) {
      const items = toUnits(docs[i].text, quoteMax).map((u) => ({ ...u, seg: i }));
      const last = groups[groups.length - 1];
      if (!isolateType) {
        if (last) last.items.push(...items);
        else groups.push({ type: docs[i].type, items });
        continue;
      }
      const joinable = crossSeg && docs[i].type === 'narration' && last && last.type === 'narration';
      if (joinable) last.items.push(...items);
      else groups.push({ type: docs[i].type, items });
    }
    groups.forEach((g, gi) => {
      const parts = packUnits(g.items, target, closeQuoteCap);
      parts.forEach((p, pi) => emit(p, g.type, `${ch}:${gi}`, pi, parts.length));
    });
  }
  if (minTarget > 0) {
    const merged = [];
    for (const c of chunks) {
      const prev = merged[merged.length - 1];
      if (prev && prev.chapter === c.chapter && prev.type === c.type
          && c.text.length < minTarget && prev.text.length + c.text.length <= target * 1.6) {
        prev.text += c.text;
        prev.segs = [...new Set([...prev.segs, ...c.segs])];
        prev.lastSeg = c.lastSeg;
      } else merged.push({ ...c });
    }
    if (mergeNext) {
      const out2 = [];
      for (let i = 0; i < merged.length; i++) {
        const cur = merged[i];
        const next = merged[i + 1];
        if (cur.text.length < minTarget && next && next.chapter === cur.chapter && next.type === cur.type
            && cur.text.length + next.text.length <= target * 1.6) {
          next.text = cur.text + next.text;
          next.segs = [...new Set([...cur.segs, ...next.segs])];
          next.firstSeg = cur.firstSeg;
          continue;
        }
        out2.push(cur);
      }
      merged.length = 0;
      merged.push(...out2);
    }
    chunks.length = 0;
    chunks.push(...merged);
  }
  if (overlapSent > 0) {
    for (let i = 1; i < chunks.length; i++) {
      if (chunks[i].chapter !== chunks[i - 1].chapter) continue;
      chunks[i] = {
        ...chunks[i],
        text: splitSentences(chunks[i - 1].text).slice(-overlapSent).join('') + chunks[i].text,
      };
    }
  }
  for (const c of chunks) c.quotes = extractQuotes(c.text);
  return chunks;
}
/** 引号是否不配对（含引号的文本） */
const unpairedText = (t) => {
  const o = (t.match(new RegExp(OPEN, 'g')) ?? []).length;
  const c = (t.match(new RegExp(CLOSE, 'g')) ?? []).length;
  return o !== c;
};

/** 注入侧引语完整度：每个查询 top3 片段中是否含未配平引语（§4.5 主判据） */
function fragQuoteStat(units) {
  const bi = buildIndex(units.map((u) => norm(u.text)));
  let qAny = 0;
  let fragTotal = 0;
  let fragUnpaired = 0;
  for (const [q] of CASES) {
    const top = rankOf(bi, q).slice(0, 3);
    let any = false;
    for (const i of top) {
      if (!/[\u201c\u201d]/.test(units[i].text)) continue;
      fragTotal++;
      if (unpairedText(units[i].text)) { fragUnpaired++; any = true; }
    }
    if (any) qAny++;
  }
  return { qAny, fragTotal, fragUnpaired };
}

/** I3 真口径：把每个切点分类为「句末标点」「源段边界」「切在句内」 */
function classifyCuts(chunks, docs) {
  const TERM = '。！？；';
  const out = { sent: 0, seg: 0, mid: 0, forced: 0, chosen: 0, chosenBad: 0, forcedChars: {}, chosenChars: {}, examples: [] };
  for (const ch of [...new Set(docs.map((d) => d.chapter))]) {
    const segs = docs.filter((d) => d.chapter === ch);
    let stream = '';
    const sentEnds = new Set();
    const segEnds = new Set();
    for (const d of segs) {
      for (const s of splitSentences(d.text)) {
        stream += s;
        if (TERM.includes(s[s.length - 1])) sentEnds.add(stream.length);
      }
      segEnds.add(stream.length);
    }
    let off = 0;
    for (const c of chunks.filter((x) => x.chapter === ch)) {
      off += c.text.length;
      const isGroupEnd = c.partIdx === c.partN - 1;
      const lastChar = c.text[c.text.length - 1];
      if (isGroupEnd) { out.forced++; out.forcedChars[lastChar] = (out.forcedChars[lastChar] ?? 0) + 1; }
      else {
        out.chosen++;
        out.chosenChars[lastChar] = (out.chosenChars[lastChar] ?? 0) + 1;
        if (!TERM.includes(lastChar) && lastChar !== CLOSE) out.chosenBad++;
      }
      if (off === stream.length) continue;
      if (sentEnds.has(off)) out.sent++;
      else if (segEnds.has(off)) {
        out.seg++;
        if (!TERM.includes(lastChar) && lastChar !== CLOSE) {
          out.examples.push({ chapter: ch, from: c.firstSeg, to: c.lastSeg, len: c.text.length, tail: c.text.slice(-14) });
        }
      } else out.mid++;
    }
  }
  return out;
}

/** 答案引语可用性：分母=答案句位于源段成对引语内的用例；分子=命中块 quotes[] 能取到该引语（§4.5/§4.7） */
function quoteAvailStat(units) {
  const bi = buildIndex(units.map((u) => norm(u.text)));
  let avail = 0;
  for (const [q, re] of QUOTE_CASES) {
    const order = rankOf(bi, q);
    const hit = order.find((i) => re.test(units[i].text));
    if (hit === undefined) continue;
    const u = units[hit];
    const m = re.exec(u.text);
    const qs = u.quotes ?? quotePairs(u.text).map(([o, c]) => ({ text: u.text.slice(o + 1, c), offset: o + 1 }));
    if (qs.some((x) => {
      const at = u.text.indexOf(x.text, Math.max(0, x.offset - 1));
      return at >= 0 && at <= m.index && m.index <= at + x.text.length;
    })) avail++;
  }
  return { avail, total: QUOTE_CASES.length };
}

const fmtChars = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `「${k}」${v}`).join(' ');
// ===================== 语料 + 别名归一化 =====================
// 段级语料：构建期中间产物 _segments/sanguo-yanyi/{001..120}.json（{ source, chapter, title, segments[] }）
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

const aliasRaw = JSON.parse(readFileSync(`${SANGO_DIR}/data/alias.json`, 'utf8'));
const pidOf = new Map(Object.entries(aliasRaw));
const byPid = new Map();
for (const [name, pid] of Object.entries(aliasRaw)) {
  if (!byPid.has(pid)) byPid.set(pid, []);
  byPid.get(pid).push(name);
}
// 规范名选取依据：段级原始文本 df（与 sango-index.ts loadAliases 同口径：原始未归一化文本的 df）
const segDf = new Map();
for (const t of origTexts) for (const tok of new Set(tokenize(t))) segDf.set(tok, (segDf.get(tok) ?? 0) + 1);
const canonOf = new Map();
for (const [pid, names] of byPid) {
  canonOf.set(pid, names.slice().sort((a, b) => (segDf.get(b) ?? 0) - (segDf.get(a) ?? 0))[0]);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALIAS_PATTERN = new RegExp(
  [...pidOf.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g');
const norm = (t) => t.replace(ALIAS_PATTERN, (m) => canonOf.get(pidOf.get(m)));

// ===================== 用例集（与 sango-recall-bench.mjs 同一 24 例） =====================
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
const CASES = RAW.filter(([, re]) => origTexts.some((t) => re.test(t)));
const N = CASES.length;
const MAIN = CASES.findIndex(([q]) => q === MAIN_CASE);
/** 答案句位于源段成对引语内的用例（§4.5/§4.7 的分母） */
const QUOTE_CASES = CASES.filter(([, re]) => {
  const d = docs.find((x) => re.test(x.text));
  const m = re.exec(d.text);
  return quotePairs(d.text).some(([o, c]) => o < m.index && m.index < c);
});
const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
};
const sum = (a) => a.reduce((x, y) => x + y, 0);

// ===================== BM25（与 sango-index.ts 同参数） =====================
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
  return { toks, postings, df, avg: sum(toks.map((t) => t.length)) / texts.length, n: texts.length };
}
function rankOf(bi, query) {
  const score = new Float64Array(bi.n);
  for (const t of tokenize(norm(query))) {
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

// ===================== 指标 =====================
function measure(label, units) {
  const bi = buildIndex(units.map((u) => norm(u.text)));
  const orders = CASES.map(([q]) => rankOf(bi, q));
  const ranks = CASES.map(([q, re], ci) => {
    const r = orders[ci].findIndex((i) => re.test(units[i].text));
    return r < 0 ? -1 : r + 1;
  });
  let quoted = 0;
  let unpaired = 0;
  for (const u of units) {
    const o = (u.text.match(new RegExp(OPEN, 'g')) ?? []).length;
    const c = (u.text.match(new RegExp(CLOSE, 'g')) ?? []).length;
    if (o + c > 0) quoted++;
    if (o !== c) unpaired++;
  }
  const cov = (budget) => CASES.filter(([, re], ci) => {
    let used = 0;
    for (const i of orders[ci]) {
      if (used + units[i].text.length > budget) break;
      used += units[i].text.length;
      if (re.test(units[i].text)) return true;
    }
    return false;
  }).length;
  let dup = 0;
  for (let ci = 0; ci < N; ci++) {
    const top = orders[ci].slice(0, 5).map((i) => new Set(splitSentences(units[i].text)));
    let f = false;
    for (let a = 0; a < top.length && !f; a++) {
      for (let b = a + 1; b < top.length; b++) {
        for (const s of top[a]) if (top[b].has(s)) { f = true; break; }
      }
    }
    if (f) dup++;
  }
  const lens = units.map((u) => u.text.length);
  return {
    label, units, n: units.length, avg: Math.round(sum(lens) / lens.length),
    min: Math.min(...lens), p50: pct(lens, 0.5), p90: pct(lens, 0.9), max: Math.max(...lens),
    tiny: lens.filter((l) => l < 80).length,
    hit1: ranks.filter((r) => r > 0 && r <= 1).length,
    hit3: ranks.filter((r) => r > 0 && r <= 3).length,
    hit5: ranks.filter((r) => r > 0 && r <= 5).length,
    unpaired, quoted, cov750: cov(750), cov1000: cov(1000), dup,
    main: MAIN >= 0 ? ranks[MAIN] : -1,
    broken: CASES.filter(([, re]) => !units.some((u) => re.test(u.text))).length,
    crossSeg: units.filter((u) => u.segs && u.segs.length > 1).length,
  };
}
const HEAD = '配置'.padEnd(28) + 'chunk'.padEnd(7) + '均长'.padEnd(6) + '最短'.padEnd(6) + 'p90'.padEnd(6) + 'max'.padEnd(7)
  + '引号断'.padEnd(9) + '@1'.padEnd(7) + '@3'.padEnd(7) + '@5'.padEnd(7)
  + '750覆盖'.padEnd(9) + '1000覆盖'.padEnd(10) + 'top5重复'.padEnd(10) + '主案例';
const row = (m) =>
  m.label.padEnd(28) + String(m.n).padEnd(7) + String(m.avg).padEnd(6) + String(m.min).padEnd(6) + String(m.p90).padEnd(6) + String(m.max).padEnd(7)
  + `${Math.round((m.unpaired / m.quoted) * 100)}%`.padEnd(9) + `${m.hit1}/${N}`.padEnd(7) + `${m.hit3}/${N}`.padEnd(7) + `${m.hit5}/${N}`.padEnd(7)
  + `${m.cov750}/${N}`.padEnd(9) + `${m.cov1000}/${N}`.padEnd(10) + `${m.dup}/${N}`.padEnd(10)
  + `#${m.main < 0 ? 'miss' : m.main}`;

// ===================== §1 现状长度分布 =====================
const segLens = origTexts.map((t) => t.length);
const sentLens = origTexts.flatMap(splitSentences).map((s) => s.length);
console.log('=== 1 现状长度分布（单位：汉字数）===');
console.log(`段 ${segLens.length} 个 / 合计 ${sum(segLens)} 字 / 平均 ${Math.round(sum(segLens) / segLens.length)} 字`);
console.log(`段长 p10=${pct(segLens, 0.1)} p50=${pct(segLens, 0.5)} p90=${pct(segLens, 0.9)} p99=${pct(segLens, 0.99)} max=${Math.max(...segLens)}`);
console.log(`句 ${sentLens.length} 个 / 平均 ${Math.round(sum(sentLens) / sentLens.length)} 字 / p50=${pct(sentLens, 0.5)} p90=${pct(sentLens, 0.9)} p99=${pct(sentLens, 0.99)} max=${Math.max(...sentLens)}`);
for (const t of ['narration', 'verse', 'comment']) {
  const ls = docs.filter((d) => d.type === t).map((d) => d.text.length);
  if (ls.length) console.log(`  ${t}: ${ls.length} 段 / 平均 ${Math.round(sum(ls) / ls.length)} 字 / max ${Math.max(...ls)}`);
}
console.log(`  段长 > 250 字：${segLens.filter((l) => l > 250).length}（${Math.round((segLens.filter((l) => l > 250).length / segLens.length) * 100)}%）`);

const baseline = measure('现状：整段（段级）', docs.map((d, i) => ({
  text: d.text, segs: [i], chapter: d.chapter, title: d.title, firstSeg: d.segIndex, lastSeg: d.segIndex,
})));

console.log('\n=== 2 尺寸扫描（句边界 / 跨段 / 软下限 100 / 无重叠）===');
console.log(HEAD);
console.log(row(baseline));
for (const target of [150, 200, 250, 300, 400]) {
  console.log(row(measure(`目标 ${target} 字`, buildChunks(docs, { target, minTarget: 100 }))));
}

console.log('\n=== 3 重叠量扫描（目标 250 / 句边界 / 跨段 / 软下限 100）===');
console.log(HEAD);
for (const ov of [0, 1, 2]) {
  console.log(row(measure(ov === 0 ? '无重叠（推荐）' : `重叠 ${ov} 句（≈${ov * 18} 字）`, buildChunks(docs, { target: 250, minTarget: 100, overlapSent: ov }))));
}

console.log('\n=== 4 跨段开关（目标 250 / 句边界 / 软下限 100 / 无重叠）===');
console.log(HEAD);
console.log(row(measure('不跨段（段内切分）', buildChunks(docs, { target: 250, crossSeg: false, minTarget: 100 }))));
console.log(row(measure('章内跨段（推荐）', buildChunks(docs, { target: 250, crossSeg: true, minTarget: 100 }))));

console.log('\n=== 5 尾部碎片软下限（目标 250 / 句边界 / 跨段 / 无重叠）===');
console.log(HEAD + '  tiny');
for (const minTarget of [0, 100, 150, 200]) {
  const m = measure(minTarget === 0 ? '软下限 0（不并块）' : `软下限 ${minTarget} 字`, buildChunks(docs, { target: 250, minTarget }));
  console.log(row(m).padEnd(136) + String(m.tiny));
}

console.log('\n=== 6 引语配平上限（目标 250 / 跨段 / 软下限 100 / 无重叠）===');
console.log(HEAD);
for (const quoteMax of [0, 200, 300, 500, Infinity]) {
  const label = quoteMax === 0 ? '上限 0（不并句）' : quoteMax === Infinity ? '上限 不限（完全原子）' : `上限 ${quoteMax} 字`;
  console.log(row(measure(label, buildChunks(docs, { target: 250, quoteMax, minTarget: 100 }))));
}

console.log('\n=== 6b 箱尾引语配平延伸（目标 250 / 跨段 / 软下限 100 / 无重叠）===');
console.log(HEAD);
console.log(row(measure('不延伸', buildChunks(docs, { target: 250, minTarget: 100 }))));
for (const cap of [300, 400, 500]) {
  console.log(row(measure(`延伸至 ${cap} 字`, buildChunks(docs, { target: 250, minTarget: 100, closeQuoteCap: cap }))));
}

const TYPE_LABEL_LOCAL = { narration: '叙述', verse: '诗词', comment: '评注' };

// ===================== §7 推荐配置 =====================
const RECOMMEND = { target: 250, quoteMax: 0, crossSeg: true, minTarget: 100, overlapSent: 0, closeQuoteCap: 400 };
const rec = measure('推荐', buildChunks(docs, RECOMMEND));
const baseUnits = docs.map((d, i) => ({ text: d.text, segs: [i], chapter: d.chapter, title: d.title, firstSeg: d.segIndex, lastSeg: d.segIndex }));
console.log('\n=== 7 推荐配置 vs 现状 ===');
console.log('指标'.padEnd(30) + '现状（段级）'.padEnd(18) + '推荐（chunk 250）');
for (const [k, a, b] of [
  ['检索单元数', baseline.n, rec.n],
  ['单元长度 均/最短/p90/max', `${baseline.avg}/${baseline.min}/${baseline.p90}/${baseline.max}`, `${rec.avg}/${rec.min}/${rec.p90}/${rec.max}`],
  ['长度 < 80 字的块', baseline.tiny, rec.tiny],
  ['召回 @1', `${baseline.hit1}/${N}`, `${rec.hit1}/${N}`],
  ['召回 @3', `${baseline.hit3}/${N}`, `${rec.hit3}/${N}`],
  ['召回 @5', `${baseline.hit5}/${N}`, `${rec.hit5}/${N}`],
  ['750 字注入预算覆盖', `${baseline.cov750}/${N}`, `${rec.cov750}/${N}`],
  ['1000 字注入预算覆盖', `${baseline.cov1000}/${N}`, `${rec.cov1000}/${N}`],
  ['引号不配对占比（库级）', `${Math.round((baseline.unpaired / baseline.quoted) * 100)}%`, `${Math.round((rec.unpaired / rec.quoted) * 100)}%`],
  ['注入侧含断引语查询（top3）', `${fragQuoteStat(baseUnits).qAny}/${N}`, `${fragQuoteStat(rec.units).qAny}/${N}`],
  ['答案句被切碎（天花板）', `${baseline.broken}/${N}`, `${rec.broken}/${N}`],
  ['top5 近重复', `${baseline.dup}/${N}`, `${rec.dup}/${N}`],
  ['跨段 chunk', '0', `${rec.crossSeg}（${Math.round((rec.crossSeg / rec.n) * 100)}%）`],
  ['主案例（第73回 段5）排名', `#${baseline.main}`, `#${rec.main}`],
]) console.log(String(k).padEnd(30) + String(a).padEnd(18) + String(b));

// ===================== §7b 引语配平方式对比（§4.5）=====================
console.log('\n=== 7b 引语配平方式对比（目标 250 / 跨段 / 软下限 100 / 无重叠）===');
console.log('配置'.padEnd(16) + 'chunk'.padEnd(7) + '均长'.padEnd(6) + 'max'.padEnd(7)
  + '引号断(库)'.padEnd(12) + '注入侧断引语'.padEnd(14) + '答案引语可用'.padEnd(14)
  + '@1'.padEnd(7) + '@3'.padEnd(7) + '750覆盖'.padEnd(9) + '1000覆盖'.padEnd(10) + 'top5重复'.padEnd(10) + '主案例');
{
  const rows = [
    ['现状（整段）', baseUnits],
    ['不延伸', buildChunks(docs, { target: 250, minTarget: 100 })],
    ['并句至 200 字', buildChunks(docs, { target: 250, quoteMax: 200, minTarget: 100 })],
    ['并句至 300 字', buildChunks(docs, { target: 250, quoteMax: 300, minTarget: 100 })],
    ['延伸至 400 字', buildChunks(docs, { target: 250, minTarget: 100, closeQuoteCap: 400 })],
    ['延伸至 500 字', buildChunks(docs, { target: 250, minTarget: 100, closeQuoteCap: 500 })],
  ];
  for (const [label, units] of rows) {
    const m = measure(label, units);
    const st = fragQuoteStat(units);
    const qa = quoteAvailStat(units);
    const lens = units.map((u) => u.text.length);
    console.log(label.padEnd(16) + String(units.length).padEnd(7) + String(Math.round(sum(lens) / lens.length)).padEnd(6)
      + String(Math.max(...lens)).padEnd(7) + `${Math.round((m.unpaired / m.quoted) * 100)}%`.padEnd(12)
      + `${st.qAny}/${N}`.padEnd(14) + `${qa.avail}/${qa.total}`.padEnd(14)
      + `${m.hit1}/${N}`.padEnd(7) + `${m.hit3}/${N}`.padEnd(7)
      + `${m.cov750}/${N}`.padEnd(9) + `${m.cov1000}/${N}`.padEnd(10)
      + `${m.dup}/${N}`.padEnd(10) + `#${m.main}`);
  }
}

// ===================== §7b2 引语配平上限对 chunk 长度的影响 =====================
console.log('\n=== 7b2 配平上限对 chunk 长度的影响（I7 与注入可预期性）===');
console.log('上限'.padEnd(10) + 'chunk'.padEnd(8) + '均长'.padEnd(6) + 'max'.padEnd(7) + '超400字块'.padEnd(11) + '超500字块'.padEnd(11) + '注入侧断引语');
for (const cap of [400, 500, 600]) {
  const cs = buildChunks(docs, { target: 250, minTarget: 100, closeQuoteCap: cap });
  const lens = cs.map((c) => c.text.length);
  const st = fragQuoteStat(cs);
  console.log(`上限 ${cap}`.padEnd(10) + String(cs.length).padEnd(8) + String(Math.round(sum(lens) / lens.length)).padEnd(6)
    + String(Math.max(...lens)).padEnd(7) + String(lens.filter((l) => l > 400).length).padEnd(11)
    + String(lens.filter((l) => l > 500).length).padEnd(11) + `${st.qAny}/${N}`);
}

// ===================== §7c 跨段（开延伸 400 后对照）=====================
console.log('\n=== 7c 跨段 vs 不跨段（均开引语延伸 400）===');
console.log(HEAD + '  tiny');
for (const [label, cs] of [
  ['不跨段+延伸400', buildChunks(docs, { target: 250, crossSeg: false, minTarget: 100, closeQuoteCap: 400 })],
  ['跨段+延伸400（终配）', buildChunks(docs, { target: 250, crossSeg: true, minTarget: 100, closeQuoteCap: 400 })],
]) {
  const m = measure(label, cs);
  console.log(row(m).padEnd(136) + String(m.tiny));
}

// ===================== §7d verse 隔离 vs 不隔离（§4.6）=====================
console.log('\n=== 7d verse 隔离 vs 不隔离（终配参数）===');
for (const [label, cs] of [
  ['隔离 type（终配）', buildChunks(docs, { ...RECOMMEND, isolateType: true })],
  ['不隔离 type', buildChunks(docs, { ...RECOMMEND, isolateType: false })],
]) {
  const m = measure(label, cs);
  const byType = {};
  for (const c of cs) byType[c.type] = (byType[c.type] ?? 0) + 1;
  console.log('  ' + label.padEnd(16) + 'chunk ' + String(cs.length).padEnd(7)
    + '@1 ' + `${m.hit1}/${N}`.padEnd(7) + '@3 ' + `${m.hit3}/${N}`.padEnd(7)
    + '750覆盖 ' + `${m.cov750}/${N}`.padEnd(7) + '类型分布 ' + JSON.stringify(byType));
}

// ===================== §8 不变量校验 =====================
console.log('\n=== 8 不变量校验（I1~I9）===');
const chunks = buildChunks(docs, RECOMMEND);
let mismatch = 0;
for (const ch of [...new Set(docs.map((d) => d.chapter))]) {
  const joined = chunks.filter((c) => c.chapter === ch).map((c) => c.text).join('');
  const origin = docs.filter((d) => d.chapter === ch).map((d) => d.text).join('');
  if (joined !== origin) mismatch++;
}
// I3 真口径：切点落在句末标点，或落在源段边界（源文本该处本无句末标点）
const cut = classifyCuts(chunks, docs);
// I9：quotes[] 覆盖 chunk 内全部成对引语
let quoteMiss = 0;
for (const c of chunks) if (c.quotes.length !== quotePairs(c.text).length) quoteMiss++;
console.log(`  I1 同回 chunk 拼接 === 原文段拼接：${mismatch === 0 ? 'PASS' : `FAIL（${mismatch} 回）`}`);
console.log(`  I2 chunk 跨回（应为 0）：${chunks.filter((c) => new Set(c.segs.map((s) => docs[s].chapter)).size > 1).length}`);
console.log(`  I3 切点落在句末标点或源段边界（应为 0 违规）：句末标点 ${cut.sent}｜源段边界 ${cut.seg}｜切在句内 ${cut.mid}`);
console.log(`  I4 答案句被切碎（应为 0）：${rec.broken}`);
console.log(`  I5 chunk 元数据完整性（chapter/title/segFrom/segTo/type/quoteBalanced）：${chunks.every((c) => c.chapter && c.title && c.firstSeg !== undefined && c.lastSeg !== undefined && c.type) ? 'PASS' : 'FAIL'}`);
console.log(`  I6 文本内含元数据（应为 0）：${chunks.filter((c) => /【出处】|第\d+回|段\d+/.test(c.text)).length}`);
console.log(`  I7 chunk 超配平上限 400 字（应为 0）：${chunks.filter((c) => c.text.length > 400).length}`);
console.log(`  I8 长度 < 80 字的 chunk：${rec.tiny}（占 ${(rec.tiny / chunks.length * 100).toFixed(1)}%，成因见 §10，接受）`);
console.log(`  I9 quotes[] 覆盖 chunk 内全部成对引语（应为 0 漏抽）：${quoteMiss}`);
console.log(`  （参考）chunk 超目标 250 字：${chunks.filter((c) => c.text.length > 250).length} / ${chunks.length}（延伸所致，受 I7 约束）`);

// ===================== §9 切点分类（I3 真口径）=====================
console.log('\n=== 9 切点分类（I3 真口径）===');
console.log(`  段/组末尾强制边界：${cut.forced}｜组内主动切点：${cut.chosen}`);
console.log(`  强制边界末字：${fmtChars(cut.forcedChars)}`);
console.log(`  主动切点末字：${fmtChars(cut.chosenChars)}`);
console.log(`  主动切点中「既非句末标点也非收引号」（应为 0）：${cut.chosenBad}`);
console.log('  非句末标点的强制边界（源段本身如此，非算法切句内）：');
for (const b of cut.examples) console.log(`    第${b.chapter}回 段${b.from}-${b.to} 长${b.len} 尾「${b.tail}」`);

// ===================== §10 尾部碎片成因 =====================
console.log('\n=== 10 长度 < 80 字残余块的成因 ===');
for (const c of chunks.filter((x) => x.text.length < 80)) {
  const arr = chunks.filter((x) => x.chapter === c.chapter);
  const i = arr.indexOf(c);
  const prev = i > 0 ? arr[i - 1] : null;
  let why;
  if (!prev) why = '该回首块，无前块';
  else if (prev.type !== c.type) why = `前块类型不同（${prev.type}）`;
  else if (prev.text.length + c.text.length > 400) why = `前块 ${prev.text.length} 字，并入即越 400 上限`;
  else why = `其他（前块 ${prev.text.length} 字）`;
  console.log(`    第${c.chapter}回 段${c.firstSeg} 长${c.text.length} 类型${c.type} → ${why}`);
}
const noNext = chunks.filter((x) => x.text.length < 80).filter((c) => {
  const arr = chunks.filter((x) => x.chapter === c.chapter);
  return arr.indexOf(c) === arr.length - 1;
}).length;
console.log(`  其中同时是该回末块：${noNext}/${chunks.filter((x) => x.text.length < 80).length}`);
const withNext = buildChunks(docs, { ...RECOMMEND, mergeNext: true });
console.log(`  补「并入后块」分支后：chunk ${chunks.length}→${withNext.length}｜<80 字块 ${chunks.filter((x) => x.text.length < 80).length}→${withNext.filter((x) => x.text.length < 80).length}`);

// ===================== §11 verse 标注质量（已知缺陷）=====================
console.log('\n=== 11 verse 标注质量（§4.6 已知缺陷登记）===');
const VERSE_MARKERS = ['诗曰', '诗云', '诗赞', '有诗', '古风', '调寄', '歌曰', '赞曰', '词曰', '赋曰', '诗一首', '后人有诗', '后人诗曰', '诗吟', '诗罢'];
const firstMark = (t) => {
  let pos = -1;
  for (const mk of VERSE_MARKERS) { const p = t.indexOf(mk); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  return pos;
};
const verseSegs = docs.filter((d) => d.type === 'verse');
let pure = 0, fused = 0, noMark = 0;
for (const d of verseSegs) {
  const pos = firstMark(d.text);
  if (pos < 0) noMark++;
  else if (pos / d.text.length > 0.3) fused++;
  else pure++;
}
console.log(`  源段：verse ${verseSegs.length} 段｜纯诗（标记在开头 30% 内）${pure}｜叙述+诗融合（标记在 30% 之后）${fused}｜无标记 ${noMark}`);
let vPure = 0, vFused = 0, vNone = 0;
for (const c of chunks) {
  if (!c.segs.some((s) => docs[s].type === 'verse')) continue;
  const pos = firstMark(c.text);
  if (pos < 0) vNone++;
  else if (pos / c.text.length > 0.3) vFused++;
  else vPure++;
}
console.log(`  chunk（终配/隔离）：verse 类 ${vPure + vFused + vNone} 个｜纯诗 ${vPure}｜叙述+诗融合 ${vFused}｜无标记 ${vNone}`);

// ===================== §12 引语表规模与输出 token 账 =====================
console.log('\n=== 12 引语表规模与输出 token 账（§6.2）===');
const allPairs = docs.flatMap((d) => quotePairs(d.text));
const qLens = allPairs.map(([o, c]) => c - o - 1).filter((l) => l > 0);
console.log(`  全库成对引语 ${qLens.length} 条｜本体合计 ${sum(qLens)} 字｜均 ${Math.round(sum(qLens) / qLens.length)}｜p50 ${pct(qLens, 0.5)}｜p90 ${pct(qLens, 0.9)}｜p99 ${pct(qLens, 0.99)}｜max ${Math.max(...qLens)}`);
const spkOk = docs.flatMap((d) => quotePairs(d.text).map(([o]) => d.text.slice(Math.max(0, o - 14), o + 1))).filter((h) => SPEAKER_RE.test(h)).length;
console.log(`  speaker 可抽取：${spkOk}/${allPairs.length}（${Math.round((spkOk / allPairs.length) * 100)}%）`);
console.log(`  语料 JSON 增量估算：约 ${Math.round((sum(qLens) * 3 + allPairs.length * 30) / 1024)} KB（一次性构建产物）`);
const tokRows = [];
for (const [, re] of CASES) {
  const d = docs.find((x) => re.test(x.text));
  const m = re.exec(d.text);
  const enc = quotePairs(d.text).find(([o, c]) => o < m.index && m.index < c);
  if (!enc) continue;
  const qlen = enc[1] - enc[0] - 1;
  const suffix = `（出处：第${d.chapter}回 ${d.title}）`.length;
  tokRows.push({ qlen, suffix, cur: qlen + 2 + suffix });
}
const curLens = tokRows.map((r) => r.cur);
const ql = tokRows.map((r) => r.qlen);
console.log(`  分母：24 例中答案句落在成对引语内 = ${tokRows.length}/${N}`);
console.log(`  引语本体：均 ${Math.round(sum(ql) / ql.length)} 字｜p50 ${pct(ql, 0.5)}｜p90 ${pct(ql, 0.9)}｜max ${Math.max(...ql)}`);
console.log(`  出处后缀：均 ${Math.round(sum(tokRows.map((r) => r.suffix)) / tokRows.length)} 字`);
console.log(`  现状单条引用须吐：均 ${Math.round(sum(curLens) / curLens.length)} 字｜p50 ${pct(curLens, 0.5)}｜p90 ${pct(curLens, 0.9)}｜max ${Math.max(...curLens)}`);
console.log(`  新方案只吐指针（如「[Q2]」5 字）：单条省 ${Math.round(sum(curLens) / curLens.length) - 5} 字（${Math.round((1 - 5 / (sum(curLens) / curLens.length)) * 100)}%），最长一条省 ${Math.max(...curLens) - 5} 字`);
const hdrLens = docs.map((d) => `【出处】第${d.chapter}回 ${d.title} · 段${d.segIndex}（${TYPE_LABEL_LOCAL[d.type] ?? d.type}）`.length);
console.log(`  现状出处头（formatDoc）：均 ${Math.round(sum(hdrLens) / hdrLens.length)} 字｜p50 ${pct(hdrLens, 0.5)}｜max ${Math.max(...hdrLens)}（top3 注入省约 ${Math.round(sum(hdrLens) / hdrLens.length) * 3} 字）`);

// ===================== §13 父子分块（top3 口径）=====================
console.log('\n=== 13 父子分块（§4.7，口径：答案句落在引语内的用例）===');
const quoteCases = CASES.filter(([, re]) => {
  const d = docs.find((x) => re.test(x.text));
  const m = re.exec(d.text);
  return quotePairs(d.text).some(([o, c]) => o < m.index && m.index < c);
});
const enclosing = (t, i) => quotePairs(t).find(([o, c]) => o < i && i < c);
const parentStat = (units, segsOf) => {
  const bi = buildIndex(units.map((u) => norm(u.text)));
  const orders = quoteCases.map(([q]) => rankOf(bi, q));
  let childOk = 0, parentOk = 0, childChars = 0, parentChars = 0;
  quoteCases.forEach(([, re], ci) => {
    const top = orders[ci].slice(0, 3);
    const hit = top.find((i) => re.test(units[i].text));
    childChars += sum(top.map((i) => units[i].text.length));
    if (hit !== undefined) {
      const t = units[hit].text;
      if (enclosing(t, re.exec(t).index)) childOk++;
    }
    const segIdx = new Set();
    for (const i of top) for (const s of segsOf(i)) segIdx.add(s);
    const parentText = [...segIdx].map((s) => docs[s].text).join('');
    const pm = re.exec(parentText);
    if (pm && enclosing(parentText, pm.index)) parentOk++;
    parentChars += parentText.length;
  });
  return { childOk, parentOk, childChars: Math.round(childChars / quoteCases.length), parentChars: Math.round(parentChars / quoteCases.length) };
};
for (const [label, st] of [
  ['现状（段级）', parentStat(baseUnits, (i) => [i])],
  ['推荐（chunk 250）', parentStat(rec.units, (i) => rec.units[i].segs)],
]) {
  console.log(`  ${label}：top3 子级含完整答案引语 ${st.childOk}/${quoteCases.length}｜top3 父级（源段）含 ${st.parentOk}/${quoteCases.length}｜子级注入 ${st.childChars} 字｜父级注入 ${st.parentChars} 字`);
}
