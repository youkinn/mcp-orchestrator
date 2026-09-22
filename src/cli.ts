import dotenv from "dotenv";
import * as readline from "node:readline";
import { MCPTransport, resolveMCPServerConfigs } from "./transport.js";
import { Agent } from "./agent.js";
import type { LLMProvider } from "./types.js";

dotenv.config();

const mcpServerConfigs = resolveMCPServerConfigs(process.env);

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
