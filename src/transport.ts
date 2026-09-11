import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MCPToolDefinition, ToolCallResult } from "./types.js";

export class MCPTransport {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private serverScriptPath: string;

  constructor(serverScriptPath: string) {
    this.serverScriptPath = serverScriptPath;
  }

  async connect(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: "node",
      args: [this.serverScriptPath],
    });
    this.client = new Client(
      { name: "mcp-orchestrator", version: "1.0.0" },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    if (!this.client) {
      throw new Error("Transport not connected");
    }
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
    if (!this.client) {
      throw new Error("Transport not connected");
    }
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
    if (this.transport) {
      await this.transport.close();
    }
  }
}
