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
    response.json({ status: "ok", service: "mcp-orchestrator" });
  });

  app.get("/api/tools", async (_request: Request, response: Response) => {
    try {
      response.json({ tools: await agent.listTools() });
    } catch (error) {
      console.error("Failed to list MCP tools:", error);
      response.status(503).json({ message: "MCP Server not connected" });
    }
  });

  app.post("/api/chat", async (request: Request, response: Response) => {
    const message = request.body?.message;

    if (typeof message !== "string" || !message.trim()) {
      response.status(400).json({ message: "message must be a non-empty string" });
      return;
    }

    if (message.length > 4000) {
      response.status(413).json({ message: "message cannot exceed 4000 characters" });
      return;
    }

    try {
      const result = requestQueue.then(() => agent.processQuery(message.trim()));
      requestQueue = result.then(
        () => undefined,
        () => undefined,
      );
      response.json({ answer: await result });
    } catch (error) {
      console.error("Failed to process chat request:", error);
      response.status(500).json({ message: "Failed to process request, please try again" });
    }
  });

  return app;
}

