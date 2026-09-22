import dotenv from 'dotenv';
import {
  MCPTransport,
  resolveMCPServerConfigs,
  WEATHER_SERVER_NAME,
} from './transport.js';
import { Agent } from './agent.js';
import { createServer } from './server.js';
import type { LLMProvider } from './types.js';

dotenv.config();

const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.WEB_ORIGIN || 'http://localhost:8001';

// 多 server 注册表：weather 必需（MCP_WEATHER_SCRIPT 必填），sango 演义与 fengyunsanguo 可缺配（MCP_SANGO_SCRIPT / MCP_FENGYUNSANGUO_SCRIPT）
const mcpServerConfigs = resolveMCPServerConfigs(process.env);
if (!mcpServerConfigs.some((config) => config.name === WEATHER_SERVER_NAME)) {
  console.error(
    'Missing MCP weather server path. Set MCP_WEATHER_SCRIPT in .env (sango / fengyunsanguo optional via MCP_SANGO_SCRIPT / MCP_FENGYUNSANGUO_SCRIPT), then run npm run dev.'
  );
  process.exit(1);
}

function readLLMConfig() {
  const provider = (
    process.env.LLM_PROVIDER || 'deepseek'
  ).toLowerCase() as LLMProvider;

  const model = process.env.LLM_MODEL || ''
  const apiKey = process.env.API_KEY || '';
  const apiBaseUrl = process.env.API_BASE_URL || '';

  if (!apiKey) {
    throw new Error('Missing API_KEY in .env');
  }

  return { provider, model, apiKey, apiBaseUrl };
}

async function shutdown(signal: string, transport: MCPTransport) {
  console.log(`Received ${signal}, shutting down...`);
  await transport.close();
  process.exit(0);
}

async function main() {
  const transport = new MCPTransport(mcpServerConfigs);
  await transport.connect();

  const llmConfig = readLLMConfig();

  // 统一 Agent：工具集全部来自 MCP server（weather / sango 演义 / fengyunsanguo），总台无本地工具
  const mcpTools = await transport.listTools();
  const agent = new Agent(transport, llmConfig, {
    tools: mcpTools,
    // L3：无 domain 且 L2 未命中时，先调 fengyunsanguo server 做题库高置信识别（可选 server，缺配/失败不命中）
    fengyunsanguoVectorMatcher: (query) => transport.fengyunsanguo_quiz_route(query),
  });

  const app = createServer(agent, transport, { port, allowedOrigin });

  const server = app.listen(port, () => {
    console.log(`mcp-orchestrator Web API running at http://localhost:${port}`);
  });

  process.once('SIGINT', () => void shutdown('SIGINT', transport));
  process.once('SIGTERM', () => void shutdown('SIGTERM', transport));
  server.on('error', (error: Error) => {
    console.error('Web server failed to start:', error);
    void transport.close().finally(() => process.exit(1));
  });
}

main().catch(async (error) => {
  console.error('Web API failed to start:', error);
  process.exit(1);
});
