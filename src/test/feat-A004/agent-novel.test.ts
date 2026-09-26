import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import { loadAliasTable } from "../../citation.js";
import { NOVEL_BOUNDARY_CHECK_PROMPT, SANGO_NOVEL_DOMAIN_PROMPT } from "../../agent.js";
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
      : textResponse("斩华雄者系关羽，原文见[Q1]。");
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
  assert.equal(modelCallCount, 2, "分类 + 生成各一次：结构门放行后无兜底模型调用");
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
      : textResponse(`斩华雄者系关羽，曰「${longQuote}」[Q1]。`);
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
  assert.equal(modelCallCount, 2, "长引语安全网 + 结构门均为确定性动作，无兜底模型调用");
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
      : textResponse("关羽（云长）温酒斩华雄。[Q2]");
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
  assert.equal(modelCallCount, 2, "分类 + 生成各一次：结构门放行后无兜底模型调用");
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
      : textResponse("张飞当夜寝于帐中，二贼以短刀刺入飞腹，大叫一声而亡。[片段5]");
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
  assert.ok(data.answer.startsWith("张飞当夜寝于帐中"), "叙述句指针渲染后保留结论");
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
  assert.equal(modelCallCount, 2, "分类 + 生成各一次：结构门放行后无兜底模型调用");
});


// ===== bug-00028 结构保险丝（bug-00032/33/34 修订）：重叠门改为「低重叠 → 边界语义复核」 =====
// 语义裁决收进生成轮通用指令（SANGO_NOVEL_DOMAIN_PROMPT 第 6~8 条），规则层只留结构门
// （指针合法 / 人物⊆召回 / 句-片段文本重叠）。全部走 domain=sango-novel 标签锁域快路径：
// 生成轮 1 次；重叠 ≥0.5 的叙述句零额外 LLM（确定性放行，无 novel_boundary_check 调用）；
// 重叠 <0.5 的待裁句触发独立复核 stage novel_boundary_check（mock 两路：supported 放行 /
// unsupported 裁剪），正常样本不出现；拒答 / 裁剪后的动作仍为确定性（不触发兜底结论模型调用）。

test("⑧ 单轮·例2 夏侯渊字什么：片段无夏侯渊的字 → 生成轮按域提示自律拒答（演义中未涉及）", async () => {
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
    return textResponse("演义中未涉及"); // 片段无夏侯渊的字信息：生成轮按域提示自律拒答
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
  assert.equal(data.answer, "演义中未涉及", "演义原文无该信息：生成轮按域提示自律拒答");
  assert.deepEqual(data.citations, [], "拒答清空引用");
  assert.equal(modelCallCount, 1, "单轮生成：拒答由生成轮直接输出，无复核轮 / 兜底模型调用");
});

test("⑨ 单轮·边界复核·负例 刘备死的时候多少岁：答案与片段零重叠 → 复核 unsupported → 裁剪后拒答", async () => {
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
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported"); // 片段不含死亡年龄，复核判定不支撑 → 裁剪
    }
    return textResponse("刘备死的时候六十三岁。[片段1]"); // 答案断言与片段文本零重叠 → 触发边界复核
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
  assert.equal(data.answer, "演义中未涉及", "答案断言与片段零重叠 → 复核 unsupported → 裁剪整句 → 无留存句拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(checkCallCount, 1, "零重叠触发一次边界复核");
});

test("⑩ 单轮·边界复核·负例 马超五虎/病逝先验断言：片段无该内容 → 复核 unsupported → 裁剪后拒答", async () => {
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
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported"); // 五虎/病逝是片段外先验断言，复核判定不支撑
    }
    return textResponse("马超位列五虎上将，后以病逝告终。[片段1]"); // 先验断言风格（与片段低重叠）
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
  assert.equal(data.answer, "演义中未涉及", "五虎/病逝为片段外先验断言 → 复核 unsupported → 裁剪 → 无留存拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(checkCallCount, 1, "低重叠触发一次边界复核");
});

