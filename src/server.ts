import cors from "cors";
import express, { type Request, type Response } from "express";
import type { Agent } from "./agent.js";

export function createServer(agent: Agent, options: {
  port: number;
  allowedOrigin: string;
}) {
  const app = express();
  let requestQueue = Promise.resolve();

  app.use(cors({ origin: options.allowedOrigin }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ code: 200, data: { status: "ok", service: "mcp-orchestrator" }, message: "" });
  });

  app.get("/api/tools", async (_request: Request, response: Response) => {
    try {
      response.json({ code: 200, data: { tools: await agent.listTools() }, message: "" });
    } catch (error) {
      console.error("Failed to list MCP tools:", error);
      response.status(503).json({ code: 503, data: null, message: "MCP Server 未连接" });
    }
  });

  app.post("/api/chat", async (request: Request, response: Response) => {
    const message = request.body?.message;

    if (typeof message !== "string" || !message.trim()) {
      response.status(400).json({ code: 400, data: null, message: "message 不能为空" });
      return;
    }

    if (message.length > 300) {
      response.status(413).json({ code: 413, data: null, message: "消息不能超过 300 字符" });
      return;
    }

    try {
      const result = requestQueue.then(() => agent.processQuery(message.trim()));
      requestQueue = result.then(
        () => undefined,
        () => undefined,
      );
      response.json({ code: 200, data: { answer: await result }, message: "" });
    } catch (error) {
      console.error("Failed to process chat request:", error);
      response.status(500).json({ code: 500, data: null, message: "处理请求失败，请稍后重试" });
    }
  });

  return app;
}

