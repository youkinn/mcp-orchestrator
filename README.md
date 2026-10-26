# mcp-orchestrator

天枢项目群的编排层（别名：总台）。接收 `mcp-web` 的 HTTP 请求，由 LLM 完成域路由与回答生成，通过 MCP stdio 调用 `mcp-server` 的工具。

```text
mcp-web → mcp-orchestrator :3000 → MCP stdio → mcp-server
```

## 目录结构

```text
src/
├── agent.ts              LLM 编排、域路由、tool-use 循环
├── transport.ts          MCP 连接、工具注册与路由
├── citation.ts           引用校验与兜底
├── recallDiagnostics.ts  召回诊断
├── cache.ts              语义缓存
├── server.ts             Express 路由、校验、队列、埋点
├── api/v1/               日志、草稿台、缓存、原文接口
├── storage/              SQLite 日志落库与查询
├── index.ts              Web 服务入口
└── cli.ts                CLI 入口
```

## 运行

```bash
npm install
npm run dev    # 构建并启动 Web 服务，默认 :3000
npm start      # CLI 交互模式
```

## 扩展

### 新增一个 MCP server（通用流程）

接入新的 MCP（如「水浒传」）时，按以下步骤操作：

1. 在 `mcp-server/` 下新建独立目录，实现 stdio MCP server 并注册工具；新增 MCP 使用 TypeScript。
2. 构建入口：`npm --prefix <目录> run build`，确认产物位于 `dist/index.js`。
3. 在 orchestrator 根目录 `.env` 增加 `MCP_<名称大写>_SCRIPT=<入口绝对路径>`。
4. 在 `src/transport.ts` 的 `resolveMCPServerConfigs` 中读取该环境变量并加入注册表（`name` 与 server 内部注册名一致，按需设置 `required`）。
5. 启动 `npm run dev`，用 `GET /api/tools` 确认新工具已合并上报。
6. 按需在 `mcp-web` 增加前端入口，并在接口文档登记新的 `domain` 白名单。
7. 跑全量测试：`npm run build && node --test "build/test/*/*.test.js"`。

要点：

- 当前 `MCP_SANGO_SCRIPT`、`MCP_FENGYUNSANGUO_SCRIPT` 均为可选（`required: false`）；天气配置 `MCP_WEATHER_SCRIPT` 已下线并被忽略。
- 每个 MCP 是独立 stdio 子进程；`required: true` 连接失败会导致整体启动失败，`required: false` 只影响该 server。
- 工具名到 server 的归属由 `MCPTransport.toolToServer` 自动路由，调用方无需指定 server。

## 测试

```bash
npm run build
node --test "build/test/*/*.test.js"
```
