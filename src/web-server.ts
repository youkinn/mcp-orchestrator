import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import MCPClient from "./client.js";

dotenv.config();

const port = Number(process.env.PORT || 3000);
const serverScriptPath = process.argv[2] || process.env.MCP_SERVER_SCRIPT;
const allowedOrigin = process.env.WEB_ORIGIN || "http://localhost:8001";

if (!serverScriptPath) {
  console.error(
    "缺少 MCP Server 路径。请使用 npm run web -- <server.js 路径>，或配置 MCP_SERVER_SCRIPT。"
  );
  process.exit(1);
}

const resolvedServerScriptPath = serverScriptPath;

const app = express();
const mcpClient = new MCPClient();
let requestQueue = Promise.resolve();

app.use(cors({ origin: allowedOrigin }));
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok", service: "mcp-client" });
});

app.get("/api/tools", async (_request: Request, response: Response) => {
  try {
    response.json({ tools: await mcpClient.listTools() });
  } catch (error) {
    console.error("获取 MCP 工具列表失败：", error);
    response.status(503).json({ message: "MCP Server 尚未连接" });
  }
});

app.post("/api/chat", async (request: Request, response: Response) => {
  const message = request.body?.message;

  if (typeof message !== "string" || !message.trim()) {
    response.status(400).json({ message: "message 必须是非空字符串" });
    return;
  }

  if (message.length > 4000) {
    response.status(413).json({ message: "message 不能超过 4000 个字符" });
    return;
  }

  try {
    const result = requestQueue.then(() => mcpClient.processQuery(message.trim()));
    requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    response.json({ answer: await result });
  } catch (error) {
    console.error("处理聊天请求失败：", error);
    response.status(500).json({ message: "处理请求失败，请稍后重试" });
  }
});

async function shutdown(signal: string) {
  console.log(`收到 ${signal}，正在关闭服务...`);
  await mcpClient.cleanup();
  process.exit(0);
}

async function main() {
  await mcpClient.connectToServer(resolvedServerScriptPath);
  const server = app.listen(port, () => {
    console.log(`mcp-client Web API running at http://localhost:${port}`);
  });

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  server.on("error", (error: Error) => {
    console.error("Web 服务启动失败：", error);
    void mcpClient.cleanup().finally(() => process.exit(1));
  });
}

main().catch(async (error) => {
  console.error("Web API 启动失败：", error);
  await mcpClient.cleanup();
  process.exit(1);
});
