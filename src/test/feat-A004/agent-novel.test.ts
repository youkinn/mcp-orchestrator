import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../agent.js";
import { MCPTransport } from "../../transport.js";
import { loadAliasTable } from "../../citation.js";
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
  assert.equal(modelCallCount, 2, "校验通过不应有额外模型调用");
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
  assert.equal(modelCallCount, 2, "安全网是确定性回收，不额外调模型");
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
  assert.equal(modelCallCount, 2, "校验通过不触发兜底结论归纳");
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
      : textResponse("张飞被范疆、张达刺死。[片段5]");
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
  assert.equal(modelCallCount, 2, "校验通过不触发兜底结论归纳");
});

// ===== bug-00028：生成轮支撑护栏（零 LLM）——三例回归 + 正例控制组 =====
// 判定动作：无任何支撑引用 → 拒答「演义中未涉及」+ 清空引用；有支撑但引用挂错 → 只去不支撑引用。
// 全部走 domain=sango-novel 标签锁域快路径：模型仅 1 次生成轮调用（拒答/裁剪均不触发兜底模型调用）。

test("⑧ 支撑护栏·例2 夏侯渊字什么（演义原文本无夏侯渊的字）：表字值不在注入片段 → 拒答", async () => {
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
    return textResponse("夏侯渊字妙才。[片段1]");
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
  assert.equal(data.answer, "演义中未涉及", "演义原文无该信息：凭先验作答应被护栏改写为拒答");
  assert.deepEqual(data.citations, [], "拒答清空引用");
  assert.equal(modelCallCount, 1, "拒答是后置确定性动作，不触发兜底结论模型调用");
});

test("⑨ 支撑护栏·例3 刘备死的时候多少岁：答案数值六十三不在注入片段 → 拒答", async () => {
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
    return textResponse("刘备死的时候六十三岁。[片段1]");
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
  assert.equal(data.answer, "演义中未涉及", "片段无年龄事实，模型凭史实先验作答应被拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 1);
});

test("⑩ 支撑护栏·例1 马超投靠刘备后如何：注入片段无结局内容（五虎/病逝无证据）→ 拒答", async () => {
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
    return textResponse("马超投靠刘备后，成为蜀汉五虎上将之一，最终病逝。[片段2]");
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
  assert.equal(data.answer, "演义中未涉及", "注入片段（衣带诏等）无「五虎/病逝」结局证据 → 拒答");
  assert.deepEqual(data.citations, []);
  assert.equal(modelCallCount, 1);
});

test("⑪ 支撑护栏·部分支撑：只去不支撑引用、保留支撑引用（tier 2），引用清空则整答拒答", async () => {
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
    return textResponse("夏侯渊随曹操讨吕布，大破之。[片段1][片段2]");
  };
  const agent = new Agent(new MockTransport([NOVEL_TOOL]), makeConfig(), {
    tools: [NOVEL_TOOL],
    aliasTable: ALIAS_TABLE,
    localTools: {
      sango_novel_search: async () => ({
        content: [{ type: "text", text: JSON.stringify(entries) }],
      }),
    },
    fallbackConcluder: async () => "夏侯渊随曹操破吕布",
    modelCaller,
  });
  const data = await agent.processQueryData("夏侯渊怎么打败吕布的", "sango-novel");
  assert.equal(data.citations.length, 1, "只保留支撑引用：袁绍段无人锚点被剔除");
  assert.ok(data.citations[0].text.includes("夏侯惇字元让"), "保留片段为含夏侯渊的片段");
  assert.doesNotMatch(data.answer, /\[片段2\]/, "不支撑指针已从正文移除");
  assert.doesNotMatch(data.answer, /袁绍/, "被剔除片段不进 citations");
  assert.match(data.answer, /¹$/, "剩余支撑引用按渲染顺序重编号角标");
  assert.equal(modelCallCount, 1, "裁剪是确定性动作，不触发兜底模型调用");
});

test("⑫ 支撑护栏·表字正例不误伤：表字值在片段中 → 原样保留（zi 判定只核值、不核归属）", async () => {
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
    return textResponse("夏侯惇字元让。[片段1]");
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
  assert.ok(data.answer.includes("字元让"), "表字值在片段中：不拒答、不裁剪");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 1);
});

test("⑬ 支撑护栏·数值正例不误伤：中阿同值（答案 55 岁 ↔ 片段「年五十五」）→ 原样保留", async () => {
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
    return textResponse("张飞遇害时年55岁。[片段1]");
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
  assert.ok(data.answer.includes("55岁"), "数值中阿同值互相支撑：不拒答");
  assert.equal(data.citations.length, 1);
  assert.equal(modelCallCount, 1);
});
