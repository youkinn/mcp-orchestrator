# MCP Orchestrator

连接 LLM 与 MCP Server 的编排层。接收自然语言查询，由 LLM 决定调用哪些 MCP 工具，通过 stdio 协议执行工具调用并返回最终结果。

```
mcp-web → mcp-orchestrator (Web API) → MCP stdio → mcp-server
```

## 架构

```
src/
├── types.ts      共享类型定义
├── transport.ts  MCP 协议层（连接、列工具、调工具、关闭）
├── agent.ts      AI 编排层（LLM 调用、tool-use 循环）
├── server.ts     Express HTTP 层（路由、校验、请求队列）
├── index.ts      Web 服务入口
└── cli.ts        CLI 交互入口
```

## 安装

```bash
npm install
npm run build
```

## 配置

根目录 `.env`：

```env
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash
API_KEY=your_api_key
API_BASE_URL=https://api.deepseek.com
```

支持的 provider：`anthropic` / `deepseek` / `openai`。

## 运行

**Web API 模式：**

```bash
npm run web -- D:\workplace\mcp-server\src\weather\index.js
```

默认监听 `http://localhost:3000`。

接口：
- `GET /health` — 健康检查
- `GET /api/tools` — 列出可用 MCP 工具
- `POST /api/chat` — 发送聊天消息（`{ "message": "..." }`）

**CLI 交互模式：**

```bash
npm start -- D:\workplace\mcp-server\src\weather\index.js
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_PROVIDER` | 模型提供商 | `deepseek` |
| `LLM_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `API_KEY` | API 密钥 | 必填 |
| `API_BASE_URL` | API 基础地址 | 按 provider 自动选 |
| `PORT` | Web 服务端口 | `3000` |
| `WEB_ORIGIN` | CORS 允许来源 | `http://localhost:8001` |
| `MCP_SERVER_SCRIPT` | MCP Server 脚本路径 | 也可通过命令行传入 |
