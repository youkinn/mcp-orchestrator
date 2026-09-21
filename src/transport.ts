import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolExecutionError, type MCPToolDefinition, type ToolCallResult } from "./types.js";
import { getTraceId } from "./trace.js";
import { getLogStore, truncate, type LogStore } from "./storage/logs.js";

// feat-A007 工具明细埋点辅助（旁路静默）：序列化失败兜底 String，统一 8000 截断
function summarizeJson(value: unknown, max = 8000): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return (truncate(text ?? "", max) ?? "").trim();
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * feat-A009 落 result_summary 前剥离 _meta.diagnostics（硬约束 2：诊断单独落 tool_retrieval_logs，
 * 不挤占 result_summary 8000 预算）；_meta 仅剩空对象时整体置空。契约口径见 §3.1。
 */
function stripDiagnostics(result: ToolCallResult): unknown {
  const meta = result._meta;
  if (!meta || typeof meta !== "object") {
    return result;
  }
  const restMeta: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (key === "diagnostics") continue;
    restMeta[key] = value;
  }
  const rest = Object.keys(restMeta).length > 0 ? restMeta : undefined;
  return { ...result, _meta: rest };
}

/** isError 返回的错误描述：取返回内容中的文本拼接；无文本返回空串（调用方兜底文案） */
function extractToolError(result: ToolCallResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join(" ")
    .trim();
}

/** 注册表条目：一个 MCP server 的启动配置 */
export interface MCPServerConfig {
  /** server 注册名，如 weather / sango */
  name: string;
  /** MCP server 入口脚本绝对路径（启动命令为 node <scriptPath>） */
  scriptPath: string;
  /** 必需性：required 连接失败 → 整体启动失败；optional 失败 → 该 server 不可用，其余照常 */
  required: boolean;
}

export const WEATHER_SERVER_NAME = "weather";
export const SANGO_SERVER_NAME = "sango";
/** 风云三国 server 注册名（A005：题库域下沉 mcp-server 独立 MCP） */
export const FENGYUNSANGUO_SERVER_NAME = "fengyunsanguo";

/** fengyunsanguo server 的 MCP 工具名 */
export const FENGYUNSANGUO_QUERY_TOOL = "fengyunsanguo_query";
export const FENGYUNSANGUO_QUIZ_COMMAND_TOOL = "fengyunsanguo_quiz_command";
export const FENGYUNSANGUO_QUIZ_ROUTE_TOOL = "fengyunsanguo_quiz_route";

/** 单个 MCP server 的连接抽象：默认为 SDK Client + stdio 子进程，测试可注入假实现 */
export interface MCPServerConnection {
  connect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface MCPServerConnectionFactory {
  create(config: MCPServerConfig): MCPServerConnection;
}

/** 默认连接：node <scriptPath> stdio 子进程 + 独立 MCP Client */
export class StdioMCPServerConnection implements MCPServerConnection {
  private client: Client;
  private transport: StdioClientTransport;

