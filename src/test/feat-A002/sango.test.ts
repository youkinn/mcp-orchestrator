import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SangoService,
  normalize,
 SANGO_NO_SESSION_PROMPT,
  type SangoOptionKey,
  type SangoQuestion,
} from '../../sango.js';

const XIAHOU_DUN_QUESTION: SangoQuestion = {
  question: '夏侯惇的字是什么？',
  options: { A: '元让', B: '妙才', C: '子龙', D: '云长' },
  answer: '元让',
};

const LV_BU_QUESTION: SangoQuestion = {
  question: '吕布的字是什么？',
  options: { A: '奉孝', B: '奉先', C: '公瑾', D: '伯符' },
  answer: '奉先',
};

const VALID_ENTRIES = [XIAHOU_DUN_QUESTION, LV_BU_QUESTION];

const XIAHOU_YUAN_QUESTION: SangoQuestion = {
  question: '夏侯渊的字是什么？',
  options: { A: '元让', B: '妙才', C: '奉先', D: '仲达' },
  answer: '妙才',
};

const LEBUSISHU_QUESTION: SangoQuestion = {
  question: '“乐不思蜀”的典故指的是谁？',
  options: { A: '刘禅', B: '刘备', C: '刘协', D: '刘封' },
  answer: '刘禅',
};

/** 召回用例题库：含同类干扰题（夏侯惇/夏侯渊）与换问法目标题（乐不思蜀） */
const CANDIDATE_ENTRIES = [
  XIAHOU_DUN_QUESTION,
  XIAHOU_YUAN_QUESTION,
  LEBUSISHU_QUESTION,
];

const BAD_ENTRIES: unknown[] = [
  { question: '缺选项', options: { A: '甲', B: '乙' }, answer: '甲' },
  {
    question: '答案不在选项中',
    options: { A: '甲', B: '乙', C: '丙', D: '丁' },
    answer: '戊',
  },
  {
    question: '',
    options: { A: '甲', B: '乙', C: '丙', D: '丁' },
    answer: '甲',
  },
  '不是对象',
  { question: '无 options', answer: '甲' },
];

function writeQuestionFile(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'sango-test-'));
  const file = join(dir, 'questions.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  return file;
}

function cleanupQuestionFile(file: string): void {
  rmSync(dirname(file), { recursive: true, force: true });
}

function makeFixtureService(
  t: TestContext,
  entries: unknown[] = VALID_ENTRIES
): SangoService {
  const file = writeQuestionFile(entries);
  t.after(() => cleanupQuestionFile(file));
  return new SangoService({ questionFile: file });
}
test('load: 合法题加载，坏行跳过并告警，服务不挂', (t) => {
  const file = writeQuestionFile([...VALID_ENTRIES, ...BAD_ENTRIES]);
  t.after(() => cleanupQuestionFile(file));
  const warned = t.mock.method(console, 'warn', () => undefined);

  const service = new SangoService({ questionFile: file });

  assert.equal(service.questionCount, 2);
  assert.ok(warned.mock.calls.length >= BAD_ENTRIES.length);
  assert.equal(service.candidates('夏侯惇的字是什么？')[0]?.answer, '元让');
});

test('load: 题库文件缺失时为空题库并告警，不抛异常', (t) => {
  const missingFile = join(tmpdir(), `sango-missing-${Date.now()}.json`);
  const warned = t.mock.method(console, 'warn', () => undefined);

  const service = new SangoService({ questionFile: missingFile });

  assert.equal(service.questionCount, 0);
  assert.ok(warned.mock.calls.length > 0);
});

test('load: SANGO_QUESTION_FILE 环境变量生效', (t) => {
  const file = writeQuestionFile(VALID_ENTRIES);
  t.after(() => cleanupQuestionFile(file));
  const previous = process.env.SANGO_QUESTION_FILE;
  process.env.SANGO_QUESTION_FILE = file;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.SANGO_QUESTION_FILE;
    } else {
      process.env.SANGO_QUESTION_FILE = previous;
    }
  });

  const service = new SangoService();
  assert.equal(service.questionCount, 2);
});

test('normalize: 全角→半角、小写、去空白与标点', () => {
  assert.equal(normalize('Ａ．ＢＣ！'), 'abc');
  assert.equal(normalize(' 元让，。！ '), '元让');
  assert.equal(normalize('这题选什么？'), '这题选什么');
  assert.equal(normalize('《孟德新书》'), '孟德新书');
});

test('candidates: 标点/空白不影响，原问法排第一', (t) => {
  const service = makeFixtureService(t);

  assert.equal(service.candidates('夏侯惇的字是什么？')[0]?.answer, '元让');
  assert.equal(service.candidates(' 夏侯惇的字是什么 ')[0]?.answer, '元让');
  assert.equal(service.candidates('夏侯惇的字是什么？！')[0]?.answer, '元让');
});

