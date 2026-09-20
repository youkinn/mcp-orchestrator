# MCP Orchestrator

连接 LLM 与 MCP Server 的编排层。接收自然语言查询，由 LLM 决定调用哪些 MCP 工具，通过 stdio 协议执行工具调用并返回最终结果。

```
mcp-web → mcp-orchestrator (Web API) → MCP stdio → mcp-server
```

## 能力与原则

总台只做编排，不承载任何领域代码（`src/` 无领域业务；领域逻辑全部在 mcp-server 的各 MCP 子进程）。当前接入三类能力，互不影响、可独立失败：

| 域 | 说明 |
|------|------|
| `weather` | 天气 MCP 工具（get-forecast / get-alerts） |
| `fengyunsanguo` | 风云三国知识问答 + 随机一题（会话状态在子进程，30 分钟过期） |
| `sango-novel` | 三国演义原著检索（快路径 + 引用校验 + 服务端渲染） |

### 三国演义原著检索（domain=sango-novel）

- **定位**：面向需要原文依据的问题（如「诸葛亮与诸葛均是什么关系」）。只取原文、不评价、不编造；原文没有的，模型明确拒答（「演义中未涉及」），不允许用先验补全
- **工具归属**：检索工具 `sango_novel_search` 由 mcp-server 提供，出参为结构化条目数组（含 `quotes[]` 引语表与回级 `chapter` / `title`），总台负责：快路径预检索 → 注入视图拼接（top5 整段保底 + 第 6–10 段预算兜底）→ 单次 LLM 生成 → 引用硬校验（人名校验 + 指针校验 + 长引语安全网）→ 服务端渲染引用与出处 → 兜底
- **展示**：引用原文与出处由总台从字段渲染、不展示段号；feat-A006 起响应结构化（`answer` 结论 + `citations` 引用卡片数组），weather / fengyunsanguo 响应不变
- **演进**：阶段二 三国志（多书对照，`sanguozhi` 预留）→ 阶段三 后汉书
- **已知边界**：开放式归纳（如「有哪些单挑名场面」，答案分散全书）暂不支持；引用与结论的相关性质量问题见 bug-00005

## 架构

```
src/
├── types.ts      共享类型定义
├── transport.ts  MCP 协议层（多 server 注册表：连接、列工具、按工具名路由、关闭）
├── agent.ts      AI 编排层（LLM 调用、tool-use 循环）
├── server.ts     Express HTTP 层（路由、校验、请求队列）
├── index.ts      Web 服务入口
├── cli.ts        CLI 交互入口
└── test/         特性测试（按特性号分目录）
```

## 安装

```bash
npm install
npm run build
```

## 测试

测试代码按特性号放在 `src/test/<特性号>/`，编译后位于 `build/test/<特性号>/`：

```bash
npm run build
node --test "build/test/feat-A002/*.test.js"
```

## 配置

MCP server 清单通过根目录 `.env` 的**注册表环境变量**声明（weather 必需；sango 演义与 fengyunsanguo 可缺配）：

```env
MCP_WEATHER_SCRIPT=D:\workplace\mcp-server\weather\src\index.js
MCP_SANGO_SCRIPT=D:\workplace\mcp-server\sango\dist\index.js
MCP_FENGYUNSANGUO_SCRIPT=D:\workplace\mcp-server\fengyunsanguo\dist\index.js
```

LLM 配置同文件：

```env
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash
API_KEY=your_api_key
API_BASE_URL=https://api.deepseek.com
```

支持的 provider：`anthropic` / `deepseek` / `openai`。## 运行

**Web API 模式（总台，默认）：**

```bash
npm run dev
```

`npm run dev` 会先 `npm run build` 再启动 Web 服务，监听 `http://localhost:3000`，**无需任何参数**（MCP 清单全部来自 `.env` 注册表，不通过命令行传脚本路径）。

接口：
- `GET /health` — 健康检查
- `GET /api/tools` — 列出可用 MCP 工具（合并所有已注册 server 的工具）
- `POST /api/chat` — 发送聊天消息，`domain` 可选：`weather` / `fengyunsanguo` / `sango-novel`（缺省自动路由）

**CLI 交互模式：**

```bash
npm start
```

### 域分发（domain 路由）

`POST /api/chat` 请求体支持 `message` + `domain`（可选）；`domain` 命中即锁定该域（L1 标签判定），缺省时按 L2 关键词 / L3 向量 / LLM 兜底自动路由（见 `docs/sango-mcp-routing-design.md`）。

| domain | 说明 |
|--------|------|
| `weather` | 天气 MCP 工具（get-forecast / get-alerts） |
| `fengyunsanguo` | 风云三国知识问答：LLM 理解问法，答案经 MCP 工具 `fengyunsanguo_query` 从题库精确取 |
| `sango-novel` | 三国演义原著检索（`sango_novel_search`，feat-A004） |

- 风云三国随机一题走 `POST /api/sango/random`：薄转发 MCP `fengyunsanguo_quiz_command`，出题 / 判题 / 查答案状态机在 fengyunsanguo 子进程；`sessionId` 语义不变，会话 30 分钟过期
- 题库在 `mcp-server/fengyunsanguo/data/fengyunsanguo-questions.json`；quiz 子进程缺配 / 不可用 → 随机一题与 `domain=fengyunsanguo` 知识问答返回 503，其余功能正常

### 新增一个 MCP server（通用流程）
以后要接第 3 个 MCP（如「水浒传」），**不需要改 orchestrator 任何代码**：

1. 在 `mcp-server/` 下新建独立项目目录（如 `shuihu/`），实现 MCP stdio server，注册自己的工具（新增 MCP 一律 TypeScript 打底）。
2. 构建产物就位：TS 项目先 `npm run build`；纯 JS 直接用源码入口。
3. orchestrator 根目录 `.env` 增加一行注册表变量，格式 `MCP_<名称大写>_SCRIPT=<入口绝对路径>`（`<名称>` 与 server 内部注册名一致）。
4. 启动 `npm run dev`，用 `GET /api/tools` 确认新工具已合并上报。
5. 按需在 `mcp-web` 加前端入口（如新增 `domain` 取值 / 标签），并在对应接口文档登记 `domain` 白名单。
6. 改完跑全量测试：`npm run build && node --test "build/test/*/*.test.js"`。

要点：
- 每个 MCP 是独立 stdio 子进程，独立启动、独立失败；`required: true` 的 server 连不上 → 整体启动失败，`required: false` 的 server 连不上 → 仅该 server 不可用。
- 工具名 → server 归属由 orchestrator 自动路由（`MCPTransport.toolToServer`），模型按语义自主决定调哪个工具，调用方无需指定 server。## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `LLM_PROVIDER` | 模型提供商 | `deepseek` |
| `LLM_MODEL` | 模型名称 | `deepseek-v4-flash` |
| `API_KEY` | API 密钥 | 必填 |
| `API_BASE_URL` | API 基础地址 | 按 provider 自动选 |
| `PORT` | Web 服务端口 | `3000` |
| `WEB_ORIGIN` | CORS 允许来源 | `http://localhost:8001` |
| `MCP_WEATHER_SCRIPT` | weather server 入口脚本绝对路径 | 必填 |
| `MCP_SANGO_SCRIPT` | 三国演义（sango）server 入口脚本绝对路径 | 缺配 → sango 演义不可用 |
| `MCP_FENGYUNSANGUO_SCRIPT` | 风云三国（fengyunsanguo）server 入口脚本绝对路径 | 缺配 → fengyunsanguo 不可用 |
