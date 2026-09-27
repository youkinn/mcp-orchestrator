import dotenv from "dotenv";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MCPTransport, resolveMCPServerConfigs } from "./transport.js";
import { Agent } from "./agent.js";
import type { LLMProvider } from "./types.js";

dotenv.config();

// feat-A017 草稿台 CLI：与页面共用同一组 HTTP 接口为唯一后端（§1 / §6），
// 单次命令 = 单次 POST，无循环 / 批量 / 自动重试。
const DRAFTBENCH_BASE_URL =
  process.env.DRAFTBENCH_BASE_URL ?? "http://localhost:3000";

const mcpServerConfigs = resolveMCPServerConfigs(process.env);

function readLLMConfig() {
  const provider = (
    process.env.LLM_PROVIDER || "deepseek"
  ).toLowerCase() as LLMProvider;

  if (!["anthropic", "deepseek", "openai"].includes(provider)) {
    throw new Error("LLM_PROVIDER must be anthropic / deepseek / openai");
  }

  const model = process.env.LLM_MODEL || ''
  const apiKey = process.env.API_KEY || '';
  const apiBaseUrl = process.env.API_BASE_URL || '';

  if (!apiKey) {
    throw new Error("Missing API_KEY in .env");
  }

  return { provider, model, apiKey, apiBaseUrl };
}

// ===== feat-A017 草稿台 CLI（本地编辑清单文件中转，见接口契约 §6） =====

interface DraftbenchEditChunk {
  chunkId?: string;
  text: string;
  chapter?: number;
  title?: string;
}

