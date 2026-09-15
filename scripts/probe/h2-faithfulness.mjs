#!/usr/bin/env node
/**
 * 探针 A —— H2 忠实度（投毒法，语料 = 第五回）
 *
 * 用法：node scripts/probe/h2-faithfulness.mjs [--cases <file>] [--out <file>] [--limit 5]
 * 前置：npm run build（复用 build/agent.js 的 tool-use 循环与 .env 里的 LLM 通道）
 *
 * 红线：
 *   1. 投毒语料只从 data/sango-novel/probe/ 读，文件名必须含 poison；脚本不扫目录、只读白名单路径。
 *   2. 统计工具调用率（模型可能压根不检索、凭记忆作答，是 H2 的第三种失败形态）。
 *   3. 记录三态判定：跟随语料 / 按记忆作答 / 越界评论（「原文写…但实际是…」）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { Agent } from '../../build/agent.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
process.loadEnvFile(resolve(REPO_ROOT, '.env'));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const CASES_FILE = resolve(REPO_ROOT, argOf('cases', 'data/sango-novel/probe/h2-cases.json'));
const OUT_FILE = resolve(REPO_ROOT, argOf('out', 'data/sango-novel/probe/h2-results.json'));
const TOP_K = Number(argOf('limit', '8'));
const DRY_RUN = args.includes('--dry-run'); // 桩模型：只验证接线（检索 / 工具循环 / 判定），不调 LLM

// 探针专用提示词（第 9 节 L5 约束的草案）：强制先检索、只依据原文、不评论不纠正
const PROBE_SYSTEM_PROMPT = [
  '你是《三国演义》原文解读助手，用简体中文回答用户提问。',
  '规则：',
  '1. 回答前必须先调用 sango_novel_search 工具检索《三国演义》原文。',
  '2. 只依据工具返回的原文作答：人物、情节、数字都必须能在原文里找到。',
  '3. 原文里没有相关内容时，只回复「演义中未涉及」，不得用其他知识补全。',
  '4. 不评论、不纠正、不对比：不得说原文写错，不得提正史 / 影视 / 游戏，不得出现「实际是…」这类转折。',
  '5. 回答简洁，先给结论；需要时可以引述一句原文作为依据。',
].join('\n');

// 工具定义按 MCP 工具形状写（D1 / D4：保留 source 维度，将来挪进 MCP 不返工）
/** dry-run 用桩模型：第一轮先要检索，第二轮回显工具返回内容（不联网、不判定真实性） */
const dryRunCaller = async (messages) => {
  const toolPayload = messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('');
  if (!toolPayload) {
    return {
      content: [
        { type: 'tool_use', id: 'dry-1', name: 'sango_novel_search', input: { query: String(messages[1]?.content ?? '') } },
      ],
    };
  }
  return { content: [{ type: 'text', text: `（dry-run 占位回答）${toolPayload.replace(/\s+/g, ' ').slice(0, 40)}` }] };
};
const SEARCH_TOOL = {
  name: 'sango_novel_search',
  description:
    '《三国演义》原文检索：输入现代白话问句，返回最相关的演义原文段落，含回目与段号出处',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '用户的问题原文' },
      source: {
        type: 'string',
        enum: ['sanguo-yanyi'],
        description: '语料来源，本期只有《三国演义》',
      },
      limit: { type: 'number', description: '返回条数上限，默认 5' },
    },
    required: ['query'],
  },
};

const normalize = (text) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\p{P}/gu, '');

const bigrams = (text) => {
  const grams = new Set();
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
};

/** 段落级召回：字符 bigram + Dice 系数 Top-K（沿用 sango.ts 的思路，探针不引新依赖） */
function retrieve(corpus, query, limit) {
  const q = bigrams(normalize(query));
  if (q.size === 0) return [];
  return corpus.paragraphs
    .map((p) => {
      const g = bigrams(normalize(p.text));
      let overlap = 0;
      for (const gram of q) if (g.has(gram)) overlap++;
      const dice = (2 * overlap) / (q.size + g.size);
      return { seq: p.seq, type: p.type, dice: Number(dice.toFixed(4)), text: p.text };
    })
    .filter((hit) => hit.dice > 0)
    .sort((a, b) => b.dice - a.dice)
    .slice(0, limit);
}

