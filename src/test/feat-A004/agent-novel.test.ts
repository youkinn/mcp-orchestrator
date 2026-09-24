import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import { loadAliasTable } from "../../citation.js";
import { SUPPORT_CHECK_SYSTEM_PROMPT } from "../../supportCheck.js";
import { runWithTraceId } from "../../trace.js";
import { getLogStore, type LogStore } from "../../storage/logs.js";
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "../../types.js";

/** Mock Transport：只记录调用，不发真实 MCP 连接 */
class MockTransport extends MCPTransport {
  callToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(private tools: MCPToolDefinition[] = []) {
    super("mock-server");
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.callToolCalls.push({ name, args });
    return { content: [{ type: "text", text: "transport-result" }] };
  }
}

const NOVEL_TOOL: MCPToolDefinition = {
  name: "sango_novel_search",
  description: "《三国演义》原著检索：参数 source=sanguo-yanyi、query=用户白话问句、limit 默认 5",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
    },
  },
};

function makeConfig(provider: LLMProvider = "deepseek"): LLMConfig {
  return {
    provider,
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }] };
}

const ALIAS_TABLE = loadAliasTable("a004-not-exist"); // stub 别名表（关羽=P002）

/** bug-00028 复核轮日志用例：文件级把共享日志库重定向到临时目录，不污染工作树 data/logs.db */
const cwd = process.cwd();
let store: LogStore;
let logDir: string;

before(() => {
  logDir = mkdtempSync(join(tmpdir(), "a004-bug28-novel-"));
  process.chdir(logDir);
  store = getLogStore();
});

after(() => {
  store.close();
  process.chdir(cwd);
  rmSync(logDir, { recursive: true, force: true });
});

/** 复核轮（novel_support_check）假 LLM 返回：契约 JSON 文本 */
function supportCheckResponse(
  overall: string,
  citations: Array<[string, string]>
): ModelResponse {
  return textResponse(
    JSON.stringify({
      overall,
      citations: citations.map(([pointer, support]) => ({ pointer, support })),
    })
  );
}

/** 脚本化 fake OpenAI（走真实 callModel 落库路径，agent-novel 其余用例的 modelCaller 注入旁路日志）：
 * 按调用顺序返回预设响应；超出脚本长度时重复最后一条。 */
