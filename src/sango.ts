import { readFileSync } from 'node:fs';

export type SangoOptionKey = 'A' | 'B' | 'C' | 'D';

export interface SangoQuestion {
  question: string;
  options: Record<SangoOptionKey, string>;
  answer: string;
}

/** 知识问答命中结果：题目 + 正确选项文本 */
export interface SangoSearchHit {
  question: SangoQuestion;
  answer: string;
}

/** 正确选项：字母键 + 选项文本 */
export interface SangoAnswer {
  key: SangoOptionKey;
  text: string;
}

export interface SangoJudgeResult {
  correct: boolean;
  answer: SangoAnswer;
}

export interface SangoServiceOptions {
  /** 题库文件路径；缺省读环境变量 SANGO_QUESTION_FILE，再缺省 data/sango-questions.json */
  questionFile?: string;
  /** 随机一题会话 TTL（毫秒），默认 30 分钟 */
  ttlMs?: number;
}

interface SangoSession {
  question: SangoQuestion;
  createdAt: number;
}

const DEFAULT_QUESTION_FILE = 'data/sango-questions.json';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const OPTION_KEYS: SangoOptionKey[] = ['A', 'B', 'C', 'D'];
const RANDOM_COMMANDS = new Set(['随机一题', '来一题']);
const ANSWER_COMMANDS = new Set(['答案', '这题选什么']);
const VECTOR_DIM = 256;
const SANGO_VECTOR_THRESHOLD = 0.9;

export const SANGO_NO_SESSION_PROMPT = '请先发送“随机一题”开始';
export const SANGO_EMPTY_BANK_PROMPT = '题库为空，暂时无法出题';

/** 归一化：全角→半角、小写、去空白与标点 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\p{P}/gu, '');
}

/** FNV-1a 32-bit：与 mcp-server 侧确定性哈希向量编码保持一致 */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(text, 'utf8');
  for (let index = 0; index < bytes.length; index++) {
    hash = Math.imul(hash ^ bytes[index]!, 0x01000193) >>> 0;
  }
  return hash;
}

/** 字符级分词：与 mcp-server 的 tokenize 保持一致，产出单字 + 相邻双字 */
function tokenize(text: string): string[] {
  const chars = Array.from(text).filter((char) => !/\s/.test(char));
  const tokens: string[] = [];
  for (let index = 0; index < chars.length; index++) {
    tokens.push(chars[index]!);
  }
  for (let index = 0; index + 1 < chars.length; index++) {
    tokens.push(chars[index]! + chars[index + 1]!);
  }
  return tokens;
}

/** 确定性哈希向量：token 集合投影到 dim 维 L2 归一化符号向量 */
function embedTokensByHash(tokens: string[], dim: number): Float32Array {
  const vector = new Float32Array(dim);
  for (const token of tokens) {
    const hash = fnv1a32(token);
    const index = (hash & 0x7fffffff) % dim;
    const sign = (hash & 0x80000000) === 0 ? 1 : -1;
    vector[index] += sign;
  }
  let norm = 0;
  for (let index = 0; index < vector.length; index++) {
    norm += vector[index]! * vector[index]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < vector.length; index++) {
      vector[index] = vector[index]! / norm;
    }
  }
  return vector;
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
  }
  return dot;
}

/** L3 路由问句签名：去停用字与标点后比较，吸收「XXX的字是什么 → XXX字什么」这类固定换问法 */
const ROUTE_STOP_CHARS = new Set(['的', '是', '了', '吗', '呢', '啊', '呀', '吧']);

function routeSignature(text: string): string {
  return Array.from(normalize(text))
    .filter((char) => !ROUTE_STOP_CHARS.has(char))
    .join('');
}

function levenshteinDistance(left: string, right: string): number {
  const previous = new Array<number>(right.length + 1);
  const current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j++) previous[j] = j;
  for (let i = 1; i <= left.length; i++) {
    current[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    for (let j = 0; j <= right.length; j++) previous[j] = current[j]!;
  }
  return previous[right.length]!;
}

