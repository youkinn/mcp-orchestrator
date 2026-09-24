# mcp-orchestrator — 项目规范

> 团队级规则（编号 / Commit / 分支 / 交付 / 审查）见 `D:\workplace\dev-docs\AGENTS.md`（含需求 / Bug / 排查对接文档索引），本文件只列本项目特有约束。

## 架构

```
src/
├── types.ts       共享类型定义
├── trace.ts       traceId 上下文（runWithTraceId / getTraceId）
├── transport.ts   MCP 协议层（connect / listTools / callTool / close）
├── agent.ts       LLM 编排（主入口 processQueryData）
├── citation.ts    引用校验与兜底（注入视图 / verify / fallback）
├── recallDiagnostics.ts  召回诊断（检索元信息、picked 下标、落库）
├── cache.ts      语义缓存（feat-A013：CacheManager 命中判定 / LRU / 写缓存，编排侧）
├── server.ts      Express HTTP 层（路由、校验、队列、埋点）
├── api/v1/        日志查询接口（logs.ts / sango.ts / cache.ts）
├── storage/logs.ts  SQLite 日志落库与查询
├── index.ts       Web 服务入口
├── cli.ts         CLI 入口
└── test/          测试，按特性号分目录（如 test/feat-A002/）
```

- 依赖方向：`index/cli → server → agent → transport`；`agent → citation / recallDiagnostics`；`server → api/v1 → storage/logs`，无循环。
- 对外：Web 服务由 mcp-web 调用；mcp-server 作为 MCP 子进程由 transport 启动。

## 分工

- 小胡：`agent.ts`（LLM 调用、路由分类、prompt 组织，主入口 `processQueryData`）、`citation.ts`、`recallDiagnostics.ts`（领域逻辑）。
- 老陈：`transport.ts`、`server.ts`、`index.ts`、`cli.ts`、`types.ts`、`trace.ts`、`api/v1/`、`storage/logs.ts`（MCP 连接、HTTP 层、日志落库与查询、生命周期）。

## 规范

- TypeScript 严格模式；模块间禁止循环依赖。
- LLM 配置在启动时从环境变量读取，不写在 agent 逻辑内部。
- Agent 通过接口依赖 transport，不依赖具体实现类。
- 测试放 `src/test/{特性号}/`，与被测模块分目录。
- 所有 HTTP 响应使用 `{ code, data, message }` 信封，详见 `D:\workplace\dev-docs\mcp-orchestrator\api\response-convention.md`；不遵循即打回。

## 脚本

- `npm run build` — TypeScript 编译（`tsc`）。
- `npm run dev` — 启动 Web 服务（先 `npm run build` 再 `node build/index.js`）。
- `npm start` — CLI 模式（`node build/cli.js`）。
- 测试：先 `npm run build`，再 `node --test "build/test/{特性号}/*.test.js"`。