function scriptedOpenAI(
  script: Array<{ content: string; finishReason: string }>
): { openai: unknown; requests: any[] } {
  const requests: any[] = [];
  const openai = {
    chat: {
      completions: {
        create: async (request: any) => {
          requests.push(request);
          const step = script[requests.length - 1] ?? script[script.length - 1];
          return {
            choices: [
              {
                message: { role: "assistant", content: step.content },
                finish_reason: step.finishReason,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  };
  return { openai, requests };
}

function injectOpenAI(agent: Agent, openai: unknown): void {
  (agent as unknown as { openai: unknown }).openai = openai;
}

/** 召回出参（C4 定稿：裸 JSON 数组）：正文纯原文，出处逐条走 chapter / title，引语走 quotes[] */
const RECALL_CHAPTER = 5;
const RECALL_TITLE = "发矫诏诸镇应曹公　破关兵三英战吕布";
const RECALL_QUOTE = "云长提刀出阵，斩华雄于帐前！";
const RECALL_BODY = `众皆大惊曰：“${RECALL_QUOTE}”`;
const RECALL_TEXT = JSON.stringify([
  {
    id: "sanguo-yanyi:0005:c0001",
    text: RECALL_BODY,
    chapter: RECALL_CHAPTER,
    title: RECALL_TITLE,
    type: "narration",
    segFrom: 4,
    segTo: 4,
    quoteBalanced: true,
    quotes: [{ offset: 7, len: RECALL_QUOTE.length }],
  },
]);

test("domain=sango-novel 时 system 使用三国演义域提示（不再指示调用检索工具）", async () => {
  let capturedSystem = "";
  let callCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    callCount += 1;
    if (callCount === 1) {
      capturedSystem = messages.find((m) => m.role === "system")?.content ?? "";
    }
    return textResponse("按原文，斩华雄者系关羽。");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    modelCaller,
  });
  await agent.processQuery("谁斩了华雄？", "sango-novel");
  assert.ok(capturedSystem.includes("三国演义原著解读"), "应追加三国演义域提示");
  assert.ok(capturedSystem.includes("不要再调用检索工具"), "域提示明确不再调用检索工具");
  assert.ok(!capturedSystem.includes("sango_novel_search"), "域提示不命名检索工具（feat-A011 不携带工具定义）");
});

test("① 指针合法：模型只给结论 + 指针，服务端渲染引文 + 角标，citations 下沉片段（无额外模型调用）", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : modelCallCount === 2
        ? textResponse("斩华雄者系关羽，原文见[Q1]。")
        : supportCheckResponse("supported", [["Q1", "supported"]]);
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const data = await agent.processQueryData("谁斩了华雄？");
  assert.equal(data.answer, `斩华雄者系关羽，原文见「${RECALL_QUOTE}」¹。`);
  assert.deepEqual(data.citations, [
    { text: RECALL_BODY, chapter: RECALL_CHAPTER, title: RECALL_TITLE },
  ]);
  assert.doesNotMatch(data.answer, /\[Q1\]/, "指针应已被服务端渲染替换");
  assert.doesNotMatch(data.answer, /段\d|（出处/, "不再内联出处，任何展示位无段号");
  assert.equal(modelCallCount, 3, "生成轮 + 复核轮各一次：复核判 supported 后无兜底模型调用");
});

test("② 断言人物不在召回原文（曹操）：丢弃模型输出，输出兜底结论句 + 恰一条兜底片段", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : textResponse("曹操斩了华雄。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const data = await agent.processQueryData("谁斩了华雄？");
  assert.equal(data.answer, "按原文，斩华雄者系关羽¹");
  assert.deepEqual(data.citations, [
    { text: RECALL_BODY, chapter: RECALL_CHAPTER, title: RECALL_TITLE },
  ]);
  assert.doesNotMatch(data.answer, /曹操斩了华雄/);
  assert.doesNotMatch(data.answer, /（出处|【原文片段】/, "兜底不再内联原文与出处");
  assert.equal(modelCallCount, 2, "注入提取/结论后不增加模型调用");
});

test("②.1 指针非法（不在本次注入集合内）：丢弃模型输出，走兜底", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : textResponse("斩华雄者系关羽，原文见[Q9]。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const data = await agent.processQueryData("谁斩了华雄？");
  assert.equal(data.answer, "按原文，斩华雄者系关羽¹", "越界指针即走兜底");
  assert.doesNotMatch(data.answer, /\[Q9\]/, "非法指针不得进入最终答案");
  assert.equal(data.citations.length, 1, "兜底恰一条");
  assert.deepEqual(data.citations[0], {
    text: RECALL_BODY,
    chapter: RECALL_CHAPTER,
    title: RECALL_TITLE,
  });
  assert.equal(modelCallCount, 2, "兜底走注入的结论归纳，不额外调模型");
});

test("②.2 缺指针（结论无引用）：丢弃模型输出，走兜底", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : textResponse("斩华雄者系关羽。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const data = await agent.processQueryData("谁斩了华雄？");
  assert.equal(data.answer, "按原文，斩华雄者系关羽¹", "无指针即无出处，走兜底补出处");
  assert.equal(data.citations.length, 1, "兜底恰一条");
  assert.deepEqual(data.citations[0], {
    text: RECALL_BODY,
    chapter: RECALL_CHAPTER,
    title: RECALL_TITLE,
  });
  assert.equal(modelCallCount, 2);
});

test("②.3 长引语安全网：模型违规抄写超 30 字引语被丢弃，原文改由指针渲染", async () => {
  const longQuote = "云长提刀出阵，斩华雄于帐前，众皆大惊失色，尽皆低头不语，莫敢仰视其面。";
  assert.ok(longQuote.length > 30);
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : modelCallCount === 2
        ? textResponse(`斩华雄者系关羽，曰「${longQuote}」[Q1]。`)
        : supportCheckResponse("supported", [["Q1", "supported"]]);
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const data = await agent.processQueryData("谁斩了华雄？");
  assert.doesNotMatch(data.answer, new RegExp(longQuote), "违规抄写应被丢弃");
  assert.equal(
    data.answer,
    `斩华雄者系关羽，曰「${RECALL_QUOTE}」¹。`,
    "原文改由指针 + 字段渲染，逐字可信"
  );
  assert.deepEqual(data.citations, [
    { text: RECALL_BODY, chapter: RECALL_CHAPTER, title: RECALL_TITLE },
  ]);
  assert.equal(modelCallCount, 3, "长引语安全网 + 复核轮均为确定性动作，无兜底模型调用");
});

test("②.4 注入编号连续（bug-00009）：窗口裁掉证据段引语时并入保底，模型 [Q2] 指针合法，答案不被 Guard 改坏", async () => {
  const filler = "先叙无关内容。".repeat(30);
  const recallEntries = [
    {
      id: "sanguo-yanyi:0005:c0011",
      text: "祖茂曰：“主公头上赤帻射目，可脱帻与某戴之。”是夜孙坚正遇华雄，两马相交。",
      chapter: 5,
      title: RECALL_TITLE,
      type: "narration",
      quotes: [{ offset: 5, len: 17 }],
    },
    {
      id: "sanguo-yanyi:0005:c0015",
      text: `关公曰：“酒且斟下，某去便来。”出帐提刀，飞身上马。${filler}马到中军，云长提华雄之头，掷于地上。其酒尚温。`,
      chapter: 5,
      title: RECALL_TITLE,
      type: "narration",
      quotes: [{ offset: 5, len: 10 }],
    },
    {
      id: "sanguo-yanyi:0005:c0014",
      text: "太守韩馥曰：“吾有上将潘凤，可斩华雄。”绍急令出战。",
      chapter: 5,
      title: RECALL_TITLE,
      type: "narration",
      quotes: [{ offset: 7, len: 12 }],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : modelCallCount === 2
        ? textResponse("关羽（云长）温酒斩华雄。[Q2]")
        : supportCheckResponse("supported", [["Q2", "supported"]]);
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(recallEntries) }],
      }),
    },
    fallbackConcluder: async () => "斩华雄者系关羽",
    modelCaller,
  });

  const data = await agent.processQueryData("华雄是怎么死的");
  assert.ok(
    data.answer.includes(`「酒且斟下，某去便来。」¹`),
    "Q2 应指向被并回窗口的证据段引语，答案原样保留"
  );
  assert.equal(data.citations.length, 1, "只收被引用片段：仅 Q2 所在片段");
  assert.equal(data.citations[0].chapter, 5);
  assert.equal(data.citations[0].title, RECALL_TITLE);
  assert.ok(
    data.citations[0].text.includes("关公曰：“酒且斟下，某去便来。”"),
    "citation text 为片段整段原文（工具出参 text）"
  );
  assert.doesNotMatch(data.answer, /【原文片段】/, "指针合法不应走兜底");
  assert.equal(modelCallCount, 3, "生成轮 + 复核轮各一次，复核判 supported 不触发兜底结论归纳");
});