test("⑪ 单轮·边界复核·正例 关羽拒婚：改述结论句重叠 <0.5 但片段语义支撑 → supported 放行整句", async () => {
  const entries = [
    { id: "sanguo-yanyi:0073:c0001", text: "诸葛亮率众官劝刘备进位汉中王，备三让乃受。", chapter: 73, title: "玄德进位汉中王　云长攻拔襄阳郡", type: "narration", quotes: [] },
    { id: "sanguo-yanyi:0073:c0002", text: "刘备遣刘封、孟达攻取上庸诸郡，诸将皆贺。", chapter: 73, title: "玄德进位汉中王　云长攻拔襄阳郡", type: "narration", quotes: [] },
    { id: "sanguo-yanyi:0073:c0003", text: "曹操患头风，召华佗医治，华佗言须开颅。", chapter: 73, title: "玄德进位汉中王　云长攻拔襄阳郡", type: "narration", quotes: [] },
    { id: "sanguo-yanyi:0073:c0004", text: "关羽率众攻樊城，于禁、庞德引七军来救。", chapter: 73, title: "玄德进位汉中王　云长攻拔襄阳郡", type: "narration", quotes: [] },
    {
      id: "sanguo-yanyi:0073:c0008",
      text: "权遣使至荆州，为其子求娶关羽之女。关公大怒，曰：“虎女焉能嫁犬子！”遂不允婚，使者惭退。",
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("supported"); // 片段含「大怒…不允婚」：语义支撑 → 放行
    }
    return textResponse("关羽怒斥使者，拒绝联姻。[片段5]"); // 改述结论，字面重叠 ≈0.22（bug-00032 实证句）
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "关羽拒绝联姻",
    modelCaller,
  });
  const data = await agent.processQueryData("孙权遣人向关羽求亲，关羽是怎么回复使者的", "sango-novel");
  assert.ok(data.answer.includes("关羽怒斥使者，拒绝联姻"), "语义支撑的改述结论放行整句，不误裁");
  assert.equal(data.citations.length, 1, "只收被引用片段：仅 [片段5] 所在片段");
  assert.ok(data.citations[0].text.includes("不允婚"), "citation 为求亲被拒片段原文");
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(checkCallCount, 1, "低重叠触发一次边界复核，supported 放行");
});

test("⑫ 单轮·边界复核·正例 赤壁之战：改述结论句重叠 <0.5 但片段语义支撑 → supported 放行整句", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0044:c0001",
      text: "鲁肃劝孙权联刘抗曹，权犹豫未决。",
      chapter: 44,
      title: "孔明用智激周瑜　孙权决计破曹操",
      type: "narration",
      quotes: [],
    },
    {
      id: "sanguo-yanyi:0077:c0009",
      text: "周瑜用火攻，大破曹操于赤壁，此战遂定三分之势。",
      chapter: 44,
      title: "孔明用智激周瑜　孙权决计破曹操",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("supported"); // 片段含「破曹操于赤壁」：语义支撑 → 放行
    }
    return textResponse("孙刘联军火烧战船，大破曹军，这便是赤壁之战。[片段2]"); // 改述结论，字面重叠 ≈0.11（bug-00033 实证句）
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "赤壁之战",
    modelCaller,
  });
  const data = await agent.processQueryData("赤壁之战是怎么一回事", "sango-novel");
  assert.ok(data.answer.includes("这便是赤壁之战"), "语义支撑的改述结论放行整句，不误裁");
  assert.equal(data.citations.length, 1, "只收被引用片段：仅 [片段2] 所在片段");
  assert.ok(data.citations[0].text.includes("破曹操于赤壁"), "citation 为赤壁之战片段原文");
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(checkCallCount, 1, "低重叠触发一次边界复核，supported 放行");
});

test("⑬ 单轮·边界复核·正例 夏侯惇左目：改述结论句重叠 <0.5 但片段语义支撑 → supported 放行整句", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0018:c0014",
      text: "夏侯惇正与曹性交战，被曹性一箭射中左目。惇大叫一声，拔矢啖睛，纵马直取曹性。",
      chapter: 18,
      title: "贾文和料敌决胜　夏侯惇拔矢啖睛",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("supported"); // 片段含「射中左目 + 拔矢啖睛」：语义支撑 → 放行
    }
    return textResponse("夏侯惇的左眼被曹性射瞎。[片段1]"); // 改述结论，字面重叠 ≈0.4（bug-00034 实证句）
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯惇左目被曹性射瞎",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯惇的左眼是怎么瞎的", "sango-novel");
  assert.ok(data.answer.includes("夏侯惇的左眼被曹性射瞎"), "语义支撑的改述结论放行整句，不误裁");
  assert.equal(data.citations.length, 1, "只收被引用片段：仅 [片段1] 所在片段");
  assert.ok(data.citations[0].text.includes("拔矢啖睛"), "citation 为射中左目片段原文");
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(checkCallCount, 1, "低重叠触发一次边界复核，supported 放行");
});

