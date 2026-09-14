import dotenv from 'dotenv';
import { MCPTransport } from './transport.js';
import { Agent, GENERAL_SYSTEM_PROMPT } from './agent.js';
import { SANGO_KNOWLEDGE_SYSTEM_PROMPT, SangoService } from './sango.js';
import { createServer } from './server.js';
import type { LLMProvider, MCPToolDefinition } from './types.js';

dotenv.config();

const port = Number(process.env.PORT || 3000);
const serverScriptPath = process.argv[2] || process.env.MCP_SERVER_SCRIPT;
const allowedOrigin = process.env.WEB_ORIGIN || 'http://localhost:8001';

// 风云三国知识问答：本地题库召回工具（走 agent localTools，不经 MCP）
const SANGO_QUERY_TOOL: MCPToolDefinition = {
  name: 'sango_query',
  description: '风云三国知识问答：按用户原始问法召回候选题目（题干 → 答案）',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
};

if (!serverScriptPath) {
  console.error(
    'Missing MCP Server path. Use npm run web -- <server.js path> or set MCP_SERVER_SCRIPT.'
  );
  process.exit(1);
}

function readLLMConfig() {
  const provider = (
    process.env.LLM_PROVIDER || 'deepseek'
  ).toLowerCase() as LLMProvider;

  if (!['anthropic', 'deepseek', 'openai'].includes(provider)) {
    throw new Error('LLM_PROVIDER must be anthropic / deepseek / openai');
  }

  const model =
    process.env.LLM_MODEL ||
    (provider === 'anthropic'
      ? 'claude-3-5-sonnet-20241022'
      : provider === 'openai'
        ? 'gpt-4o-mini'
        : 'deepseek-v4-flash');

  const apiKey = process.env.API_KEY;
  const apiBaseUrl =
    process.env.API_BASE_URL ||
    (provider === 'anthropic'
      ? 'https://api.anthropic.com'
      : provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.deepseek.com');

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
  const transport = new MCPTransport(serverScriptPath!);
  await transport.connect();

  const llmConfig = readLLMConfig();

  // 各场景独立 Agent：general 无工具；weather 连 MCP 工具；sango 知识问答=本地召回候选+LLM 语义判定
  const generalAgent = new Agent(transport, llmConfig, {
    systemPrompt: GENERAL_SYSTEM_PROMPT,
    tools: [],
  });
  const weatherAgent = new Agent(transport, llmConfig);

  const sangoService = new SangoService();
  const sangoKnowledgeAgent = new Agent(transport, llmConfig, {
    systemPrompt: SANGO_KNOWLEDGE_SYSTEM_PROMPT,
    tools: [SANGO_QUERY_TOOL],
    localTools: {
      sango_query: async (args: Record<string, unknown>) => {
        const text = typeof args.text === 'string' ? args.text : '';
        const hits = sangoService.candidates(text);
        return {
          content: [
            {
              type: 'text',
              text: hits.length
                ? hits
                  .map(
                    (hit, index) =>
                      `${index + 1}. ${hit.question.question} → ${hit.answer}`
                  )
                  .join('\n')
                : '未召回到任何候选题目',
            },
          ],
        };
      },
    },
  });

  const app = createServer(
    {
      general: generalAgent,
      weather: weatherAgent,
      sangoKnowledge: sangoKnowledgeAgent,
    },
    sangoService,
    { port, allowedOrigin }
  );

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
