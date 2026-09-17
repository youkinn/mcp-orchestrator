#!/usr/bin/env node
/**
 * 投毒语料生成器（探针 A 专用）
 *
 * 用法：node scripts/probe/build-poison-corpus.mjs
 * 读：data/sango-novel/corpus/chapter-005.json（正式语料，只读）
 *      data/sango-novel/probe/h2-cases.json（替换表 + 校验清单）
 * 写：data/sango-novel/probe/poison-chapter-005.json
 *
 * 红线：投毒语料物理隔离在 data/sango-novel/probe/，文件名含 poison，
 *       文件头写明用途；禁止用于生产、禁止移入 corpus/。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CASES_FILE = resolve(REPO_ROOT, 'data/sango-novel/probe/h2-cases.json');

const cases = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
const srcFile = resolve(REPO_ROOT, cases.corpus.baseline);
const outFile = resolve(REPO_ROOT, cases.corpus.poison);

if (!basename(outFile).includes('poison') || !outFile.split(/[\\/]/).includes('probe')) {
  throw new Error(`投毒语料必须落在 probe/ 目录且文件名含 poison：${outFile}`);
}

const corpus = JSON.parse(readFileSync(srcFile, 'utf8'));
const applyEdits = (text) =>
  cases.poisonEdits.reduce((acc, edit) => acc.split(edit.from).join(edit.to), text);

const paragraphs = corpus.paragraphs.map((p) => ({ ...p, text: applyEdits(p.text) }));
const joined = paragraphs.map((p) => p.text).join('\n');

for (const name of cases.poisonForbiddenNames) {
  if (joined.includes(name)) throw new Error(`投毒语料残留原名「${name}」，替换表不完整`);
}
for (const name of cases.poisonRequiredNames) {
  if (!joined.includes(name)) throw new Error(`投毒语料未出现替换名「${name}」`);
}

const payload = {
  _warning: '投毒语料：仅用于探针 A（H2 忠实度）与回归评测，禁止用于生产、禁止移入 corpus/',
  _generatedBy: 'scripts/probe/build-poison-corpus.mjs',
  _generatedFrom: cases.corpus.baseline,
  _edits: cases.poisonEdits,
  chapter: corpus.chapter,
  title: corpus.title,
  source: `${corpus.source}（已投毒改写，非原文）`,
  paragraphs,
};

writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`投毒语料已生成 → ${cases.corpus.poison}（段落 ${paragraphs.length}，替换 ${cases.poisonEdits.length} 条规则）`);