interface DraftbenchEditFile {
  query: string;
  chunks: DraftbenchEditChunk[];
  params?: {
    temperature?: number;
    topK?: number;
    guarantee?: number;
    budget?: number;
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function draftbenchUsage(): void {
  console.error("用法：npm start -- draftbench <命令> [参数]");
  console.error("  trace <traceId> [--out 文件]   拉取该请求候选/注入清单并生成本地编辑文件");
  console.error("  send <文件> [--query 内容] [--temperature N] [--topK N] [--guarantee N] [--budget N]");
  console.error("  records                       草稿台记录列表");
  console.error("  record <traceId>              草稿台记录详情（含差异）");
  console.error("通用：[--base URL] 指定后端（默认 " + DRAFTBENCH_BASE_URL + "）");
}

async function fetchJson(
  baseUrl: string,
  pathname: string,
  init?: RequestInit
): Promise<{ status: number; bodyJson: unknown; traceId: string }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const bodyJson = await response.json().catch(() => null);
  return {
    status: response.status,
    bodyJson,
    traceId: response.headers.get("X-Trace-Id") ?? "",
  };
}

function envelope(bodyJson: unknown): { code: number; data: any; message: string } {
  const parsed = (bodyJson ?? {}) as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  return {
    code: parsed.code === 200 ? 200 : typeof parsed.code === "number" ? parsed.code : 500,
    data: parsed.data,
    message: typeof parsed.message === "string" ? parsed.message : "",
  };
}

/** 经既有章节通道取 chunk 原文（同一组 HTTP 接口内的 /api/v1/sango/chapters/:chapter） */
async function fetchChunkText(
  baseUrl: string,
  chapter: number,
  chunkId: string
): Promise<string> {
  const { bodyJson } = await fetchJson(
    baseUrl,
    `/api/v1/sango/chapters/${chapter}`
  );
  const parsed = envelope(bodyJson);
  if (parsed.code !== 200 || !parsed.data || typeof parsed.data !== "object") {
    return "";
  }
  const chunks = (parsed.data as { chunks?: unknown }).chunks;
  if (!Array.isArray(chunks)) {
    return "";
  }
  const entry = chunks.find(
    (chunk: any) =>
      chunk !== null &&
      typeof chunk === "object" &&
      chunk.chunkId === chunkId
  ) as { text?: unknown } | undefined;
  return typeof entry?.text === "string" ? entry.text : "";
}

async function draftbenchTraceCommand(args: string[]): Promise<void> {
  const traceId = args[0];
  const baseUrl = flagValue(args, "--base") ?? DRAFTBENCH_BASE_URL;
  if (!traceId) {
    draftbenchUsage();
    process.exitCode = 1;
    return;
  }
  const { status, bodyJson } = await fetchJson(
    baseUrl,
    `/api/v1/draftbench/trace/${encodeURIComponent(traceId)}`
  );
  const parsed = envelope(bodyJson);
  if (parsed.code !== 200 || parsed.data === null) {
    console.error(
      `拉取失败（HTTP ${status}）：${parsed.message || (bodyJson === null ? "响应非法" : "")}`
    );
    process.exitCode = 1;
    return;
  }
  const data = parsed.data;
  const candidates = Array.isArray(data?.chunks?.candidates)
    ? data.chunks.candidates
    : [];
  console.log(`traceId: ${data.traceId}`);
  console.log(`query: ${data.userQuery ?? ""}`);
  console.log(`routeSource: ${data.routeSource ?? ""}`);
  console.log(
    `注入 ${data.chunks.injectedCount ?? 0} 条 / 引用 ${data.chunks.citedCount ?? 0} 条`
  );
  console.log("候选（只读源，全量展示）:");
  for (const candidate of candidates) {
    const seg =
      candidate.segFrom != null && candidate.segTo != null
        ? `段${candidate.segFrom}-${candidate.segTo}`
        : "";
    const marker = candidate.injected ? "[注入]" : "      ";
    console.log(
      `  #${candidate.rank ?? "?"} ${marker} 第${candidate.chapter ?? "?"}回 ${candidate.title ?? ""} ${seg} ${candidate.preview ?? "(无预览)"}`
    );
  }
  console.log(`默认参数: ${JSON.stringify(data.params ?? {})}`);

  // 生成本地编辑清单（文件中转）：注入候选预填，原文优先经章节接口补全、失败回落 preview
  const outFile =
    flagValue(args, "--out") ?? `draftbench-${traceId.slice(0, 8)}.json`;
  const editFile: DraftbenchEditFile = {
    query: data.userQuery ?? "",
    chunks: [],
    params: {
      temperature: data.params?.temperature,
      topK: data.params?.topK,
      guarantee: data.params?.guarantee,
      budget: data.params?.budget,
    },
  };
  const injected = candidates.filter(
    (candidate: any) => candidate.injected === true
  );
  for (const candidate of injected) {
    let text = typeof candidate.preview === "string" ? candidate.preview : "";
    if (
      typeof candidate.chapter === "number" &&
      typeof candidate.chunkId === "string" &&
      candidate.chunkId
    ) {
      const fullText = await fetchChunkText(
        baseUrl,
        candidate.chapter,
        candidate.chunkId
      );
      if (fullText) {
        text = fullText;
      }
    }
    editFile.chunks.push({
      chunkId:
        typeof candidate.chunkId === "string" ? candidate.chunkId : undefined,
      text,
      chapter:
        typeof candidate.chapter === "number" ? candidate.chapter : undefined,
      title: typeof candidate.title === "string" ? candidate.title : undefined,
    });
  }
  writeFileSync(outFile, `${JSON.stringify(editFile, null, 2)}\n`, "utf8");
  console.log(
    `已写入编辑清单（可增删 / 排序 / 改片段与参数后 send）: ${outFile}`
  );
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, "");
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

async function draftbenchSendCommand(args: string[]): Promise<void> {
  const file = args.find((arg) => !arg.startsWith("--"));
  const baseUrl = flagValue(args, "--base") ?? DRAFTBENCH_BASE_URL;
  if (!file) {
    draftbenchUsage();
    process.exitCode = 1;
    return;
  }
  if (!existsSync(file)) {
    console.error(`编辑清单不存在: ${file}`);
    process.exitCode = 1;
    return;
  }
  let editFile: DraftbenchEditFile;
  try {
    editFile = JSON.parse(readFileSync(file, "utf8")) as DraftbenchEditFile;
  } catch (error) {
    console.error(`编辑清单解析失败: ${file}`, error);
    process.exitCode = 1;
    return;
  }
  const query = flagValue(args, "--query") ?? editFile.query;
  const params = {
    temperature: Number(
      flagValue(args, "--temperature") ?? editFile.params?.temperature ?? 0.7
    ),
    topK: Number(flagValue(args, "--topK") ?? editFile.params?.topK ?? 10),
    guarantee: Number(
      flagValue(args, "--guarantee") ?? editFile.params?.guarantee ?? 5
    ),
    budget: Number(flagValue(args, "--budget") ?? editFile.params?.budget ?? 2000),
  };
  const payload = {
    message: query,
    domain: "sango-novel",
    source: "draftbench",
    chunks: editFile.chunks ?? [],
    params,
  };
  // 单次命令 = 单次 POST（§1 红线：无循环 / 批量 / 自动重试）
  const { status, bodyJson, traceId } = await fetchJson(baseUrl, "/api/chat", {
    method: "POST",
    headers: { "X-Trace-Id": randomUUID() },
    body: JSON.stringify(payload),
  });
  const parsed = envelope(bodyJson);
  if (parsed.code !== 200 || parsed.data === null) {
    console.error(
      `发送失败（HTTP ${status}）：${parsed.message || (bodyJson === null ? "响应非法" : "")}`
    );
    console.error(`记录 traceId: ${traceId}`);
    process.exitCode = 1;
    return;
  }
  const data = parsed.data;
  const consistent = new Set<number>(
    Array.isArray(data.diff?.consistent) ? data.diff.consistent : []
  );
  const missing = new Set<number>(
    Array.isArray(data.diff?.missing) ? data.diff.missing : []
  );
  console.log(`traceId: ${traceId || data.traceId}`);
  console.log("注入清单（差异符号：= 一致 / - 缺失 / ! 多余）:");
  (editFile.chunks ?? []).forEach((chunk, index) => {
    const number = index + 1;
    const symbol = consistent.has(number)
      ? "="
      : missing.has(number)
        ? "-"
        : " ";
    const title = chunk.title
      ? `第${chunk.chapter ?? "?"}回 ${chunk.title}`
      : `第${chunk.chapter ?? "?"}回`;
    console.log(`  ${symbol} [${number}] ${title} ${previewText(chunk.text)}`);
  });
  for (const citation of Array.isArray(data.diff?.extra)
    ? data.diff.extra
    : []) {
    console.log(
      `  ! 多余引用（不在清单）: ${
        typeof citation?.text === "string" ? citation.text : JSON.stringify(citation)
      }`
    );
  }
  console.log(`answer: ${data.answer ?? ""}`);
  console.log("citations:");
  (data.citations ?? []).forEach((citation: any, index: number) => {
    const where =
      citation.chapter != null
        ? `（第${citation.chapter}回${citation.title ? ` ${citation.title}` : ""}）`
        : "";
    console.log(`  [${index + 1}] ${citation.text}${where}`);
  });
  console.log(`生效参数: ${JSON.stringify(data.params ?? {})}`);
  console.log(
    `差异: 一致 [${(data.diff?.consistent ?? []).join(",")}] 缺失 [${(data.diff?.missing ?? []).join(",")}] 多余 ${(data.diff?.extra ?? []).length} 条`
  );
}

async function draftbenchRecordsCommand(baseUrl: string): Promise<void> {
  const { status, bodyJson } = await fetchJson(
    baseUrl,
    "/api/v1/draftbench/records?pageNo=1&pageSize=20"
  );
  const parsed = envelope(bodyJson);
  if (parsed.code !== 200 || parsed.data === null) {
    console.error(
      `查询失败（HTTP ${status}）：${parsed.message || (bodyJson === null ? "响应非法" : "")}`
    );
    process.exitCode = 1;
    return;
  }
  const data = parsed.data;
  console.log(`草稿台记录（共 ${data.total} 条）:`);
  for (const item of data.list ?? []) {
    const time = new Date(item.time).toISOString();
    const summary = item.result
      ? `answer 前 ${item.result.answer ? item.result.answer.length : 0} 字 / 引用 ${item.result.citationCount} 条`
      : "无结果";
    console.log(
      `  ${item.status === "success" ? "成功" : "失败"} ${time} ${item.traceId} 片段${item.chunkCount}条 params=${JSON.stringify(item.params ?? {})} ${summary}`
    );
  }
}

async function draftbenchRecordCommand(
  args: string[],
  baseUrl: string
): Promise<void> {
  const traceId = args[0];
  if (!traceId) {
    draftbenchUsage();
    process.exitCode = 1;
    return;
  }
  const { status, bodyJson } = await fetchJson(
    baseUrl,
    `/api/v1/draftbench/records/${encodeURIComponent(traceId)}`
  );
  const parsed = envelope(bodyJson);
  if (parsed.code !== 200 || parsed.data === null) {
    console.error(
      `查询失败（HTTP ${status}）：${parsed.message || (bodyJson === null ? "响应非法" : "")}`
    );
    process.exitCode = 1;
    return;
  }
  const data = parsed.data;
  console.log(`traceId: ${data.traceId}`);
  console.log(`时间: ${new Date(data.time).toISOString()}`);
  console.log(
    `query: ${data.query}${data.errorMessage ? `（${data.errorMessage}）` : ""}`
  );
  console.log(`status: ${data.status}`);
  console.log(`params: ${JSON.stringify(data.params ?? {})}`);
  console.log("发送清单:");
  (data.chunks ?? []).forEach((chunk: any, index: number) => {
    console.log(
      `  [${index + 1}] ${chunk.chunkId ?? "无 chunkId"} ${chunk.chapter != null ? `第${chunk.chapter}回` : ""} ${previewText(chunk.text ?? "")}`
    );
  });
  const diff = data.diff ?? { consistent: [], missing: [], extra: [] };
  console.log(
    `差异: 一致 [${(diff.consistent ?? []).join(",")}] 缺失 [${(diff.missing ?? []).join(",")}] 多余 ${(diff.extra ?? []).length} 条`
  );
  if (data.result) {
    console.log(`answer: ${data.result.answer ?? ""}`);
    (data.result.citations ?? []).forEach((citation: any, index: number) => {
      console.log(`  [${index + 1}] ${citation.text}`);
    });
  }
}

async function runDraftbenchCli(args: string[]): Promise<void> {
  const command = args[0];
  const rest = args.slice(1);
  const baseUrl = flagValue(rest, "--base") ?? DRAFTBENCH_BASE_URL;
  switch (command) {
    case "trace":
      await draftbenchTraceCommand(rest);
      return;
    case "send":
      await draftbenchSendCommand(rest);
      return;
    case "records":
      await draftbenchRecordsCommand(baseUrl);
      return;
    case "record":
      await draftbenchRecordCommand(rest, baseUrl);
      return;
    default:
      draftbenchUsage();
      process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  // feat-A017：draftbench 子命令走同一组 HTTP 接口（cli.ts 原交互 REPL 逻辑不动）
  if (args[0] === "draftbench") {
    await runDraftbenchCli(args.slice(1));
    return;
  }
  const transport = new MCPTransport(mcpServerConfigs);
  await transport.connect();

  const llmConfig = readLLMConfig();
  const agent = new Agent(transport, llmConfig);

  console.log("\nMCP Orchestrator CLI started");
  console.log("Enter your query or type 'quit' to exit.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question("\nQuery: ", async (query: string) => {
      try {
        if (query.toLowerCase() === "quit") {
          await transport.close();
          rl.close();
          return;
        }

        const response = await agent.processQuery(query);
        console.log("\n" + response);
        askQuestion();
      } catch (error) {
        console.error("\nError:", error);
        askQuestion();
      }
    });
  };

  askQuestion();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
