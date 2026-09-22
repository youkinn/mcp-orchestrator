import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCPTransport,
  SANGO_SERVER_NAME,
  FENGYUNSANGUO_SERVER_NAME,
  FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
  FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
  type MCPServerConfig,
  type MCPServerConnection,
  type MCPServerConnectionFactory,
} from "../../transport.js";
import { Agent } from "../../agent.js";
import { ToolExecutionError, type MCPToolDefinition } from "../../types.js";
import type { LLMConfig } from "../../types.js";

const NOVEL: MCPToolDefinition = {
  name: "sango_novel_search",
  description: "检索《三国演义》原著原文段落",
  inputSchema: { type: "object" },
};
const FENGYUNSANGUO_QUERY: MCPToolDefinition = {
  name: "fengyunsanguo_query",
  description: "风云三国题库候选召回",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};
const FENGYUNSANGUO_QUIZ_ROUTE: MCPToolDefinition = {
  name: FENGYUNSANGUO_QUIZ_ROUTE_TOOL,
  description: "风云三国题库高置信识别（L3）",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};
const FENGYUNSANGUO_QUIZ_COMMAND: MCPToolDefinition = {
  name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
  description: "风云三国随机一题状态机",
  inputSchema: { type: "object" },
};
const FENGYUNSANGUO_TOOLS: MCPToolDefinition[] = [
  FENGYUNSANGUO_QUERY,
  FENGYUNSANGUO_QUIZ_ROUTE,
  FENGYUNSANGUO_QUIZ_COMMAND,
];

/** 假连接：只记录调用，不起真实 stdio 子进程；可注入 connect 失败与按工具定制的返回 */
class FakeConnection implements MCPServerConnection {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    public tools: MCPToolDefinition[],
    public connectError: Error | null = null,
    private respond?: (
      name: string,
      args: Record<string, unknown>
    ) => { content: Array<{ type: string; text: string }> }
  ) {}

  async connect(): Promise<void> {
    if (this.connectError) {
      throw this.connectError;
    }
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    return this.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    this.calls.push({ name, args });
    return (
      this.respond?.(name, args) ?? {
        content: [{ type: "text", text: `ok:${name}` }],
      }
    );
  }

  async close(): Promise<void> {}
}

/** 按 server 名生成假连接的工厂；可指定哪些 server 连接失败 */
class FakeFactory implements MCPServerConnectionFactory {
  connections: Map<string, FakeConnection> = new Map();

  constructor(
    private toolsByServer: Record<string, MCPToolDefinition[]>,
    private failServers: string[] = [],
    private respond?: (
      name: string,
      args: Record<string, unknown>
    ) => { content: Array<{ type: string; text: string }> }
  ) {}

  create(config: MCPServerConfig): MCPServerConnection {
    const connection = new FakeConnection(
      this.toolsByServer[config.name] ?? [],
      this.failServers.includes(config.name) ? new Error("connect failed") : null,
      this.respond
    );
    this.connections.set(config.name, connection);
    return connection;
  }
}

// 天气已下线（feat-A011）：注册表示例只用 sango（演义）与 fengyunsanguo 两个 server，weather 不再装配
function sangoFengyunsanguoConfigs(): MCPServerConfig[] {
  return [
    { name: SANGO_SERVER_NAME, scriptPath: "s.js", required: false },
    { name: FENGYUNSANGUO_SERVER_NAME, scriptPath: "f.js", required: false },
  ];
}

function sangoOnlyConfigs(): MCPServerConfig[] {
  return [
    { name: SANGO_SERVER_NAME, scriptPath: "s.js", required: false },
  ];
}

function makeLLMConfig(): LLMConfig {
  return {
    provider: "deepseek",
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

test("listTools：合并 sango（演义）与 fengyunsanguo 两个 server 的工具（按注册顺序）", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
    fengyunsanguo: FENGYUNSANGUO_TOOLS,
  });
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  const tools = await transport.listTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "sango_novel_search",
      "fengyunsanguo_query",
      "fengyunsanguo_quiz_route",
      "fengyunsanguo_quiz_command",
    ]
  );
});