test('candidates: 换问法可召回目标题，同类干扰题不串位', (t) => {
  const file = writeQuestionFile(CANDIDATE_ENTRIES);
  t.after(() => cleanupQuestionFile(file));
  const service = new SangoService({ questionFile: file });

  assert.equal(service.candidates('乐不思蜀说的是谁')[0]?.answer, '刘禅');
  assert.equal(service.candidates('夏侯渊的字是什么？')[0]?.answer, '妙才');
  assert.equal(service.candidates('夏侯的字是什么？')[0]?.answer, '元让');
});

test('candidates: 无关问法与空输入返回空，limit 生效', (t) => {
  const service = makeFixtureService(t);

  assert.deepEqual(service.candidates('完全不存在的问题'), []);
  assert.deepEqual(service.candidates(''), []);
  assert.equal(service.candidates('的字是什么', 1).length, 1);
});

test('judge: 选项字母（半角/全角/大小写）判题', (t) => {
  const service = makeFixtureService(t);
  const question = XIAHOU_DUN_QUESTION;

  assert.deepEqual(service.judge('A', question), {
    correct: true,
    answer: { key: 'A', text: '元让' },
  });
  assert.deepEqual(service.judge('a', question), {
    correct: true,
    answer: { key: 'A', text: '元让' },
  });
  assert.deepEqual(service.judge('ａ', question), {
    correct: true,
    answer: { key: 'A', text: '元让' },
  });
  const wrong = service.judge('C', question);
  assert.equal(wrong?.correct, false);
  assert.deepEqual(wrong?.answer, { key: 'A', text: '元让' });
});

test('judge: 选项文本（含空白/标点）判题，无法识别返回 null', (t) => {
  const service = makeFixtureService(t);
  const question = XIAHOU_DUN_QUESTION;

  assert.equal(service.judge('元让', question)?.correct, true);
  assert.equal(service.judge(' 元让 ', question)?.correct, true);
  assert.equal(service.judge('元让！', question)?.correct, true);
  assert.equal(service.judge('妙才', question)?.correct, false);
  assert.equal(service.judge('不存在的答案', question), null);
});
test('randomQuestion: 出题只含题干与 A-D 选项，不含答案标注', (t) => {
  const service = makeFixtureService(t);
  for (let i = 0; i < 20; i++) {
    const out = service.handleRandom('随机一题', `sid-${i}`);
    assert.match(out, /^题目：.+\nA\. .+\nB\. .+\nC\. .+\nD\. .+$/);
    assert.ok(!out.includes('正确答案'), '出题不应包含答案标注');
  }
  assert.match(service.handleRandom('来一题', 'sid-alias'), /^题目：/);
});

test('random 指令流：随机一题 → 判对 → 判错附正确答案 → 答案指令', (t) => {
  const service = makeFixtureService(t);
  const out = service.handleRandom('随机一题', 'sid-flow');
  assert.match(out, /^题目：/);

  const current = service.getCurrentQuestion('sid-flow');
  assert.ok(current);
  const answer = service.answerOf(current!);

  assert.equal(
    service.handleRandom(answer.key, 'sid-flow'),
    `答对了！正确答案：${answer.text}（${answer.key}）`
  );

  const wrongKey = (['A', 'B', 'C', 'D'] as SangoOptionKey[]).find(
    (key) => key !== answer.key
  )!;
  assert.equal(
    service.handleRandom(current!.options[wrongKey], 'sid-flow'),
    `答错了，正确答案：${answer.text}（${answer.key}）`
  );

  assert.equal(
    service.handleRandom('答案', 'sid-flow'),
    `正确答案：${answer.text}（${answer.key}）`
  );
  assert.equal(
    service.handleRandom('这题选什么？', 'sid-flow'),
    `正确答案：${answer.text}（${answer.key}）`
  );
});

test('会话: 无有效会话时判题与查答案返回提示', (t) => {
  const service = makeFixtureService(t);

  assert.equal(service.handleRandom('答案'), SANGO_NO_SESSION_PROMPT);
  assert.equal(service.handleRandom('A'), SANGO_NO_SESSION_PROMPT);
  assert.equal(service.handleRandom('这题选什么'), SANGO_NO_SESSION_PROMPT);
});

test('会话 TTL: 过期后会话失效，判题与查答案返回无会话提示', async (t) => {
  const file = writeQuestionFile(VALID_ENTRIES);
  t.after(() => cleanupQuestionFile(file));
  const service = new SangoService({ questionFile: file, ttlMs: 20 });

  const out = service.handleRandom('随机一题', 'sid-ttl');
  assert.match(out, /^题目：/);
  assert.ok(service.getCurrentQuestion('sid-ttl'));

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(service.getCurrentQuestion('sid-ttl'), null);
  assert.equal(service.handleRandom('答案', 'sid-ttl'), SANGO_NO_SESSION_PROMPT);
  assert.equal(service.handleRandom('A', 'sid-ttl'), SANGO_NO_SESSION_PROMPT);
});