function loadCorpus(name, file) {
  const abs = resolve(REPO_ROOT, file);
  const relativePath = relative(REPO_ROOT, abs).replace(/\\/g, '/');
  if (name === 'poison') {
    if (!relativePath.includes('/probe/') || !basename(abs).includes('poison')) {
      throw new Error(`投毒语料路径不合规（必须在 probe/ 且文件名含 poison）：${relativePath}`);
    }
  } else if (relativePath.includes('/probe/')) {
    throw new Error(`正式语料不得落在 probe/ 目录：${relativePath}`);
  }
  return { ...JSON.parse(readFileSync(abs, 'utf8')), path: relativePath };
}

/** 每个语料一个 agent：投毒与原文严格分开，避免串语料 */
function createAgent(corpus, state) {
  const transport = {
    async listTools() {
      return [];
    },
    async callTool() {
      throw new Error('探针不使用 MCP 工具');
    },
    async close() {},
  };
  return new Agent(
    transport,
    {
      provider: (process.env.LLM_PROVIDER || 'deepseek').toLowerCase(),
      model: process.env.LLM_MODEL,
      apiKey: process.env.API_KEY,
      apiBaseUrl: process.env.API_BASE_URL,
    },
    {
      systemPrompt: PROBE_SYSTEM_PROMPT,
      tools: [SEARCH_TOOL],
      ...(DRY_RUN ? { modelCaller: dryRunCaller } : {}),
      localTools: {
        sango_novel_search: (toolArgs) => {
          state.toolCalls += 1;
          const query = typeof toolArgs.query === 'string' ? toolArgs.query : '';
          const limit = Number(toolArgs.limit) || TOP_K;
          const hits = retrieve(corpus, query, limit);
          state.retrieved = hits.map((hit) => ({
            ref: `第${corpus.chapter}回 · 段${hit.seq} · ${hit.type}`,
            dice: hit.dice,
            text: hit.text,
          }));
          return {
            content: [
              {
                type: 'text',
                text: hits.length
                  ? hits
                      .map(
                        (hit) =>
                          `【出处】第${corpus.chapter}回 ${corpus.title} · 段${hit.seq}（${hit.type}）\n${hit.text}`
                      )
                      .join('\n\n')
                  : '未召回到任何原文段落',
              },
            ],
          };
        },
      },
    }
  );
}

/** 三态判定（探针 A 的读数定义，见任务书 5.1） */
function judge(testCase, answer, toolCalled) {
  const found = (names) => names.find((name) => answer.includes(name));
  let verdict;
  let reason;

  if (testCase.verdictKind === 'answer') {
    const hit = found(testCase.expect);
    verdict = hit ? '✅' : '❌';
    reason = hit ? `命中期望答案「${hit}」` : `未出现期望答案「${testCase.expect.join(' / ')}」`;
  } else if (testCase.verdictKind === 'follow-or-memory') {
    // 判定优先级：记忆与语料同现 → 记忆优先（合理化）；只出现记忆 → 纯记忆；只出现语料 → 跟随
    const follow = found(testCase.followNames);
    const memory = found(testCase.memoryNames);
    const comment = found(testCase.commentaryMarkers);
    if (memory && follow) {
      verdict = '⚠️';
      reason = `记忆优先：答案先给「${memory}」、再承认语料写「${follow}」（合理化，需人工复核）`;
    } else if (memory) {
      verdict = '❌';
      reason = `无视语料、按记忆答「${memory}」`;
    } else if (follow && comment) {
      verdict = '⚠️';
      reason = `跟随语料（${follow}）但同时出现越界评论标记「${comment}」`;
    } else if (follow) {
      verdict = '✅';
      reason = `跟随语料答「${follow}」`;
    } else {
      verdict = '⚠️';
      reason = '既未跟随语料也未命中记忆答案，需人工判读';
    }
  } else if (testCase.verdictKind === 'refusal') {
    const hit = found(testCase.refusalMarkers);
    verdict = hit ? '✅' : '❌';
    reason = hit ? `按预期拒答「${hit}」` : '未拒答（可能按记忆补全）';
  } else {
    throw new Error(`未知 verdictKind：${testCase.verdictKind}`);
  }

  if (!toolCalled) {
    reason = `未调用检索工具；${reason}`;
  }
  return { verdict, reason };
}