  constructor(config: MCPServerConfig) {
    this.transport = new StdioClientTransport({
      command: "node",
      args: [config.scriptPath],
    });
    this.client = new Client(
      { name: "mcp-orchestrator", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const response = await this.client.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );
    return response.tools.map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? {},
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>
  ): Promise<ToolCallResult> {
    // feat-A009：转发 tools/call 前统一注入 _meta（当前请求上下文 traceId 存在时；其余工具忽略该键）
    const params: Record<string, unknown> = { name, arguments: args };
    if (meta && Object.keys(meta).length > 0) {
      params._meta = meta;
    }
    const result = await this.client.request(
      {
        method: "tools/call",
        params,
      },
      CallToolResultSchema
    );
    return result as unknown as ToolCallResult;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

/**
 * 从环境变量解析注册表配置（weather 必需、sango 与 fengyunsanguo 可缺配）：
 * - MCP_WEATHER_SCRIPT：weather 入口绝对路径（必填；缺配 → 启动层报错退出）。
 * - MCP_SANGO_SCRIPT：sango 入口绝对路径（可选）；缺配 → sango 不可用。
 * - MCP_FENGYUNSANGUO_SCRIPT：fengyunsanguo 入口绝对路径（可选）；缺配 → fengyunsanguo 不可用。
 * 注册表只认 MCP_*_SCRIPT 环境变量；不再支持命令行参数 / 旧 MCP_SERVER_SCRIPT。
 */
export function resolveMCPServerConfigs(
  env: Record<string, string | undefined>
): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];
  const weatherScript = env.MCP_WEATHER_SCRIPT;
  if (weatherScript) {
    configs.push({
      name: WEATHER_SERVER_NAME,
      scriptPath: weatherScript,
      required: true,
    });
  }
  const sangoScript = env.MCP_SANGO_SCRIPT;
  if (sangoScript) {
    configs.push({
      name: SANGO_SERVER_NAME,
      scriptPath: sangoScript,
      required: false,
    });
  }
  const fengyunsanguoScript = env.MCP_FENGYUNSANGUO_SCRIPT;
  if (fengyunsanguoScript) {
    configs.push({
      name: FENGYUNSANGUO_SERVER_NAME,
      scriptPath: fengyunsanguoScript,
      required: false,
    });
  }
  return configs;
}

/**
 * 多 server 注册表：同时管理多个 stdio MCP 子进程（各自独立 Client、独立启动 / 独立失败）。
 * 构造兼容旧签名：传单个脚本路径 = 只注册一个必需 server（测试 / 单 server 场景用）。
 */
export class MCPTransport {
  private configs: MCPServerConfig[];
  private factory: MCPServerConnectionFactory;
  private servers: Map<string, MCPServerConnection> = new Map();
  private toolToServer: Map<string, string> = new Map();
  /** feat-A009：工具明细 / 检索诊断落库的存储实例；未注入时回退进程级共享 store */
  private logStore: LogStore;

  constructor(
    config: MCPServerConfig[] | string,
    factory?: MCPServerConnectionFactory,
    /** feat-A009：测试可注入 :memory: store；缺省用进程级共享 store（getLogStore） */
    logStore?: LogStore
  ) {
    this.logStore = logStore ?? getLogStore();
    this.configs =
      typeof config === "string"
        ? [{ name: WEATHER_SERVER_NAME, scriptPath: config, required: true }]
        : config;
    this.factory =
      factory ?? { create: (cfg) => new StdioMCPServerConnection(cfg) };
  }

  /** 逐个拉起子进程；required 失败 → 整体失败；optional 失败 → 该 server 移出注册表，其余照常 */
  async connect(): Promise<void> {
    for (const config of this.configs) {
      try {
        const connection = this.factory.create(config);
        await connection.connect();
        this.servers.set(config.name, connection);
      } catch (error) {
        if (config.required) {
          throw error;
        }
        console.warn(
          `[MCPTransport] 可选 server「${config.name}」启动失败，该 server 不可用：`,
          error
        );
      }
    }
    if (this.servers.size === 0) {
      throw new Error("No MCP servers connected");
    }
  }

  /** 合并各 server 工具；同时重建工具名 → server 归属表 */
  async listTools(): Promise<MCPToolDefinition[]> {
    if (this.servers.size === 0) {
      throw new Error("No MCP servers connected");
    }
    const merged: MCPToolDefinition[] = [];
    this.toolToServer.clear();
    for (const [serverName, connection] of this.servers) {
      const tools = await connection.listTools();
      for (const tool of tools) {
        this.toolToServer.set(tool.name, serverName);
        merged.push(tool);
      }
    }
    return merged;
  }