test("callTool：按工具名路由到正确 server 转发，参数完整透传", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
    fengyunsanguo: FENGYUNSANGUO_TOOLS,
  });
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();
  await transport.listTools();

  const novel = await transport.callTool("sango_novel_search", {
    query: "温酒斩华雄",
  });
  const query = await transport.callTool("fengyunsanguo_query", {
    text: "夏侯惇的字是什么？",
  });

  assert.equal(novel.content[0]?.text, "ok:sango_novel_search");
  assert.equal(query.content[0]?.text, "ok:fengyunsanguo_query");
  assert.deepEqual(factory.connections.get(SANGO_SERVER_NAME)!.calls, [
    { name: "sango_novel_search", args: { query: "温酒斩华雄" } },
  ]);
  assert.deepEqual(factory.connections.get(FENGYUNSANGUO_SERVER_NAME)!.calls, [
    { name: "fengyunsanguo_query", args: { text: "夏侯惇的字是什么？" } },
  ]);
});

test("callTool：未先 listTools 也能按各 server 上报工具名懒解析归属", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
    fengyunsanguo: FENGYUNSANGUO_TOOLS,
  });
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  const result = await transport.callTool("fengyunsanguo_query", { text: "x" });

  assert.equal(result.content[0]?.text, "ok:fengyunsanguo_query");
  assert.equal(
    factory.connections.get(FENGYUNSANGUO_SERVER_NAME)!.calls[0]?.name,
    "fengyunsanguo_query"
  );
});

test("callTool：未知工具名报错", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
    fengyunsanguo: FENGYUNSANGUO_TOOLS,
  });
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  await assert.rejects(
    () => transport.callTool("no_such_tool", {}),
    /Unknown MCP tool: no_such_tool/
  );
});

test("缺配 fengyunsanguo：注册表只含 sango，fengyunsanguo 工具不可见、调用报未知工具", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
  });
  const transport = new MCPTransport(sangoOnlyConfigs(), factory);
  await transport.connect();

  const tools = await transport.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["sango_novel_search"]
  );

  await assert.rejects(
    () => transport.callTool("fengyunsanguo_query", { text: "x" }),
    /Unknown MCP tool: fengyunsanguo_query/
  );
});

test("缺配 fengyunsanguo：quiz_route 返回 null（不命中），quiz_command 抛 ToolExecutionError（503 语义）", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
  });
  const transport = new MCPTransport(sangoOnlyConfigs(), factory);
  await transport.connect();

  assert.equal(await transport.fengyunsanguo_quiz_route("夏侯惇的字是什么？"), null);
  await assert.rejects(
    () => transport.fengyunsanguo_quiz_command("随机一题", "sid"),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.toolName === FENGYUNSANGUO_QUIZ_COMMAND_TOOL
  );
});

test("fengyunsanguo_quiz_route：按 server 返回文本解析布尔，命中 true、未命中 false", async () => {
  const factory = new FakeFactory(
    {
      sango: [NOVEL],
      fengyunsanguo: FENGYUNSANGUO_TOOLS,
    },
    [],
    (name, args) => ({
      content: [
        {
          type: "text",
          text: name === FENGYUNSANGUO_QUIZ_ROUTE_TOOL ? "true" : "false",
        },
      ],
    })
  );
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  assert.equal(
    await transport.fengyunsanguo_quiz_route("夏侯惇的字是什么？"),
    true
  );
  assert.deepEqual(
    factory.connections.get(FENGYUNSANGUO_SERVER_NAME)!.calls,
    [{ name: FENGYUNSANGUO_QUIZ_ROUTE_TOOL, args: { text: "夏侯惇的字是什么？" } }]
  );
});

test("fengyunsanguo_quiz_route：server 返回 JSON {\"hit\": true} 同样解析为命中", async () => {
  const factory = new FakeFactory(
    {
      fengyunsanguo: FENGYUNSANGUO_TOOLS,
    },
    [],
    (name) => ({
      content: [
        {
          type: "text",
          text:
            name === FENGYUNSANGUO_QUIZ_ROUTE_TOOL
              ? JSON.stringify({ hit: true })
              : "false",
        },
      ],
    })
  );
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  assert.equal(await transport.fengyunsanguo_quiz_route("司马懿的字是什么？"), true);
});