test("③ 检索无命中：回答「演义中未涉及」，不做归纳生成", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : textResponse("借东风后诸葛亮回了夏口。");
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: "" }],
      }),
    },
    modelCaller,
  });

  const data = await agent.processQueryData("诸葛亮借东风后去了哪？");
  assert.equal(data.answer, "演义中未涉及");
  assert.deepEqual(data.citations, [], "无引用恒空数组，不省略不缺失");
  assert.equal(modelCallCount, 2, "无命中不应触发提取/NER/结论模型调用");
});

test("④ 自由对话兜底：分类 99 无预调不触发引用校验，citations 恒 []", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("99")
      : textResponse("纽约今日适合出行。");
  };

  const agent = new Agent(new MockTransport(), makeConfig(), { modelCaller });

  const data = await agent.processQueryData("纽约天气怎么样？");
  assert.equal(data.answer, "纽约今日适合出行。");
  assert.deepEqual(data.citations, [], "未调原著工具的其他域 citations 恒 []");
  assert.equal(modelCallCount, 2, "自由对话域不应触发引用校验的额外模型调用");
});

test("⑤ 默认链路（本地别名表扫描 + 兜底结论）：校验不过走兜底", async () => {
  const responses = [
    textResponse("1"),
    textResponse("许褚斩华雄。"), // 主问答答案（格式不符 + 许褚不在召回 → 触发兜底）
    textResponse("按原文，斩华雄者系关羽"), // 兜底结论（本地扫描，无提取/NER 模型调用）
  ];
  let callIndex = 0;
  const modelCaller = async (
    _messages: any[],
    _tools: MCPToolDefinition[]
  ): Promise<ModelResponse> => {
    const next = responses[callIndex];
    callIndex += 1;
    if (!next) {
      throw new Error(`模型脚本已耗尽：${callIndex}`);
    }
    return next;
  };

  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: RECALL_TEXT }],
      }),
    },
    modelCaller,
  });

  const data = await agent.processQueryData("谁斩了华雄？");
  assert.equal(data.answer, "按原文，斩华雄者系关羽¹");
  assert.deepEqual(data.citations, [
    { text: RECALL_BODY, chapter: RECALL_CHAPTER, title: RECALL_TITLE },
  ]);
  assert.doesNotMatch(data.answer, /（出处|【原文片段】/, "兜底不再内联原文与出处");
  assert.equal(callIndex, 3, "主问答 + 兜底结论共 3 次模型调用（无提取/NER）");
});
test("⑥ 快路径注入策略：前 5 段整段保底注入（不裁剪），且注入不含回目 / 段号 / 分数", async () => {
  let capturedUser = "";
  const filler = "先叙无关内容。".repeat(40);
  const key = "孙权遣人向关羽求亲，关羽怒曰“吾虎女安肯嫁犬子乎！”";
  const tailText = "后叙无关内容。".repeat(40);
  // 4 条召回（按相关度降序、跨回）：第一条命中关键词、其余为无关长段
  const multiText = JSON.stringify([
    {
      id: "sanguo-yanyi:0073:c0007",
      text: filler + key + tailText,
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
      type: "narration",
      segFrom: 5,
      segTo: 5,
      quoteBalanced: true,
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0001:c0001",
      text: "桃园结义无关内容。".repeat(40),
      chapter: 1,
      title: "宴桃园豪杰三结义　斩黄巾英雄首立功",
      type: "narration",
      segFrom: 1,
      segTo: 1,
      quoteBalanced: true,
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0005:c0004",
      text: "三英战吕布无关内容。".repeat(40),
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      segFrom: 4,
      segTo: 4,
      quoteBalanced: true,
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0082:c0001",
      text: "章武元年无关内容。".repeat(40),
      chapter: 82,
      title: "孙权降魏受九锡　先主征吴赏六军",
      type: "narration",
      segFrom: 1,
      segTo: 1,
      quoteBalanced: true,
      quotes: [],
    },
  ]);
  let callCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    callCount += 1;
    // 只取第一次（主问答）调用：注入的片段走 system 消息，user 消息只有原问题
    if (callCount === 1) {
      capturedUser = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content ?? "")
        .join("\n");
    }
    return textResponse("斩华雄者系关羽。");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: multiText }],
      }),
    },
    modelCaller,
  });
  await agent.processQuery("孙权遣人向关羽求亲，关羽是怎么回复使者的", "sango-novel");
  assert.ok(capturedUser.includes("求亲"), "注入应含最符合段的关键句");
  assert.ok(capturedUser.includes(key), "关键段整段注入（不再窗口截断）");
  assert.ok(
    capturedUser.includes("章武元年无关内容。".repeat(40)),
    "前 5 段整段保底：无关长段也完整注入"
  );
  assert.ok(capturedUser.includes("桃园结义无关内容。".repeat(40)), "前 5 段整段注入，不做窗口裁剪");
  assert.ok(!capturedUser.includes("第73回"), "注入不带回目：模型无从抄写出处");
  assert.ok(!capturedUser.includes("· 段"), "注入不带段号");
  assert.match(capturedUser, /\[片段1\]/, "片段带服务端编号，模型据此定位");
});

