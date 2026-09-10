# MCP Client

这是一个基于 Model Context Protocol (MCP) 的客户端示例，用于连接 MCP Server，并让 LLM 通过工具调用来回答问题。

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

## 4. 启动项目

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

## 5. 启动后如何使用

程序启动后会进入交互式聊天模式：

```text
查询：纽约今天的天气
```

输入 `quit` 可退出程序。

## 6. 重要注意事项

### 6.1 必须传脚本路径，不是目录

下面这样是不对的：

```bash
npm run start -- D:\workplace\mcp-server
```

因为代码会检查是否是 `.js` 或 `.py` 文件，目录本身不能直接作为子进程执行对象。

### 6.2 `.env` 修改后需要重启项目

`dotenv.config()` 在进程启动时读取环境变量，所以修改 `.env` 后通常需要关闭当前进程并重新启动。

### 6.3 不是 MCP Server 认证问题，而是模型提供商认证问题

- `mcp-server` 负责提供工具能力
- `LLM_PROVIDER` / `API_KEY` 负责模型调用鉴权

两者是不同层次的问题。

### 6.4 DeepSeek 需要注意 reasoning_content

如果你使用 DeepSeek 这类支持思维模式的模型，工具调用时需要正确回传 reasoning 信息；当前项目已对这类场景做了兼容处理。

### 6.5 需要保证 server 是实际可执行脚本

如果你传入的 server 路径不存在，或者不是可执行脚本，连接会失败。

## 7. 常见启动失败原因

1. 没有传入 server 路径
2. 传入了目录而不是 `.js` / `.py` 文件
3. `.env` 中 `API_KEY` 为空或错误
4. `LLM_PROVIDER` 与 `API_BASE_URL` 不匹配
5. 当前程序还在运行，修改了 `.env` 但没有重启

## 8. 推荐的默认配置

当前项目的默认推荐配置：

```env
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-v4-flash
API_KEY=your_deepseek_key
API_BASE_URL=https://api.deepseek.com
```

如果你已经有可用的 DeepSeek API Key，可以直接替换即可。