test("⑭ 单轮·结构门·表字正例不误伤：叙述句与片段高度重叠 → 原样返回", async () => {
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
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported");
    }
    return textResponse("夏侯惇字元让。[片段1]"); // 句子 2-gram 与片段全重合 → 结构门放行
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
  assert.ok(data.answer.includes("字元让"), "表字值在片段中：重叠达标，不拒答、不裁剪");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 1, "单轮生成：结构门放行是生成后的确定性动作");
  assert.equal(checkCallCount, 0, "重叠达标：不触发边界语义复核（零额外 LLM 调用）");
});

test("⑯ 单轮·结构门·纯叙述放行（控制组）：叙述句与片段重叠达标 → 原样返回", async () => {
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
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported");
    }
    return textResponse("马超与张飞在葭萌关前大战百余合，不分胜负。[片段1]"); // 与片段高分重叠 → 放行
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
  assert.ok(data.answer.includes("不分胜负"), "叙述句与片段重叠达标，不被错误拒答");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 1, "单轮生成：结构门放行是生成后的确定性动作");
  assert.equal(checkCallCount, 0, "重叠达标：不触发边界语义复核（零额外 LLM 调用）");
});

test("㉓ 单轮·生成轮提示词含三条通用语义指令且不含具体案例词", () => {
  assert.ok(SANGO_NOVEL_DOMAIN_PROMPT.includes("片段外信息不写不补"), "指令 a：片段外信息不写不补");
  assert.ok(SANGO_NOVEL_DOMAIN_PROMPT.includes("答非所问"), "指令 b：必须直接回答用户问题本身");
  assert.ok(SANGO_NOVEL_DOMAIN_PROMPT.includes("与演义记载不符"), "指令 c：问题前提与演义不符 → 校正后再作答");
  assert.ok(SANGO_NOVEL_DOMAIN_PROMPT.includes("禁止拒答"), "指令 c：前提不符禁止硬凑与拒答");
  for (const banned of ["夏侯惇", "马超", "右眼", "左目", "葭萌关", "曹性"]) {
    assert.ok(
      !SANGO_NOVEL_DOMAIN_PROMPT.includes(banned),
      `通用指令不得含具体案例词：${banned}`
    );
  }
});

test("㉔ 单轮·边界复核部分裁剪：低重叠句复核 unsupported 被裁剪、高重叠句保留并渲染，citations 只收保留片段", async () => {
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
      id: "sanguo-yanyi:0009:c0003",
      text: "袁绍聚众官于帐中，商议起兵。",
      chapter: 9,
      title: "除暴凶吕布助司徒　犯长安李傕听贾诩",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported"); // 片段2（袁绍）与句义不支撑 → 裁剪
    }
    return textResponse("马超与张飞战于葭萌关，不分胜负。[片段1] 马超后来投靠了袁绍。[片段2]");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "马超与张飞不分胜负",
    modelCaller,
  });
  const data = await agent.processQueryData("马超与张飞战况如何", "sango-novel");
  assert.ok(data.answer.includes("不分胜负"), "高重叠句保留并渲染");
  assert.doesNotMatch(data.answer, /投靠了袁绍/, "低重叠句被结构门裁剪");
  assert.equal(data.citations.length, 1, "只收保留句引用的片段");
  assert.ok(data.citations[0].text.includes("葭萌关"), "保留片段为片段1（葭萌关段）");
  assert.ok(data.answer.endsWith("¹"), "保留指针渲染上标角标");
  assert.equal(modelCallCount, 2, "生成轮 + 低重叠句边界语义复核各一次");
  assert.equal(checkCallCount, 1, "仅低重叠句（袁绍句）触发一次复核，unsupported → 裁剪");
});

