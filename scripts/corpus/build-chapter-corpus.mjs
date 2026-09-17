#!/usr/bin/env node
/**
 * 三国演义原文 → 章节语料 JSON（段落级 + 段落类型标注）
 *
 * 用法：node scripts/corpus/build-chapter-corpus.mjs [--chapters 5] [--source <txt>] [--out <dir>]
 * 输出：data/sango-novel/corpus/chapter-XXX.json
 *   { chapter, title, source, meta, paragraphs: [{ seq, text, type }] }
 *   type: narration | verse | commentary
 *
 * 说明：源文件为整本 txt（UTF-8），含站点杂质行，由本脚本按回目切分并清洗。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const SOURCE = resolve(REPO_ROOT, argOf('source', 'data/sango-novel/source/sanguo-yanyi-maoben.txt'));
const OUT_DIR = resolve(REPO_ROOT, argOf('out', 'data/sango-novel/corpus'));
const CHAPTERS = String(argOf('chapters', '5'))
  .split(',')
  .map((v) => Number(v.trim()));

const CHAPTER_LINE = /^第([一二三四五六七八九十百零〇]+)回\s*(.*)$/;
const NOISE_LINE = /(更新时间[:：]|本章字数|版权归|作品版权|^----|本书由|请购买|https?:\/\/|www\.)/;
const COMMENTARY_MARK = /(评曰：|批曰：|【评】)/;
const VERSE_LEAD = /(后人有诗[^：]{0,12}曰：|后有诗曰：|诗曰：|赞曰：)/;

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 汉字数字 → 整数（覆盖「五」「十」「二十」「一百二十」） */
function cnToNumber(text) {
  if (text.includes('百')) {
    const [head, rest] = text.split('百');
    return (head === '' ? 1 : cnToNumber(head)) * 100 + (rest === '' ? 0 : cnToNumber(rest));
  }
  if (!text.includes('十')) {
    let n = 0;
    for (const ch of text) {
      if (CN_DIGIT[ch] === undefined) throw new Error(`无法解析回目数字：${text}`);
      n = n * 10 + CN_DIGIT[ch];
    }
    return n;
  }
  const [head, tail] = text.split('十');
  const tens = head === '' ? 1 : CN_DIGIT[head];
  const ones = tail === '' ? 0 : CN_DIGIT[tail];
  return tens * 10 + ones;
}

/** 段落内嵌诗赞（如「后人有诗赞之曰：“…”」）拆为独立 verse 段，两侧叙事仍为 narration */
function splitParagraph(text) {
  const match = text.match(VERSE_LEAD);
  if (!match) {
    return [{ text, type: COMMENTARY_MARK.test(text) ? 'commentary' : 'narration' }];
  }
  const start = match.index;
  const quoteEnd = Math.max(text.indexOf('”', start), text.indexOf('」', start));
  const end = quoteEnd === -1 ? text.length : quoteEnd + 1;
  const before = text.slice(0, start).trim();
  const verse = text.slice(start, end).trim();
  const after = text.slice(end).trim();
  const out = [];
  if (before) out.push({ text: before, type: 'narration' });
  out.push({ text: verse, type: 'verse' });
  if (after) out.push(...splitParagraph(after));
  return out;
}

function buildParagraphs(lines) {
  const paragraphs = [];
  for (const line of lines) {
    const text = line.trim().replace(/^正文\s*/, '');
    if (!text || NOISE_LINE.test(text)) continue;
    for (const part of splitParagraph(text)) {
      if (!part.text) continue;
      paragraphs.push({ seq: paragraphs.length + 1, text: part.text, type: part.type });
    }
  }
  return paragraphs;
}

const raw = readFileSync(SOURCE, 'utf8');
const lines = raw.split(/\r?\n/);
const heads = [];
lines.forEach((line, index) => {
  const match = line.trim().replace(/^正文\s*/, '').match(CHAPTER_LINE);
  if (match) heads.push({ line: index, num: cnToNumber(match[1]), title: match[2].trim() });
});
if (heads.length === 0) throw new Error(`未识别到回目行，源文件格式不符：${SOURCE}`);

mkdirSync(OUT_DIR, { recursive: true });
for (const want of CHAPTERS) {
  const at = heads.findIndex((h) => h.num === want);
  if (at === -1) throw new Error(`源文件中找不到第 ${want} 回`);
  const start = heads[at].line + 1;
  const end = at + 1 < heads.length ? heads[at + 1].line : lines.length;
  const paragraphs = buildParagraphs(lines.slice(start, end));
  const payload = {
    chapter: want,
    title: heads[at].title,
    source: '三国演义（毛本，120 回）',
    meta: {
      generatedBy: 'scripts/corpus/build-chapter-corpus.mjs',
      sourceFile: relative(REPO_ROOT, SOURCE).replace(/\\/g, '/'),
      paragraphCount: paragraphs.length,
      paragraphTypes: ['narration', 'verse', 'commentary'],
    },
    paragraphs,
  };
  const file = resolve(OUT_DIR, `chapter-${String(want).padStart(3, '0')}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(
    `第 ${want} 回 ${heads[at].title} → ${relative(REPO_ROOT, file).replace(/\\/g, '/')}（段落 ${paragraphs.length}）`
  );
}