function lexicalSimilarity(left: string, right: string): number {
  const leftSignature = routeSignature(left);
  const rightSignature = routeSignature(right);
  if (!leftSignature || !rightSignature) {
    return 0;
  }
  if (leftSignature === rightSignature) {
    return 1;
  }
  const distance = levenshteinDistance(leftSignature, rightSignature);
  return 1 - distance / Math.max(leftSignature.length, rightSignature.length);
}

/** 知识问答召回条数上限：候选越多 token 越贵，8 条足够覆盖问法差异 */
const DEFAULT_CANDIDATE_LIMIT = 8;

/** 字符 bigram 集合（相邻二字组，无需分词依赖） */
function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  if (text.length === 1) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i++) {
    grams.add(text.slice(i, i + 2));
  }
  return grams;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidQuestion(value: unknown): value is SangoQuestion {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.question !== 'string' || !value.question.trim()) {
    return false;
  }
  if (!isRecord(value.options)) {
    return false;
  }
  for (const key of OPTION_KEYS) {
    const option = value.options[key];
    if (typeof option !== 'string' || !option.trim()) {
      return false;
    }
  }
  if (typeof value.answer !== 'string' || !value.answer.trim()) {
    return false;
  }
  const options = value.options;
  const answerText = value.answer.trim();
  return OPTION_KEYS.some((key) => options[key] === answerText);
}
/**
 * 风云三国知识问答题库服务：启动加载校验、知识问答检索、
 * 随机一题会话（Map + TTL 30 分钟，仅随机一题使用，单实例）。
 */
export class SangoService {
  private readonly questions: SangoQuestion[];
  private readonly questionVectors: Float32Array[];
  private readonly sessions = new Map<string, SangoSession>();
  private readonly ttlMs: number;

