# mcp-orchestrator — 项目规范

> 团队级规则（编号 / Commit / 分支 / 交付 / 审查）见 `dev-docs/AGENTS.md`，本文件只列本项目特有约束。

## 架构

```
src/
├── types.ts       共享类型定义
├── transport.ts   MCP 协议层（connect / listTools / callTool / close）
├── agent.ts       LLM 编排（callModel / processQuery）
├── server.ts      Express HTTP 层（路由、校验、队列）
├── index.ts       Web 服务入口
├── cli.ts         CLI 入口
└── test/          测试，按特性号分目录（如 test/feat-A002/）
```

- 依赖方向：`index/cli → server → agent → transport`，无循环。
- 对外：Web 服务由 mcp-web 调用；mcp-server 作为 MCP 子进程由 transport 启动。

## 分工

- 小胡：`agent.ts`（LLM 调用、tool-use 循环、prompt 处理）。
- 老陈：`transport.ts`、`server.ts`、`index.ts`、`cli.ts`、`types.ts`（MCP 连接、HTTP 层、生命周期）。

## 规范

- TypeScript 严格模式；模块间禁止循环依赖。
- LLM 配置在启动时从环境变量读取，不写在 agent 逻辑内部。
- Agent 通过接口依赖 transport，不依赖具体实现类。
- 测试放 `src/test/{特性号}/`，与被测模块分目录。
- 所有 HTTP 响应使用 `{ code, data, message }` 信封，详见 `dev-docs/mcp-orchestrator/api/response-convention.md`；不遵循即打回。

## 脚本

- `npm run build` — TypeScript 编译（`tsc`）。
- `npm run dev` — 启动 Web 服务（先 `npm run build` 再 `node build/index.js`）。
- `npm start` — CLI 模式（`node build/cli.js`）。
- 测试：先 `npm run build`，再 `node --test "build/test/{特性号}/*.test.js"`。
