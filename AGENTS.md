# mcp-orchestrator — 项目规范

## 架构（重构后）
```
src/
├── types.ts       共享类型定义
├── transport.ts   MCP 协议层（connect/listTools/callTool/close）
├── agent.ts       LLM 编排（callModel/processQuery）
├── server.ts      Express HTTP 层（路由、校验、队列）
├── index.ts       Web 服务入口
└── cli.ts         CLI 入口
```

依赖方向：`index/cli → server → agent → transport`（无循环）

## 负责人
- **小胡**：agent.ts（LLM 调用、tool-use 循环、prompt 处理）
- **老陈**：transport.ts、server.ts、index.ts、cli.ts（MCP 连接、HTTP 层、生命周期）

## 规范
- TypeScript 严格模式
- 模块之间禁止循环依赖
- LLM 配置在启动时从环境变量读取，不写在 agent 逻辑内部
- Agent 通过接口依赖 transport，不依赖具体实现类

## 脚本
- `npm run build` — TypeScript 编译
- `npm run web` — 启动 Web 服务（`node build/index.js`）
- `npm start` — CLI 模式（`node build/cli.js`）

## 开发流程（以 feat-A001 为例）

### 老陈 — 始终最先开始
1. 阅读 `dev-docs/requirements/feat-A001-xxx.md`
2. 阅读 `dev-docs/mcp-orchestrator/api/response-convention.md`
3. 编写接口文档 → `dev-docs/mcp-orchestrator/api/feat-A001-xxx.md`
4. 编写半页技术方案 → `dev-docs/mcp-orchestrator/design/feat-A001-xxx.md`（后端改动较大时）
5. 实现 server.ts / transport.ts 改动
6. 编写测试（命名清晰，覆盖验收标准）

### 小胡 — 等老陈接口文档就绪后开始
1. 阅读 `dev-docs/requirements/feat-A001-xxx.md`
2. 阅读老陈的接口文档
3. 编写半页技术方案 → `dev-docs/mcp-orchestrator/design/feat-A001-xxx.md`
4. 实现 agent.ts 改动
5. 编写测试（命名清晰，覆盖验收标准）

### 接口响应格式（强制）
所有接口必须使用统一响应信封：
```json
{ "code": 200, "data": { ... }, "message": "" }
```
详见 `dev-docs/mcp-orchestrator/api/response-convention.md`。

不遵循此格式 = Coco 打回。

## 交付清单
- [ ] 代码编译通过（`npm run build`）
- [ ] 老陈：编码前先完成接口文档
- [ ] 技术方案已写（半页，design/feat-A001-xxx.md）
- [ ] 测试代码已写（命名清晰，覆盖验收标准）
- [ ] 接口响应使用 `{ code, data, message }` 信封
- [ ] `dev-docs/` 中文档已同步更新


## Git
- 始终在分支上开发：`feat/feat-A001-name` 或 `fix/bug-00042-name`
- 禁止直接提交到 main
- Commit 格式：`#feat-A001 type: 中文描述`