test("⑦ 注入上限放宽到 10 + 叙述段指针（bug-00009 张飞题）：证据段排 #5 也进注入，模型 [片段5] 指针对应叙述答案句", async () => {
  const filler = "无关内容。".repeat(30);
  const entries = [
    { id: "sanguo-yanyi:0016:c0014", text: `宋宪告布曰：“买马被张飞劫走。”${filler}`, chapter: 16, title: "吕奉先射戟辕门　曹孟德败师淯水", type: "narration", quotes: [] },
    { id: "sanguo-yanyi:0065:c0008", text: `张飞与马超斗百余合。${filler}`, chapter: 65, title: "马超大战葭萌关　刘备自领益州牧", type: "narration", quotes: [] },
    { id: "sanguo-yanyi:0065:c0007", text: `玄德望见马超阵上人马皆倦。${filler}`, chapter: 65, title: "马超大战葭萌关　刘备自领益州牧", type: "narration", quotes: [] },
    { id: "sanguo-yanyi:0042:c0005", text: `曹操回顾左右曰：“翼德于百万军中”。${filler}`, chapter: 42, title: "张翼德大闹长坂桥　刘豫州败走汉津口", type: "narration", quotes: [] },
    {
      id: "sanguo-yanyi:0081:c0007",
      text: "范、张二贼，探知消息，初更时分，各藏短刀，密入帐中，直至床前。原来张飞每睡不合眼；当夜寝于帐中，二贼以短刀刺入飞腹。飞大叫一声而亡。时年五十五。",
      chapter: 81,
      title: "急兄仇张飞遇害　雪弟恨先主兴兵",
      type: "narration",
      quotes: [],
    },
    { id: "sanguo-yanyi:0002:c0010", text: `张飞怒鞭督邮。${filler}`, chapter: 2, title: "张翼德怒鞭督邮　何国舅谋诛宦竖", type: "narration", quotes: [] },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("1")
      : modelCallCount === 2
        ? textResponse("张飞被范疆、张达刺死。[片段5]")
        : supportCheckResponse("supported", [["片段5", "supported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "张飞被范疆、张达所杀",
    modelCaller,
  });
  const data = await agent.processQueryData("张飞怎么死的");
  assert.ok(data.answer.startsWith("张飞被范疆、张达刺死。"), "叙述句指针渲染后保留结论");
  assert.ok(data.answer.endsWith("¹"), "叙述段指针只渲染角标 ¹，不内联原文");
  assert.doesNotMatch(data.answer, /密入帐中/, "answer 不内联片段原文（原文进 citations 卡片）");
  assert.equal(data.citations.length, 1, "只收被引用片段：仅 [片段5] 所在片段");
  assert.equal(data.citations[0].chapter, 81);
  assert.equal(data.citations[0].title, "急兄仇张飞遇害　雪弟恨先主兴兵");
  assert.ok(
    data.citations[0].text.includes("飞大叫一声而亡。时年五十五。"),
    "citation text 为片段整段原文"
  );
  assert.doesNotMatch(data.answer, /\[片段5\]/, "指针已被服务端渲染替换");
  assert.doesNotMatch(data.answer, /【原文片段】/, "指针合法不走兜底");
  assert.equal(modelCallCount, 3, "生成轮 + 复核轮各一次，复核判 supported 不触发兜底结论归纳");
});


// ===== bug-00028：复核轮（novel_support_check）——三例回归 + 问法变体 + 正例控制组 + 熔断 =====
// 语义裁决移交 LLM 复核轮（定稿设计 novel-answer-support-check.md）：两条结构门（指针合法 / 人物⊆召回）
// 之外不再有词表规则。全部走 domain=sango-novel 标签锁域快路径：模型调用 = 生成轮 1 次 + 复核轮 1~2 次，
// 拒答 / 裁剪均为复核轮后的确定性动作（不触发兜底结论模型调用）；复核轮用注入的假 LLM（契约 JSON）返回。

test("⑧ 复核轮·例2 夏侯渊字什么：复核判 unsupported（片段无夏侯渊的字）→ 拒答", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。族弟夏侯渊。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("夏侯渊字妙才。[片段1]")
      : supportCheckResponse("unsupported", [["片段1", "unsupported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯渊字妙才",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯渊字什么", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "演义原文无该信息：复核判不支撑 → 拒答");
  assert.deepEqual(data.citations, [], "拒答清空引用");
  assert.equal(modelCallCount, 2, "生成轮 + 复核轮各一次；拒答是后置确定性动作，不触发兜底结论模型调用");
});

test("⑨ 复核轮·例3 刘备死的时候多少岁：复核判 unsupported（片段无年龄事实）→ 拒答", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0055:c0009",
      text: "孙权闻玄德与孙夫人已去，急召周瑜商议。周瑜曰：“可速追之。”遂令甘宁、凌统引兵追赶。",
      chapter: 55,
      title: "玄德智激孙夫人　孔明二气周瑜",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("刘备死的时候六十三岁。[片段1]")
      : supportCheckResponse("unsupported", [["片段1", "unsupported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "刘备六十三岁",
    modelCaller,
  });
  const data = await agent.processQueryData("刘备死的时候多少岁", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "片段无年龄事实，模型凭史实先验作答应被复核轮拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2);
});

test("⑩ 复核轮·例1 马超投靠刘备后如何：复核判 unsupported（注入片段无结局内容）→ 拒答", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0065:c0007",
      text: "马超与张飞在葭萌关前大战，玄德在城上观战。自白日战至夜，不分胜负。",
      chapter: 65,
      title: "马超大战葭萌关　刘备自领益州牧",
      type: "narration",
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0057:c0016",
      text: "马腾受衣带诏，与马超商议，欲除曹操。",
      chapter: 57,
      title: "柴桑口卧龙吊丧　耒阳县凤雏理事",
      type: "narration",
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0058:c0002",
      text: "马超与韩遂合兵，在潼关与曹操对峙。",
      chapter: 58,
      title: "马孟起兴兵雪恨　曹阿瞒割须弃袍",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("马超投靠刘备后，成为蜀汉五虎上将之一，最终病逝。[片段2]")
      : supportCheckResponse("unsupported", [["片段2", "unsupported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "马超病逝",
    modelCaller,
  });
  const data = await agent.processQueryData("马超投靠刘备后，后来如何了", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "注入片段（衣带诏等）无「五虎/病逝」结局证据 → 复核判不支撑 → 拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2);
});

test("⑪ 复核轮·问法变体 马超后来咋样了：无语义触发词（词表旧规则必漏放）→ 复核判 unsupported → 拒答", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0057:c0016",
      text: "马腾受衣带诏，与马超商议，欲除曹操。",
      chapter: 57,
      title: "柴桑口卧龙吊丧　耒阳县凤雏理事",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("马超的境遇不错，后来成了一方大将。[片段1]")
      : supportCheckResponse("unsupported", [["片段1", "unsupported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "马超境遇不错",
    modelCaller,
  });
  const data = await agent.processQueryData("马超后来咋样了", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "答案无死亡/数值/表字信号、人物锚点成立——词表旧规则必漏放，语义复核判不支撑 → 拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2);
});

test("⑫ 复核轮·问法变体 马超投奔刘备后的结局：无词表触发信号 → 复核判 unsupported → 拒答", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0065:c0007",
      text: "马超与张飞在葭萌关前大战，玄德在城上观战。自白日战至夜，不分胜负。",
      chapter: 65,
      title: "马超大战葭萌关　刘备自领益州牧",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("马超投奔刘备后的结局十分风光。[片段1]")
      : supportCheckResponse("unsupported", [["片段1", "unsupported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "马超结局风光",
    modelCaller,
  });
  const data = await agent.processQueryData("马超投奔刘备后的结局", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "片段只讲葭萌关之战，不讲结局 → 语义复核拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2);
});

test("⑬ 复核轮·部分支撑：只留 supported 引用、摘除 unsupported、指针重编号、citations 与 cited 回填", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。族弟夏侯渊。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0009:c0003",
      text: "袁绍聚众官于帐中，商议起兵。",
      chapter: 9,
      title: "除暴凶吕布助司徒　犯长安李傕听贾诩",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("袁绍聚众商议起兵，夏侯渊亦在军中。[片段1][片段2]")
      : supportCheckResponse("supported", [
          ["片段1", "unsupported"],
          ["片段2", "supported"],
        ]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "袁绍聚众商议起兵",
    modelCaller,
  });
  const data = await agent.processQueryData("袁绍如何起兵", "sango-novel");
  assert.equal(data.citations.length, 1, "只保留 supported 引用：夏侯惇段被判 unsupported 被剔除");
  assert.ok(data.citations[0].text.includes("袁绍聚众官于帐中"), "保留片段为聚集起兵的袁绍段");
  assert.doesNotMatch(data.answer, /\[片段1\]/, "不支撑指针已从正文移除");
  assert.doesNotMatch(data.answer, /夏侯惇字元让/, "被剔除片段不进 citations");
  assert.match(data.answer, /¹$/, "剩余支撑引用按渲染顺序重编号角标");
  assert.equal(modelCallCount, 2, "裁剪是复核轮后的确定性动作，不触发兜底模型调用");
});

test("⑭ 复核轮·表字正例不误伤：复核判 supported → 原样返回（语义支撑，不再依赖表字值字面归属）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("夏侯惇字元让。[片段1]")
      : supportCheckResponse("supported", [["片段1", "supported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯惇字元让",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯惇字什么", "sango-novel");
  assert.ok(data.answer.includes("字元让"), "表字值在片段中：复核判 supported，不拒答、不裁剪");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 2);
});

test("⑮ 复核轮·数值正例不误伤：中阿同值（答案 55 岁 ↔ 片段「年五十五」）复核判 supported → 原样返回", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0081:c0007",
      text: "原来张飞每睡不合眼；二贼以短刀刺入飞腹。飞大叫一声而亡。时年五十五。",
      chapter: 81,
      title: "急兄仇张飞遇害　雪弟恨先主兴兵",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("张飞遇害时年55岁。[片段1]")
      : supportCheckResponse("supported", [["片段1", "supported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "张飞五十五岁遇害",
    modelCaller,
  });
  const data = await agent.processQueryData("张飞遇害时多大岁数", "sango-novel");
  assert.ok(data.answer.includes("55岁"), "数值语义等价互相支撑：复核判 supported，不拒答");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 2);
});

test("⑯ 复核轮·纯叙述放行（控制组）：叙述句答案引用叙述段，复核判 supported → 原样返回", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0065:c0007",
      text: "马超与张飞在葭萌关前大战，玄德在城上观战。自白日战至夜，不分胜负。",
      chapter: 65,
      title: "马超大战葭萌关　刘备自领益州牧",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("张飞与马超大战百余合，不分胜负。[片段1]")
      : supportCheckResponse("supported", [["片段1", "supported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "张飞与马超不分胜负",
    modelCaller,
  });
  const data = await agent.processQueryData("张飞和马超谁赢了", "sango-novel");
  assert.ok(data.answer.includes("不分胜负"), "纯叙述答案不被错误拒答");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 2);
});

test("⑰ 复核轮·overall=uncertain 按 unsupported 拒答（宁拒勿猜）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。族弟夏侯渊。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("夏侯渊字妙才。[片段1]")
      : supportCheckResponse("uncertain", [["片段1", "uncertain"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯渊字妙才",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯渊字什么", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "uncertain 按 unsupported 处理（A004 宁拒勿猜）");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2);
});

test("⑱ 复核轮·JSON 解析失败重试 1 次后仍失败 → 按 unsupported 拒答（non-JSON 输出不进入响应）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。族弟夏侯渊。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (modelCallCount === 1) {
      return textResponse("夏侯渊字妙才。[片段1]");
    }
    return textResponse("这段片段支撑这个结论。"); // 两次复核轮均输出散文（非契约 JSON）
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯渊字妙才",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯渊字什么", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "解析失败重试 1 次后仍失败 → 按 unsupported 拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 3, "生成轮 1 次 + 复核轮 2 次（首轮 + 重试）");
});

test("⑲ 复核轮日志：成功轮记 llm_call_logs（stage=novel_support_check，含输入摘要 / 输出），不加新字段", async () => {
  const traceId = "bug28-ok-logs-0001";
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  const { openai } = scriptedOpenAI([
    { content: "夏侯惇字元让。[片段1]", finishReason: "stop" },
    { content: '{"citations":[{"pointer":"片段1","support":"supported"}],"overall":"supported"}', finishReason: "stop" },
  ]);
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯惇字元让",
  });
  injectOpenAI(agent, openai);
  store.ensureSkeleton("chat", traceId, "夏侯惇字什么", "sango-novel", Date.now());
  const data = await runWithTraceId(traceId, () =>
    agent.processQueryData("夏侯惇字什么", "sango-novel")
  );
  store.flush();
  const detail = store.queryDetail(traceId)!;
  const checkCalls = detail.llmCalls.filter((call) => call.stage === "novel_support_check");
  assert.equal(checkCalls.length, 1, "复核判 supported：恰一条 novel_support_check 成功行");
  assert.equal(checkCalls[0].status, "success");
  assert.equal(checkCalls[0].attempt, 1);
  assert.ok(
    (checkCalls[0].requestSummary ?? "").includes("【注入片段】"),
    "输入摘要含注入片段全文视图"
  );
  assert.ok(
    (checkCalls[0].responseSummary ?? "").includes("supported"),
    "输出摘要含契约 JSON"
  );
  assert.ok(data.answer.includes("字元让"), "复核判 supported → 原样返回");
  assert.equal(detail.log.answer, null, "request_logs.answer 由 server 层 markResponded 回填（本单测只验 llm_call_logs）");
});

test("⑳ 复核轮日志：解析失败 ×2 计数落库（status=failed 标记行复用现有字段，观测解析率）", async () => {
  const traceId = "bug28-parse-fail-0001";
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。族弟夏侯渊。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  const { openai } = scriptedOpenAI([
    { content: "夏侯渊字妙才。[片段1]", finishReason: "stop" },
    { content: "我不知道怎么输出 JSON。", finishReason: "stop" },
    { content: "还是不会输出 JSON。", finishReason: "stop" },
  ]);
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯渊字妙才",
  });
  injectOpenAI(agent, openai);
  store.ensureSkeleton("chat", traceId, "夏侯渊字什么", "sango-novel", Date.now());
  const data = await runWithTraceId(traceId, () =>
    agent.processQueryData("夏侯渊字什么", "sango-novel")
  );
  store.flush();
  assert.equal(data.answer, "演义中未涉及", "解析失败重试后仍失败 → 拒答");
  const detail = store.queryDetail(traceId)!;
  const checkCalls = detail.llmCalls.filter((call) => call.stage === "novel_support_check");
  assert.equal(checkCalls.length, 4, "2 次 HTTP 成功行 + 2 个解析失败 failed 标记行");
  assert.equal(
    checkCalls.filter((call) => call.status === "success").length,
    2,
    "两轮复核调用本身都成功返回"
  );
  const failed = checkCalls.filter((call) => call.status === "failed");
  assert.equal(failed.length, 2, "解析失败计数 = failed 标记行数（观测解析率）");
  assert.ok(
    failed.every((call) => call.errorMessage.includes("解析失败")),
    "失败标记行 error_message 落解析失败原因（复用现有字段，不新增列）"
  );
});

