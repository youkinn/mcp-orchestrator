import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MCPTransport,
  SANGO_SERVER_NAME,
  WEATHER_SERVER_NAME,
  type MCPServerConfig,
  type MCPServerConnection,
  type MCPServerConnectionFactory,
} from "../../transport.js";
import { Agent } from "../../agent.js";
import { ToolExecutionError, type MCPToolDefinition } from "../../types.js";
import type { LLMConfig } from "../../types.js";

const FORECAST: MCPToolDefinition = {
  name: "get-forecast",
  description: "获取美国境内某个经纬度位置的天气预报",
  inputSchema: { type: "object" },
};
const ALERTS: MCPToolDefinition = {
  name: "get-alerts",
  description: "获取美国某个州的当前天气预警",
  inputSchema: { type: "object" },
};
const NOVEL: MCPToolDefinition = {
  name: "sango_novel_search",
  description: "检索《三国演义》原著原文段落",
  inputSchema: { type: "object" },
};

/** 假连接：只记录调用，不起真实 stdio 子进程；可注入 connect 失败 */
class FakeConnection implements MCPServerConnection {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  constructor(
    public tools: MCPToolDefinition[],
    public connectError: Error | null = null
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
    return { content: [{ type: "text", text: `ok:${name}` }] };
  }

  async close(): Promise<void> {}
}

/** 按 server 名生成假连接的工厂；可指定哪些 server 连接失败 */
class FakeFactory implements MCPServerConnectionFactory {
  connections: Map<string, FakeConnection> = new Map();

  constructor(
    private toolsByServer: Record<string, MCPToolDefinition[]>,
    private failServers: string[] = []
  ) {}

  create(config: MCPServerConfig): MCPServerConnection {
    const connection = new FakeConnection(
      this.toolsByServer[config.name] ?? [],
      this.failServers.includes(config.name) ? new Error("connect failed") : null
    );
    this.connections.set(config.name, connection);
    return connection;
  }
}

function weatherSangoConfigs(): MCPServerConfig[] {
  return [
    { name: WEATHER_SERVER_NAME, scriptPath: "w.js", required: true },
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

test("listTools：合并 weather 与 sango 两个 server 的工具（按注册顺序）", async () => {
  const factory = new FakeFactory({
    weather: [FORECAST, ALERTS],
    sango: [NOVEL],
  });
  const transport = new MCPTransport(weatherSangoConfigs(), factory);
  await transport.connect();

  const tools = await transport.listTools();

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get-forecast", "get-alerts", "sango_novel_search"]
  );
});

test("callTool：按工具名路由到正确 server 转发，参数完整透传", async () => {
  const factory = new FakeFactory({
    weather: [FORECAST, ALERTS],
    sango: [NOVEL],
  });
  const transport = new MCPTransport(weatherSangoConfigs(), factory);
  await transport.connect();
  await transport.listTools();

  const forecast = await transport.callTool("get-forecast", {
    latitude: 40.71,
    longitude: -74.01,
  });
  const novel = await transport.callTool("sango_novel_search", {
    query: "温酒斩华雄",
  });

  assert.equal(forecast.content[0]?.text, "ok:get-forecast");
  assert.equal(novel.content[0]?.text, "ok:sango_novel_search");
  assert.deepEqual(factory.connections.get(WEATHER_SERVER_NAME)!.calls, [
    { name: "get-forecast", args: { latitude: 40.71, longitude: -74.01 } },
  ]);
  assert.deepEqual(factory.connections.get(SANGO_SERVER_NAME)!.calls, [
    { name: "sango_novel_search", args: { query: "温酒斩华雄" } },
  ]);
});

test("callTool：未先 listTools 也能按各 server 上报工具名懒解析归属", async () => {
  const factory = new FakeFactory({
    weather: [FORECAST],
    sango: [NOVEL],
  });
  const transport = new MCPTransport(weatherSangoConfigs(), factory);
  await transport.connect();

  const result = await transport.callTool("sango_novel_search", { query: "x" });

  assert.equal(result.content[0]?.text, "ok:sango_novel_search");
  assert.equal(
    factory.connections.get(SANGO_SERVER_NAME)!.calls[0]?.name,
    "sango_novel_search"
  );
});

test("callTool：未知工具名报错", async () => {
  const factory = new FakeFactory({
    weather: [FORECAST],
    sango: [NOVEL],
  });
  const transport = new MCPTransport(weatherSangoConfigs(), factory);
  await transport.connect();

  await assert.rejects(
    () => transport.callTool("no_such_tool", {}),
    /Unknown MCP tool: no_such_tool/
  );
});

test("缺配 sango：注册表只含 weather，sango 工具不可见、调用报未知工具", async () => {
  const configs: MCPServerConfig[] = [
    { name: WEATHER_SERVER_NAME, scriptPath: "w.js", required: true },
  ];
  const factory = new FakeFactory({ weather: [FORECAST, ALERTS] });
  const transport = new MCPTransport(configs, factory);
  await transport.connect();

  const tools = await transport.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get-forecast", "get-alerts"]
  );

  await assert.rejects(
    () => transport.callTool("sango_novel_search", { query: "x" }),
    /Unknown MCP tool: sango_novel_search/
  );
});

test("缺配 sango：经 Agent 调用其工具 → ToolExecutionError（503 语义）", async () => {
  const configs: MCPServerConfig[] = [
    { name: WEATHER_SERVER_NAME, scriptPath: "w.js", required: true },
  ];
  const factory = new FakeFactory({ weather: [FORECAST, ALERTS] });
  const transport = new MCPTransport(configs, factory);
  await transport.connect();

  const agent = new Agent(transport, makeLLMConfig(), {
    tools: [FORECAST, ALERTS],
    modelCaller: async () => ({
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "sango_novel_search",
          input: { query: "温酒斩华雄" },
        },
      ],
    }),
  });

  await assert.rejects(
    () => agent.processQuery("温酒斩华雄的原文？"),
    (error: unknown) =>
      error instanceof ToolExecutionError &&
      error.toolName === "sango_novel_search"
  );
});

test("可选 server 启动失败：独立失败，weather 照常，失败 server 的工具不可见", async () => {
  const factory = new FakeFactory(
    { weather: [FORECAST, ALERTS], sango: [NOVEL] },
    [SANGO_SERVER_NAME]
  );
  const transport = new MCPTransport(weatherSangoConfigs(), factory);
  await transport.connect();

  const tools = await transport.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get-forecast", "get-alerts"]
  );
  await assert.rejects(
    () => transport.callTool("sango_novel_search", { query: "x" }),
    /Unknown MCP tool: sango_novel_search/
  );
});

test("必需 server 启动失败：整体启动失败（connect 抛错）", async () => {
  const configs: MCPServerConfig[] = [
    { name: WEATHER_SERVER_NAME, scriptPath: "w.js", required: true },
  ];
  const factory = new FakeFactory({ weather: [FORECAST] }, [
    WEATHER_SERVER_NAME,
  ]);
  const transport = new MCPTransport(configs, factory);

  await assert.rejects(() => transport.connect(), /connect failed/);
});
