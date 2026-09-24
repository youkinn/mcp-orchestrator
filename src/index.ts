import dotenv from 'dotenv';
import { MCPTransport, resolveMCPServerConfigs } from './transport.js';
import { Agent } from './agent.js';
import { createServer } from './server.js';
import { CacheManager } from './cache.js';
import { getLogStore } from './storage/logs.js';
import type { LLMProvider } from './types.js';

dotenv.config();

const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.WEB_ORIGIN || 'http://localhost:8001';

// 多 server 注册表：sango 演义与 fengyunsanguo 可缺配（MCP_SANGO_SCRIPT / MCP_FENGYUNSANGUO_SCRIPT）；
// 天气能力已下线（feat-A011），残留 MCP_WEATHER_SCRIPT 直接忽略不报错。
const mcpServerConfigs = resolveMCPServerConfigs(process.env);

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

  // feat-A013：语义缓存池实例（story-A013-03 总台装配）。
  // 构造参数按 CacheManagerOptions 接口事实（src/cache.ts）：transport=callInternal 通道（§1.7.2 三不原则）、
  // logStore=进程级共享存储（cache_logs / cache_entries 同步直写）；enabled / hitLine / maxEntries 走构造缺省
  // env 解析——CACHE_ENABLED（缺省开）/ CACHE_HIT_LINE（缺省 0.92）/ CACHE_MAX_ENTRIES（缺省 500），
  // 语义即任务口径，不在此复制解析逻辑（双份解析有漂移风险）。构造会同步清一次 cache_entries 镜像（§2.3，启动即做）。
  const cacheManager = new CacheManager({
    transport,
    logStore: getLogStore(),
  });

  // 统一 Agent：工具集全部来自 MCP server（sango 演义 / fengyunsanguo），总台无本地工具
  const mcpTools = await transport.listTools();
  const agent = new Agent(transport, llmConfig, {
    tools: mcpTools,
    // L3：无 domain 且 L2 未命中时，先调 fengyunsanguo server 做题库高置信识别（可选 server，缺配/失败不命中）
    // bug-00019：L3 预检由服务端发起，显式标注调用方 + 发起阶段（落工具调用明细）
    fengyunsanguoVectorMatcher: (query) => transport.fengyunsanguo_quiz_route(query, { caller: 'server', stage: 'l3' }),
    // feat-A013：agent 侧判定 / 写缓存入口（processQueryData 内 lookup / record）
    cacheManager,
  });

  const app = createServer(agent, transport, { port, allowedOrigin, cacheManager });

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
