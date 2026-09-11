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