const cases = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
const corpora = {
  baseline: loadCorpus('baseline', cases.corpus.baseline),
  poison: loadCorpus('poison', cases.corpus.poison),
};
corpora.baseline.agent = createAgent(corpora.baseline, corpora.baseline);
corpora.poison.agent = createAgent(corpora.poison, corpora.poison);

const ONLY = String(argOf('only', '')).split(',').filter(Boolean);
const REPEAT = Number(argOf('repeat', '1'));
const selected = cases.cases.filter((c) => (ONLY.length ? ONLY.includes(c.id) : true));

const results = [];
for (const testCase of selected) {
 for (let run = 1; run <= REPEAT; run++) {
  const corpus = corpora[testCase.corpus];
  corpus.toolCalls = 0;
  corpus.retrieved = [];
  const answer = await corpus.agent.processQuery(testCase.question);
  const judgment = judge(testCase, answer, corpus.toolCalls > 0);
  results.push({
    id: testCase.id,
    run,
    group: testCase.group,
    corpus: testCase.corpus,
    question: testCase.question,
    toolCalled: corpus.toolCalls > 0,
    toolCalls: corpus.toolCalls,
    retrieved: corpus.retrieved,
    answer,
    verdict: judgment.verdict,
    reason: judgment.reason,
  });
  console.log(
    `${judgment.verdict} ${testCase.id}#${run}｜工具${corpus.toolCalls > 0 ? '✔' : '✘'}｜${answer.replace(/\n/g, ' ').slice(0, 80)}`
  );
 }
}

const summary = {
  total: results.length,
  pass: results.filter((r) => r.verdict === '✅').length,
  fail: results.filter((r) => r.verdict === '❌').length,
  warn: results.filter((r) => r.verdict === '⚠️').length,
  toolCallRate: `${results.filter((r) => r.toolCalled).length}/${results.length}`,
};
const stopCase = cases.cases.find((c) => c.stopOnFail);
// 生死线：A2 只要不是「跟随语料」（含记忆优先的 ⚠️）就停下，不做调参硬救
const stopRuns = results.filter((r) => stopCase && r.id === stopCase.id);
summary.stopCaseVerdicts = stopRuns.map((r) => r.verdict);
summary.haltRecommended = stopRuns.some((r) => r.verdict !== '✅');

const payload = {
  probe: cases.id,
  title: cases.title,
  runAt: new Date().toISOString(),
  provider: (process.env.LLM_PROVIDER || '').toLowerCase(),
  model: process.env.LLM_MODEL,
  temperature: 0.7,
  topK: TOP_K,
  systemPrompt: PROBE_SYSTEM_PROMPT,
  cases: results,
  summary,
};
if (!DRY_RUN) { writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }

console.log(
  `\n汇总：✅${summary.pass} ❌${summary.fail} ⚠️${summary.warn}｜工具调用率 ${summary.toolCallRate}｜结果 → ${relative(REPO_ROOT, OUT_FILE).replace(/\\/g, '/')}`
);
if (summary.haltRecommended) {
  console.log('生死线告警：A2 未跟随语料 → H2 不成立，停止 T3（探针 B），回报负责人。');
}