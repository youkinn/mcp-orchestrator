import dotenv from "dotenv";
import { MCPTransport } from "./transport.js";
import { Agent } from "./agent.js";
import { createServer } from "./server.js";
import type { LLMProvider } from "./types.js";

dotenv.config();

const port = Number(process.env.PORT || 3000);
const serverScriptPath = process.argv[2] || process.env.MCP_SERVER_SCRIPT;
const allowedOrigin = process.env.WEB_ORIGIN || "http://localhost:8001";

if (!serverScriptPath) {
  console.error(
    "Missing MCP Server path. Use npm run web -- <server.js path> or set MCP_SERVER_SCRIPT."
  );
  process.exit(1);
}

function readLLMConfig() {
  const provider = (
    process.env.LLM_PROVIDER || "deepseek"
  ).toLowerCase() as LLMProvider;

  if (!["anthropic", "deepseek", "openai"].includes(provider)) {
    throw new Error("LLM_PROVIDER must be anthropic / deepseek / openai");
  }

  const model =
    process.env.LLM_MODEL ||
    (provider === "anthropic"
      ? "claude-3-5-sonnet-20241022"
      : provider === "openai"
        ? "gpt-4o-mini"
        : "deepseek-v4-flash");

  const apiKey = process.env.API_KEY;
  const apiBaseUrl =
    process.env.API_BASE_URL ||
    (provider === "anthropic"
      ? "https://api.anthropic.com"
      : provider === "openai"
        ? "https://api.openai.com/v1"
        : "https://api.deepseek.com");

  if (!apiKey) {
    throw new Error("Missing API_KEY in .env");
  }

  return { provider, model, apiKey, apiBaseUrl };
}

async function shutdown(
  signal: string,
  transport: MCPTransport
) {
  console.log(`Received ${signal}, shutting down...`);
  await transport.close();
  process.exit(0);
}

async function main() {
  const transport = new MCPTransport(serverScriptPath!);
  await transport.connect();

  const llmConfig = readLLMConfig();
  const agent = new Agent(transport, llmConfig);

  const app = createServer(agent, { port, allowedOrigin });

  const server = app.listen(port, () => {
    console.log(`mcp-orchestrator Web API running at http://localhost:${port}`);
  });

  process.once("SIGINT", () => void shutdown("SIGINT", transport));
  process.once("SIGTERM", () => void shutdown("SIGTERM", transport));
  server.on("error", (error: Error) => {
    console.error("Web server failed to start:", error);
    void transport.close().finally(() => process.exit(1));
  });
}

main().catch(async (error) => {
  console.error("Web API failed to start:", error);
  process.exit(1);
});

