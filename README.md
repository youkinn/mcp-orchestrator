# MCP Client

这是一个 MCP 网关：连接模型服务和 MCP Server，并同时提供控制台交互与 Web API。网页请求应先发送到本项目，再由本项目通过 stdio 调用 MCP Server。

```text
mcp-web → mcp-client Web API → MCP stdio → mcp-server
```

## 1. 安装依赖

在项目根目录执行：

```bash
npm install
```

## 2. 配置环境变量

在根目录创建或编辑 `.env` 文件：

```env
# 选择模型提供商：anthropic / deepseek / openai
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash

# 统一 API 配置
API_KEY=your_api_key_here
API_BASE_URL=https://api.deepseek.com
```

说明：

- `LLM_PROVIDER` 控制当前使用哪个模型提供商
- `LLM_MODEL` 决定具体模型名称
- `API_KEY` 是对应 provider 的 API Key
- `API_BASE_URL` 是对应 provider 的基础地址

示例：

```env
# DeepSeek
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash
API_KEY=your_deepseek_key
API_BASE_URL=https://api.deepseek.com
```

```env
# OpenAI
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
API_KEY=your_openai_key
API_BASE_URL=https://api.openai.com/v1
```

```env
# Anthropic
LLM_PROVIDER=anthropic
LLM_MODEL=claude-3-5-sonnet-20241022
API_KEY=your_anthropic_key
API_BASE_URL=https://api.anthropic.com
```

## 3. 构建项目

```bash
npm run build
```

## 4. Web API 模式

Web 模式会在启动时连接一次 MCP Server，并提供以下接口：

```http
GET  /health
GET  /api/tools
POST /api/chat
```

启动天气 MCP Server 的 Web 网关：

```bash
npm run build
npm run web -- D:\workplace\mcp-server\src\weather\index.js
```

默认监听 `http://localhost:3000`。也可以通过环境变量配置：

```env
MCP_SERVER_SCRIPT=D:\workplace\mcp-server\src\weather\index.js
PORT=3000
WEB_ORIGIN=http://localhost:5173
```

此时可以直接执行：

```bash
npm run web
```

聊天请求示例：

```bash
curl -X POST http://localhost:3000/api/chat `
	-H "Content-Type: application/json" `
	-d '{"message":"纽约今天适合地铁通勤吗？"}'
```

请求体中的 `message` 必须是非空字符串，最大长度为 4000 个字符。Web API 会串行处理聊天请求，避免共享 MCP stdio 连接发生并发读写冲突。

## 5. 控制台模式

必须传入一个 MCP Server 的脚本路径作为参数，不能只传目录，必须传 `.js` 或 `.py` 文件。

### 例子 1：启动天气服务（当前已验证）

```bash
npm run start -- D:\workplace\mcp-server\src\weather\index.js
```

### 例子 2：启动 Python 版本的 MCP Server

```bash
npm run start -- D:\workplace\mcp-server\server.py
```

### 例子 3：直接运行编译后的 JS 文件

```bash
node build/client.js D:\workplace\mcp-server\src\weather\index.js
```

## 6. 启动后如何使用

程序启动后会进入交互式聊天模式：

```text
查询：纽约今天的天气
```

输入 `quit` 可退出程序。

## 7. 重要注意事项

### 7.1 必须传脚本路径，不是目录

下面这样是不对的：

```bash
npm run start -- D:\workplace\mcp-server
```

因为代码会检查是否是 `.js` 或 `.py` 文件，目录本身不能直接作为子进程执行对象。

### 7.2 `.env` 修改后需要重启项目

`dotenv.config()` 在进程启动时读取环境变量，所以修改 `.env` 后通常需要关闭当前进程并重新启动。

### 7.3 不是 MCP Server 认证问题，而是模型提供商认证问题

- `mcp-server` 负责提供工具能力
- `LLM_PROVIDER` / `API_KEY` 负责模型调用鉴权

两者是不同层次的问题。

### 7.4 DeepSeek 需要注意 reasoning_content

如果你使用 DeepSeek 这类支持思维模式的模型，工具调用时需要正确回传 reasoning 信息；当前项目已对这类场景做了兼容处理。

### 7.5 需要保证 server 是实际可执行脚本

如果你传入的 server 路径不存在，或者不是可执行脚本，连接会失败。

## 8. 常见启动失败原因

1. 没有传入 server 路径
2. 传入了目录而不是 `.js` / `.py` 文件
3. `.env` 中 `API_KEY` 为空或错误
4. `LLM_PROVIDER` 与 `API_BASE_URL` 不匹配
5. 当前程序还在运行，修改了 `.env` 但没有重启

## 9. 推荐的默认配置

当前项目的默认推荐配置：

```env
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash
API_KEY=your_deepseek_key
API_BASE_URL=https://api.deepseek.com
```

如果你已经有可用的 DeepSeek API Key，可以直接替换即可。
