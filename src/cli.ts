import dotenv from "dotenv";
import * as readline from "node:readline";
import {
  MCPTransport,
  resolveMCPServerConfigs,
  WEATHER_SERVER_NAME,
} from "./transport.js";
import { Agent } from "./agent.js";
import type { LLMProvider } from "./types.js";

dotenv.config();

const mcpServerConfigs = resolveMCPServerConfigs(process.env);
if (!mcpServerConfigs.some((config) => config.name === WEATHER_SERVER_NAME)) {
  console.log(
    "Usage: set MCP_WEATHER_SCRIPT in .env (sango optional via MCP_SANGO_SCRIPT), then run npm start."
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

  const model = process.env.LLM_MODEL || ''
  const apiKey = process.env.API_KEY || '';
  const apiBaseUrl = process.env.API_BASE_URL || '';

  if (!apiKey) {
    throw new Error("Missing API_KEY in .env");
  }

  return { provider, model, apiKey, apiBaseUrl };
}

async function main() {
  const transport = new MCPTransport(mcpServerConfigs);
  await transport.connect();

  const llmConfig = readLLMConfig();
  const agent = new Agent(transport, llmConfig);

  console.log("\nMCP Orchestrator CLI started");
  console.log("Enter your query or type 'quit' to exit.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question("\nQuery: ", async (query: string) => {
      try {
        if (query.toLowerCase() === "quit") {
          await transport.close();
          rl.close();
          return;
        }

        const response = await agent.processQuery(query);
        console.log("\n" + response);
        askQuestion();
      } catch (error) {
        console.error("\nError:", error);
        askQuestion();
      }
    });
  };

  askQuestion();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