test("fengyunsanguo_quiz_command：message / sessionId 完整透传，返回工具内容", async () => {
  const factory = new FakeFactory(
    {
      fengyunsanguo: FENGYUNSANGUO_TOOLS,
    },
    [],
    (name, args) => ({
      content: [
        {
          type: "text",
          text:
            name === FENGYUNSANGUO_QUIZ_COMMAND_TOOL
              ? `题目：${String(args.message)}`
              : "ok",
        },
      ],
    })
  );
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  const result = await transport.fengyunsanguo_quiz_command("随机一题", "sid-1");

  assert.equal(result.content[0]?.text, "题目：随机一题");
  assert.deepEqual(
    factory.connections.get(FENGYUNSANGUO_SERVER_NAME)!.calls,
    [
      {
        name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL,
        args: { message: "随机一题", sessionId: "sid-1" },
      },
    ]
  );
});

test("fengyunsanguo_quiz_command：无 sessionId 时参数不含该字段", async () => {
  const factory = new FakeFactory({
    fengyunsanguo: FENGYUNSANGUO_TOOLS,
  });
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  await transport.fengyunsanguo_quiz_command("答案");

  assert.deepEqual(
    factory.connections.get(FENGYUNSANGUO_SERVER_NAME)!.calls,
    [{ name: FENGYUNSANGUO_QUIZ_COMMAND_TOOL, args: { message: "答案" } }]
  );
});

test("fengyunsanguo_quiz_command：server 调用失败 → ToolExecutionError（503 语义）", async () => {
  const factory = new FakeFactory({
    fengyunsanguo: FENGYUNSANGUO_TOOLS,
  });
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  transport.callTool = async () => {
    throw new Error("quiz process crashed");
  };

  await assert.rejects(
    () => transport.fengyunsanguo_quiz_command("随机一题", "sid"),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.toolName === FENGYUNSANGUO_QUIZ_COMMAND_TOOL &&
      error.cause instanceof Error &&
      error.cause.message === "quiz process crashed"
  );
});

test("缺配 fengyunsanguo：domain=fengyunsanguo 快路径预调 → ToolExecutionError（503 语义）", async () => {
  const factory = new FakeFactory({
    sango: [NOVEL],
  });
  const transport = new MCPTransport(sangoOnlyConfigs(), factory);
  await transport.connect();

  const agent = new Agent(transport, makeLLMConfig(), {
    tools: [...FENGYUNSANGUO_TOOLS],
    modelCaller: async () => ({
      content: [{ type: "text", text: "不应到达" }],
    }),
  });

  await assert.rejects(
    () => agent.processQuery("夏侯惇的字是什么？", "fengyunsanguo"),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.toolName === "fengyunsanguo_query"
  );
});

test("可选 server 启动失败：独立失败，sango（演义）照常，失败 server 的工具不可见", async () => {
  const factory = new FakeFactory(
    {
      sango: [NOVEL],
      fengyunsanguo: FENGYUNSANGUO_TOOLS,
    },
    [FENGYUNSANGUO_SERVER_NAME]
  );
  const transport = new MCPTransport(sangoFengyunsanguoConfigs(), factory);
  await transport.connect();

  const tools = await transport.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["sango_novel_search"]
  );
  await assert.rejects(
    () => transport.callTool("fengyunsanguo_query", { text: "x" }),
    /Unknown MCP tool: fengyunsanguo_query/
  );
});

test("必需 server 启动失败：整体启动失败（connect 抛错）", async () => {
  const configs: MCPServerConfig[] = [
    { name: SANGO_SERVER_NAME, scriptPath: "s.js", required: true },
  ];
  const factory = new FakeFactory({ sango: [NOVEL] }, [
    SANGO_SERVER_NAME,
  ]);
  const transport = new MCPTransport(configs, factory);

  await assert.rejects(() => transport.connect(), /connect failed/);
});
