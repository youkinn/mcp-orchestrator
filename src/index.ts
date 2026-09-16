import dotenv from 'dotenv';
import {
  MCPTransport,
  resolveMCPServerConfigs,
  WEATHER_SERVER_NAME,
} from './transport.js';
import { Agent, UNIFIED_SYSTEM_PROMPT } from './agent.js';
import { SangoService } from './sango.js';
import { createServer } from './server.js';
import type { LLMProvider, MCPToolDefinition } from './types.js';

dotenv.config();

const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.WEB_ORIGIN || 'http://localhost:8001';

// 本地题库工具：走 agent localTools，不经 MCP；描述限定适用域，供模型自主路由
const SANGO_QUERY_TOOL: MCPToolDefinition = {
  name: 'sango_query',
  description:
    '风云三国题库检索：仅当用户询问风云三国游戏内招募武将问答题时调用；参数 text 传用户原始问法，返回候选题目（题干 → 答案）',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
};

// 多 server 注册表：weather 必需（MCP_WEATHER_SCRIPT 必填），sango 可缺配（MCP_SANGO_SCRIPT）
const mcpServerConfigs = resolveMCPServerConfigs(process.env);
if (!mcpServerConfigs.some((config) => config.name === WEATHER_SERVER_NAME)) {
  console.error(
    'Missing MCP weather server path. Set MCP_WEATHER_SCRIPT in .env (sango optional via MCP_SANGO_SCRIPT), then run npm run dev.'
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
  const transport = new MCPTransport(mcpServerConfigs);
  await transport.connect();

  const llmConfig = readLLMConfig();
  const sangoService = new SangoService();

  // 统一 Agent：工具集 = MCP 工具（合并 weather + sango）+ 本地题库工具；调不调、调哪个由模型按语义自主决定
  const mcpTools = await transport.listTools();
  const agent = new Agent(transport, llmConfig, {
    systemPrompt: UNIFIED_SYSTEM_PROMPT,
    tools: [...mcpTools, SANGO_QUERY_TOOL],
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
    // L3：无 domain 且 L2 未命中时，先做题库向量高置信识别，命中直接走 sango 快路径
    sangoVectorMatcher: (query) =>
      Promise.resolve(sangoService.isHighConfidenceSangoQuery(query)),
  });

  const app = createServer(agent, sangoService, { port, allowedOrigin });

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
