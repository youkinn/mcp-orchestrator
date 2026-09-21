export type LLMProvider = "anthropic" | "deepseek" | "openai";

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  apiBaseUrl: string;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  /**
   * feat-A009：MCP 响应的可选附加元数据。
   * - `diagnostics`：sango 检索工具经 result._meta.diagnostics 回传的结构化诊断（对象 | undefined）。
   * - `retrievalSeq`：总台注入的工具明细行号（tool_call_logs.seq，供 agent 收尾回填 injected/cited 后落
   *   tool_retrieval_logs）；仅在带诊断且 trace 上下文就位时注入。
   */
  _meta?: {
    diagnostics?: unknown;
    retrievalSeq?: number;
    [key: string]: unknown;
  };
}

export interface ModelResponse {
  content: Array<{
    type: "text" | "tool_use";
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  reasoningContent?: string | null;
}

/** MCP 工具调用失败：server.ts 据此判定 503（工具服务不可用），与 LLM / 本地工具异常区分 */
export class ToolExecutionError extends Error {
  readonly toolName: string;

  constructor(
    toolName: string,
    options?: { message?: string; cause?: unknown }
  ) {
    super(options?.message ?? `工具 ${toolName} 调用失败`, {
      cause: options?.cause,
    });
    this.name = "ToolExecutionError";
    this.toolName = toolName;
  }
}
