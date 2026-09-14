import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { Agent } from './agent.js';
import type { SangoService } from './sango.js';

export interface ServerAgents {
  general: Agent;
  weather: Agent;
  sangoKnowledge: Agent;
}

const SCENARIOS = new Set(['general', 'weather', 'sango']);

export function createServer(
  agents: ServerAgents,
  sangoService: SangoService,
  options: { port: number; allowedOrigin: string }
) {
  const app = express();
  let requestQueue = Promise.resolve();

  app.use(cors({ origin: options.allowedOrigin }));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      code: 200,
      data: { status: 'ok', service: 'mcp-orchestrator' },
      message: '',
    });
  });

  app.get('/api/tools', async (_request: Request, response: Response) => {
    try {
      response.json({
        code: 200,
        data: { tools: await agents.weather.listTools() },
        message: '',
      });
    } catch (error) {
      console.error('Failed to list MCP tools:', error);
      response.status(503).json({
        code: 503,
        data: null,
        message: 'MCP Server 未连接',
      });
    }
  });

  app.post('/api/chat', async (request: Request, response: Response) => {
    const body: any = request.body ?? {};
    const message = body.message;

    if (typeof message !== 'string' || !message.trim()) {
      response
        .status(400)
        .json({ code: 400, data: null, message: 'message 不能为空' });
      return;
    }

    if (message.length > 300) {
      response
        .status(413)
        .json({ code: 413, data: null, message: '消息不能超过 300 字符' });
      return;
    }

    const scenario = body.scenario ?? 'general';
    if (typeof scenario !== 'string' || !SCENARIOS.has(scenario)) {
      response
        .status(400)
        .json({ code: 400, data: null, message: 'scenario 不合法' });
      return;
    }
    let handle: () => string | Promise<string>;
    if (scenario === 'general') {
      handle = () => agents.general.processQuery(message.trim());
    } else if (scenario === 'weather') {
      handle = () => agents.weather.processQuery(message.trim());
    } else if (body.service === 'knowledge') {
      handle = () => agents.sangoKnowledge.processQuery(message.trim());
    } else if (body.service === 'random') {
      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId.trim()
          ? body.sessionId.trim()
          : undefined;
      handle = () => sangoService.handleRandom(message.trim(), sessionId);
    } else {
      response
        .status(400)
        .json({ code: 400, data: null, message: 'service 不合法' });
      return;
    }

    try {
      const result = requestQueue.then(() => handle());
      requestQueue = result.then(
        () => undefined,
        () => undefined
      );
      response.json({ code: 200, data: { answer: await result }, message: '' });
    } catch (error) {
      console.error('Failed to process chat request:', error);
      const status = scenario === 'weather' ? 503 : 500;
      response.status(status).json({
        code: status,
        data: null,
        message: status === 503 ? '天气服务暂不可用' : '处理请求失败，请稍后重试',
      });
    }
  });

  return app;
}