test("㉑ 复核轮·问题-答案对齐（trace 2b12dd5f 复刻）：问投靠后结局、答归降过程——片段支撑答案断言但答非所问 → 复核判 unsupported → 拒答", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0065:c0007",
      text: "马超与张飞在葭萌关前大战，玄德在城上观战。诸葛亮用计，马超乃降，归顺刘备。",
      chapter: 65,
      title: "马超大战葭萌关　刘备自领益州牧",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? textResponse("在葭萌关与张飞大战，后经诸葛亮用计归降刘备。[片段1]")
      : supportCheckResponse("unsupported", [["片段1", "unsupported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "马超归降刘备",
    modelCaller,
  });
  const data = await agent.processQueryData("马超投靠刘备后，后来如何了", "sango-novel");
  assert.equal(data.answer, "演义中未涉及", "引用片段支撑答案断言，但答非所问（要的是投靠后结局，答的是归降过程）→ 复核判 unsupported → 拒答");
  assert.deepEqual(data.citations, [], "拒答清空引用");
  assert.equal(modelCallCount, 2, "生成轮 + 复核轮各一次；拒答是复核轮后的确定性动作，不触发兜底结论模型调用");
});

test("㉒ 复核轮·输入构建：user 消息含【用户问题】与 query 原文（防输入构建回归）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0005:c0002",
      text: "夏侯惇字元让，沛国谯人也。",
      chapter: 5,
      title: "发矫诏诸镇应曹公　破关兵三英战吕布",
      type: "narration",
      quotes: [],
    },
  ];
  const seen: any[] = [];
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    seen.push(messages);
    return seen.length === 1
      ? textResponse("夏侯惇字元让。[片段1]")
      : supportCheckResponse("supported", [["片段1", "supported"]]);
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯惇字元让",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯惇字什么", "sango-novel");
  const checkUser = (seen[1] as any[]).find((message) => message.role === "user");
  assert.equal(typeof checkUser?.content, "string", "复核轮 user 内容为纯文本（无工具致盲）");
  assert.ok(checkUser.content.includes("【用户问题】"), "复核输入含【用户问题】段");
  assert.ok(checkUser.content.includes("夏侯惇字什么"), "复核输入含 query 原文");
  assert.ok(checkUser.content.includes("【注入片段】"), "复核输入仍含注入片段全文视图");
  assert.ok(checkUser.content.includes("【模型答案】"), "复核输入仍含模型答案段");
  assert.ok(checkUser.content.includes("【引用指针清单】"), "复核输入仍含引用指针清单段");
  assert.ok(data.answer.includes("字元让"), "复核判 supported → 原样返回");
  assert.equal(seen.length, 2, "生成轮 + 复核轮各一次");
});

test("㉓ 复核轮·提示词含问题-答案对齐判定指令（正面回答 / 答非所问）", async () => {
  assert.ok(SUPPORT_CHECK_SYSTEM_PROMPT.includes("用户问题"), "提示词声明输入含用户问题");
  assert.ok(SUPPORT_CHECK_SYSTEM_PROMPT.includes("正面回答"), "判定对象 = 答案对用户问题的回答，须正面回答");
  assert.ok(SUPPORT_CHECK_SYSTEM_PROMPT.includes("答非所问"), "含答非所问判定指令（未触及问题 → unsupported）");
});