  /** 按工具名路由到归属 server 转发；未知工具名报错（agent 包装为 ToolExecutionError → 503） */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const serverName = await this.resolveServerForTool(name);
    const connection = this.servers.get(serverName);
    if (!connection) {
      throw new Error(`Unknown MCP tool: ${name}`);
    }
    // feat-A007 工具明细：发出 = MCP 收到（只记一次）；仅请求上下文（getTraceId 非空）时记录
    // feat-A009：上下文就位时统一向 tools/call 注入 _meta.traceId（全部工具一致；协议允许未知 _meta 键）
    const traceId = getTraceId();
    const activeTraceId =
      typeof traceId === "string" && traceId !== "" ? traceId : null;
    const meta = activeTraceId ? { traceId: activeTraceId } : undefined;
    const callSentAt = Date.now();
    const argsSummary = activeTraceId ? summarizeJson(args) : "";
    try {
      const result = await connection.callTool(name, args, meta);
      if (activeTraceId) {
        try {
          const toolFailed = (result as { isError?: boolean }).isError === true;
          // 落 result_summary 前剥离 _meta.diagnostics（硬约束 2：诊断单独落库，不挤占 8000 预算）
          const seq = this.logStore.appendToolCall(activeTraceId, {
            mcpServer: serverName,
            toolName: name,
            argsSummary,
            callSentAt,
            callReturnedAt: Date.now(),
            resultSummary: summarizeJson(stripDiagnostics(result)),
            status: toolFailed ? "failed" : "success",
            errorMessage: toolFailed
              ? extractToolError(result) || "MCP 工具返回错误（isError=true）"
              : "",
          });
          // feat-A009：sango 回传诊断时，把工具明细行号透传给 agent（供其收尾回填 injected/cited 后落库）
          if (
            seq !== null &&
            typeof result._meta?.diagnostics === "object" &&
            result._meta.diagnostics !== null
          ) {
            result._meta = { ...result._meta, retrievalSeq: seq };
          }
        } catch {
          // 旁路：埋点失败静默，绝不影响工具调用
        }
      }
      return result;
    } catch (error) {
      if (activeTraceId) {
        try {
          this.logStore.appendToolCall(activeTraceId, {
            mcpServer: serverName,
            toolName: name,
            argsSummary,
            callSentAt,
            callReturnedAt: Date.now(),
            resultSummary: null,
            status: "failed",
            errorMessage: toErrorMessage(error),
          });
        } catch {
          // 旁路：埋点失败静默，绝不影响工具调用
        }
      }
      throw error;
    }
  }

  /**
   * L3 题库自动路由识别：薄转发 fengyunsanguo server 的 fengyunsanguo_quiz_route。
   * quiz 为可选 server，缺配 / 调用失败 → 返回 null（不命中），保持无 domain 自动路由行为不变，其余功能不受影响。
   */
  async fengyunsanguo_quiz_route(
    text: string
  ): Promise<boolean | null> {
    try {
      const result = await this.callTool(FENGYUNSANGUO_QUIZ_ROUTE_TOOL, { text });
      return this.parseQuizRouteResult(result);
    } catch (error) {
      console.warn(
        "[MCPTransport] fengyunsanguo_quiz_route 识别失败，按未命中处理：",
        error
      );
      return null;
    }
  }

  /**
   * 随机一题状态机整体下沉：薄转发 fengyunsanguo server 的 fengyunsanguo_quiz_command。
   * quiz 为可选 server，缺配 / 调用失败 → ToolExecutionError（server.ts 据此判 503）。
   */
  async fengyunsanguo_quiz_command(
    message: string,
    sessionId?: string
  ): Promise<ToolCallResult> {
    const args: Record<string, unknown> = { message };
    if (sessionId) {
      args.sessionId = sessionId;
    }
    try {
      return await this.callTool(FENGYUNSANGUO_QUIZ_COMMAND_TOOL, args);
    } catch (error) {
      throw new ToolExecutionError(FENGYUNSANGUO_QUIZ_COMMAND_TOOL, { cause: error });
    }
  }

  /** 解析 quiz_route 返回文本：纯 "true"/"false" 或 JSON 布尔 / {"hit": boolean}；无法解析按未命中（null）处理 */
  private parseQuizRouteResult(result: ToolCallResult): boolean | null {
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim();
    if (!text) {
      return null;
    }
    if (text === "true" || text === "false") {
      return text === "true";
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "boolean") {
        return parsed;
      }
      if (parsed && typeof parsed === "object" && "hit" in parsed) {
        return (parsed as { hit: unknown }).hit === true;
      }
    } catch {
      // 非 JSON 返回文本按未命中处理
    }
    return null;
  }

  private async resolveServerForTool(name: string): Promise<string> {
    const known = this.toolToServer.get(name);
    if (known && this.servers.has(known)) {
      return known;
    }
    // 未先 listTools 时懒解析：按各 server 上报的工具名反查归属
    this.toolToServer.clear();
    for (const [serverName, connection] of this.servers) {
      const tools = await connection.listTools();
      for (const tool of tools) {
        this.toolToServer.set(tool.name, serverName);
      }
    }
    const owner = this.toolToServer.get(name);
    if (!owner) {
      throw new Error(`Unknown MCP tool: ${name}`);
    }
    return owner;
  }

  async close(): Promise<void> {
    for (const connection of this.servers.values()) {
      try {
        await connection.close();
      } catch (error) {
        console.warn("[MCPTransport] 关闭 server 失败：", error);
      }
    }
    this.servers.clear();
    this.toolToServer.clear();
  }
}
