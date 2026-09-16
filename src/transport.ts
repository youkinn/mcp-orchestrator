import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MCPToolDefinition, ToolCallResult } from "./types.js";

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

/** 单个 MCP server 的连接抽象：默认为 SDK Client + stdio 子进程，测试可注入假实现 */
export interface MCPServerConnection {
  connect(): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
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
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const result = await this.client.request(
      {
        method: "tools/call",
        params: { name, arguments: args },
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
 * 从环境变量解析注册表配置（weather 必需、sango 可缺配）：
 * - MCP_WEATHER_SCRIPT：weather 入口绝对路径；兼容旧配置 MCP_SERVER_SCRIPT / CLI 第 2 参兜底。
 * - MCP_SANGO_SCRIPT：sango 入口绝对路径（可选）；缺配 → sango 不可用。
 */
export function resolveMCPServerConfigs(
  env: Record<string, string | undefined>,
  argv: string[] = []
): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];
  const weatherScript =
    env.MCP_WEATHER_SCRIPT || env.MCP_SERVER_SCRIPT || argv[2];
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
  return configs;
}

/**
 * 多 server 注册表：同时管理多个 stdio MCP 子进程（各自独立 Client、独立启动 / 独立失败）。
 * 构造兼容旧签名：传单个脚本路径 = 只注册一个必需 server。
 */
export class MCPTransport {
  private configs: MCPServerConfig[];
  private factory: MCPServerConnectionFactory;
  private servers: Map<string, MCPServerConnection> = new Map();
  private toolToServer: Map<string, string> = new Map();

  constructor(
    config: MCPServerConfig[] | string,
    factory?: MCPServerConnectionFactory
  ) {
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
    return connection.callTool(name, args);
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