  constructor(options?: SangoServiceOptions) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    const file =
      options?.questionFile ??
      process.env.SANGO_QUESTION_FILE ??
      DEFAULT_QUESTION_FILE;
    this.questions = this.load(file);
    this.questionVectors = this.questions.map((question) =>
      embedTokensByHash(tokenize(normalize(question.question)), VECTOR_DIM)
    );
  }

  /** 启动加载：坏行跳过并告警；文件缺失/解析失败也告警并给空题库，不挂服务 */
  private load(file: string): SangoQuestion[] {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      console.warn(`[sango] 题库文件读取失败，题库为空：${file}`, error);
      return [];
    }
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch (error) {
      console.warn(`[sango] 题库 JSON 解析失败，题库为空：${file}`, error);
      return [];
    }
    if (!Array.isArray(entries)) {
      console.warn(`[sango] 题库顶层不是数组，题库为空：${file}`);
      return [];
    }
    const questions: SangoQuestion[] = [];
    for (const entry of entries) {
      if (isValidQuestion(entry)) {
        questions.push(entry);
      } else {
        console.warn(`[sango] 跳过非法题目：${JSON.stringify(entry)}`);
      }
    }
    return questions;
  }

  get questionCount(): number {
    return this.questions.length;
  }

  /** 用户问句与全量题库的最大余弦相似度（L3 高置信识别） */
  maxSangoVectorSimilarity(text: string): number {
    const normalized = normalize(text);
    if (!normalized || this.questionVectors.length === 0) {
      return 0;
    }
    const queryVector = embedTokensByHash(tokenize(normalized), VECTOR_DIM);
    let best = 0;
    for (const questionVector of this.questionVectors) {
      const similarity = cosineSimilarity(queryVector, questionVector);
      if (similarity > best) {
        best = similarity;
      }
    }
    return best;
  }

  /** L3 高置信命中：余弦相似度 >= 0.9 */
  isHighConfidenceSangoQuery(text: string): boolean {
    const normalized = normalize(text);
    if (!normalized || this.questions.length === 0) {
      return false;
    }
    const vectorSimilarity = this.maxSangoVectorSimilarity(text);
    if (vectorSimilarity >= SANGO_VECTOR_THRESHOLD) {
      return true;
    }
    return this.questions.some(
      (question) =>
        lexicalSimilarity(normalized, question.question) >= SANGO_VECTOR_THRESHOLD
    );
  }

  /**
   * 知识问答召回：按字符 bigram 重合度（Dice 系数）取 Top-K 候选。
   * 只负责把候选捞出来，是否含义对应由 LLM 判定；无候选即未收录。
   */
  candidates(text: string, limit = DEFAULT_CANDIDATE_LIMIT): SangoSearchHit[] {
    const normalized = normalize(text);
    if (!normalized) {
      return [];
    }

    const inputGrams = bigrams(normalized);

    return this.questions
      .map((question) => {
        const questionGrams = bigrams(normalize(question.question));
        let shared = 0;
        for (const gram of inputGrams) {
          if (questionGrams.has(gram)) {
            shared += 1;
          }
        }
        return {
          question,
          score: (2 * shared) / (inputGrams.size + questionGrams.size),
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map((entry) => ({
        question: entry.question,
        answer: entry.question.answer,
      }));
  }

  /** 随机一题（不标注答案） */
  randomQuestion(): SangoQuestion | null {
    if (this.questions.length === 0) {
      return null;
    }
    const index = Math.floor(Math.random() * this.questions.length);
    return this.questions[index]!;
  }

  /** 当前题的正确答案（字母键 + 选项文本） */
  answerOf(question: SangoQuestion): SangoAnswer {
    const answerText = question.answer.trim();
    const key = OPTION_KEYS.find(
      (optionKey) =>
        normalize(question.options[optionKey]) === normalize(answerText)
    );
    if (!key) {
      throw new Error('SangoService: question answer not found in options');
    }
    return { key, text: answerText };
  }

  /** 判题：先按选项字母（A-D，忽略全角/大小写），再按选项文本归一化匹配 */
  judge(text: string, question: SangoQuestion): SangoJudgeResult | null {
    const normalized = normalize(text);
    const key = this.matchOptionKey(normalized, question);
    if (!key) {
      return null;
    }
    const answer = this.answerOf(question);
    return { correct: key === answer.key, answer };
  }

  private matchOptionKey(
    normalized: string,
    question: SangoQuestion
  ): SangoOptionKey | null {
    if (normalized.length === 1) {
      const letterIndex = 'abcd'.indexOf(normalized);
      if (letterIndex >= 0) {
        return OPTION_KEYS[letterIndex]!;
      }
    }
    for (const key of OPTION_KEYS) {
      if (normalize(question.options[key]) === normalized) {
        return key;
      }
    }
    return null;
  }
  /** 当前会话题目（过期即清除），用于外部查证会话是否有效 */
  getCurrentQuestion(sessionId: string): SangoQuestion | null {
    return this.getSession(sessionId)?.question ?? null;
  }

  /** 随机一题本地规则指令流：随机一题 → 查答案 → 判题 → 无会话提示 */
  handleRandom(message: string, sessionId?: string): string {
    const normalized = normalize(message);

    if (RANDOM_COMMANDS.has(normalized)) {
      const question = this.randomQuestion();
      if (!question) {
        return SANGO_EMPTY_BANK_PROMPT;
      }
      if (sessionId) {
        this.sessions.set(sessionId, { question, createdAt: Date.now() });
      }
      return this.formatQuestion(question);
    }

    const session = sessionId ? this.getSession(sessionId) : null;
    if (!session) {
      return SANGO_NO_SESSION_PROMPT;
    }

    if (ANSWER_COMMANDS.has(normalized)) {
      return this.formatAnswer(this.answerOf(session.question));
    }

    const result = this.judge(message, session.question);
    if (!result) {
      return `答错了，${this.formatAnswer(this.answerOf(session.question))}`;
    }
    return result.correct
      ? `答对了！${this.formatAnswer(result.answer)}`
      : `答错了，${this.formatAnswer(result.answer)}`;
  }

  private getSession(sessionId: string): SangoSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    if (Date.now() - session.createdAt > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  private formatQuestion(question: SangoQuestion): string {
    return (
      `题目：${question.question}\n` +
      `A. ${question.options.A}\n` +
      `B. ${question.options.B}\n` +
      `C. ${question.options.C}\n` +
      `D. ${question.options.D}`
    );
  }

  private formatAnswer(answer: SangoAnswer): string {
    return `正确答案：${answer.text}（${answer.key}）`;
  }
}
