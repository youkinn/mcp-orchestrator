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

const WEATHER_TOOL: MCPToolDefinition = {
  name: "get-forecast",
  description: "获取美国境内天气预报",
  inputSchema: { type: "object" },
};

function makeConfig(provider: LLMProvider = "deepseek"): LLMConfig {
  return {
    provider,
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

function toolUseResponse(
  name: string,
  input: Record<string, unknown>
): ModelResponse {
  return { content: [{ type: "tool_use", id: "call_1", name, input }] };
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

test("domain=sango-novel 时 system 追加三国演义域提示（软性，不拦截非原著问句）", async () => {
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
  assert.ok(capturedSystem.includes("sango_novel_search"), "域提示应指向原著检索工具");
});

test("① 指针合法：模型只给结论 + 指针，服务端渲染引文 + 角标，citations 下沉片段（无额外模型调用）", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "谁斩了华雄？",
          limit: 5,
        })
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "华雄是怎么死的",
          limit: 5,
        })
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "诸葛亮借东风后去了哪？",
          limit: 5,
        })
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

test("④ 未调原著工具的其他域：不触发引用校验，无额外模型调用", async () => {
  let modelCallCount = 0;
  const modelCaller = async (): Promise<ModelResponse> => {
    modelCallCount += 1;
    return modelCallCount === 1
      ? toolUseResponse("get-forecast", { latitude: 40.7, longitude: -74 })
      : textResponse("纽约今日适合出行。");
  };

  const agent = new Agent(new MockTransport([WEATHER_TOOL]), makeConfig(), {
    tools: [WEATHER_TOOL],
    modelCaller,
  });

  const data = await agent.processQueryData("纽约天气怎么样？");
  assert.equal(data.answer, "纽约今日适合出行。");
  assert.deepEqual(data.citations, [], "未调原著工具的其他域 citations 恒 []");
  assert.equal(modelCallCount, 2, "天气域不应触发引用校验的额外模型调用");
});

test("⑤ 默认链路（本地别名表扫描 + 兜底结论）：校验不过走兜底", async () => {
  const responses = [
    toolUseResponse("sango_novel_search", {
      source: "sanguo-yanyi",
      query: "谁斩了华雄？",
      limit: 5,
    }),
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
      ? toolUseResponse("sango_novel_search", {
          source: "sanguo-yanyi",
          query: "张飞怎么死的",
          limit: 5,
        })
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