test("㉕ 单轮·边界复核·负例 bug-00037：结论句不带指针、指针挂引文句 → 结论断言纳入全片段重叠检查，复核 unsupported 裁剪（trace 4d7a408a 复刻）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0073:c0003",
      text: "封关羽、张飞、赵云、马超、黄忠为五虎大将。玄德既为汉中王，遂修表一道，差人赍赴许都。表曰：臣昔与车骑将军董承，图谋讨操，机事不密，承见陷害。",
      chapter: 73,
      title: "玄德进位汉中王　云长攻拔襄阳郡",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported"); // 片段中车骑将军属董承、无司隶校尉/西乡侯，张飞之封为片段外先验 → 不支撑
    }
    return textResponse("刘备登基后，张飞被封为车骑将军、领司隶校尉，进封西乡侯。\n\n[片段1] 封关羽、张飞、赵云、马超、黄忠为五虎大将。玄德既为汉中王，遂修表一道，差人赍赴许都。表曰：臣昔与车骑将军董承，图谋讨操，机事不密，承见陷害。");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "张飞被封为车骑将军",
    modelCaller,
  });
  const data = await agent.processQueryData("刘备登基后，张飞被封为什么", "sango-novel");
  assert.doesNotMatch(data.answer, /领司隶校尉|进封西乡侯|被封为车骑将军/, "无指针结论断言（车骑将军/司隶校尉/西乡侯）与注入片段不支撑 → 裁剪");
  assert.equal(checkCallCount, 1, "无指针结论句触发一次边界复核");
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(data.citations.length, 1, "引文句保留并渲染");
  assert.ok(data.answer.includes("玄德既为汉中王"), "引用句（片段原文）保留");
});

test("㉖ 单轮·边界复核·正例：无指针改述结论句与片段语义支撑 → supported 放行整句（防过度裁剪）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0069:c0009",
      text: "孙权遣人至荆州，欲结亲于关羽。关羽大怒曰：吾虎女安肯嫁犬子乎！遂不允婚事。",
      chapter: 69,
      title: "刘备进位汉中王　关羽水淹七军",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("supported"); // 片段含「关羽大怒…不允婚事」：语义支撑改述 → 放行
    }
    return textResponse("关羽怒斥孙权使者，拒绝联姻。\n\n[片段1] 孙权遣人至荆州，欲结亲于关羽。关羽大怒曰：吾虎女安肯嫁犬子乎！遂不允婚事。");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "关羽拒婚",
    modelCaller,
  });
  const data = await agent.processQueryData("孙权向关羽求亲，关羽怎么回复", "sango-novel");
  assert.ok(data.answer.includes("关羽怒斥孙权使者，拒绝联姻"), "无指针改述结论句语义支撑 → supported 放行");
  assert.equal(checkCallCount, 1, "无指针结论句触发一次边界复核");
  assert.equal(modelCallCount, 2, "生成轮 + 边界语义复核各一次");
  assert.equal(data.citations.length, 1, "引文句保留并渲染");
});

test("㉗ 单轮·边界复核·负例 bug-00038：结论句判 unsupported 裁剪、仅剩裸 [片段1] 行（无正文）→ 拒答「演义中未涉及」且 citations 为空（trace ba5bb4ec 复刻）", async () => {
  const entries = [
    {
      id: "sanguo-yanyi:0071:c0001",
      text: "夏侯渊与黄忠对阵，两马相交，未及数合，黄忠诈败而走，渊随后赶来，至汉水南岸，黄忠回身一箭，正中渊肩窝，夏侯渊落马而死。",
      chapter: 71,
      title: "占对山黄忠逸待劳　据汉水赵云寡胜众",
      type: "narration",
      quotes: [],
    },
  ];
  let modelCallCount = 0;
  let checkCallCount = 0;
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCallCount += 1;
    if (messages[0]?.content === NOVEL_BOUNDARY_CHECK_PROMPT) {
      checkCallCount += 1;
      return textResponse("unsupported"); // 「夏侯渊字妙才」为片段无载的先验知识 → 复核不支撑
    }
    return textResponse("夏侯渊字妙才。\n\n[片段1]"); // 先验断言结论句 + 单独成行的裸 [片段1] 引用指针
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
  assert.equal(data.answer, "演义中未涉及", "结论句被裁、仅剩的裸引用行无正文 → 拒答，不渲染空正文+脚注");
  assert.deepEqual(data.citations, []);
  assert.equal(checkCallCount, 1, "仅结论句触发一次边界复核；裸 [片段1] 行（无正文）不进复核候选");
  assert.equal(modelCallCount, 2, "生成轮 + 一次边界语义复核");
});
