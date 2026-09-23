import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../../agent.js";
import { CacheManager, SANGO_QUERY_EMBED_TOOL, type CacheLogStore } from "../../cache.js";
import { MCPTransport } from "../../transport.js";
import { loadAliasTable } from "../../citation.js";
import { runWithTraceId } from "../../trace.js";
import type {
  CacheLogPayload,
  CacheEntryMirror,
} from "../../cache.js";
import type {
  LLMConfig,
  LLMProvider,
  MCPToolDefinition,
  ModelResponse,
  ToolCallResult,
} from "../../types.js";

/** Mock Transport：记录检索 / 内部 embed 调用，不发真实 MCP 连接 */
class CacheMockTransport extends MCPTransport {
  toolCalls: string[] = [];
  embedCalls: string[] = [];
  private vectors: Map<string, Float32Array>;
  private failEmbed: boolean;

  constructor(vectors: Map<string, Float32Array>, failEmbed = false) {
    super("mock-cache-server");
    this.vectors = vectors;
    this.failEmbed = failEmbed;
  }

  override async listTools(): Promise<MCPToolDefinition[]> {
    return [NOVEL_TOOL];
  }

  override async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.toolCalls.push(name);
    return { content: [{ type: "text", text: RECALL_TEXT }] };
  }

  /** feat-A013 §1.7.2：内部工具调用（老陈实现前测试注入；不落 tool_call_logs 由 transport 保证） */
  async callInternal(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    this.embedCalls.push(name);
    if (this.failEmbed) {
      throw new Error("embed service down");
    }
    const vec = this.vectors.get(String(args.query ?? ""));
    if (!vec) {
      return { content: [], isError: true } as ToolCallResult;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            dim: 1024,
            encoding: "base64-float32-le",
            data: Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64"),
          }),
        },
      ],
    };
  }
}

const NOVEL_TOOL: MCPToolDefinition = {
  name: "sango_novel_search",
  description: "《三国演义》原著检索：参数 source=sanguo-yanyi、query=用户白话问句、limit 默认 5",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string" },
      query: { type: "string" },
      limit: { type: "number" },
    },
  },
};

function makeConfig(provider: LLMProvider = "deepseek"): LLMConfig {
  return {
    provider,
    model: "mock-model",
    apiKey: "mock-key",
    apiBaseUrl: "https://mock.local",
  };
}

function textResponse(text: string): ModelResponse {
  return { content: [{ type: "text", text }] };
}

/** 单位向量（cosine 精确 1.0 / 0） */
function unitVector(axis: number): Float32Array {
  const vec = new Float32Array(1024);
  vec[axis] = 1;
  return vec;
}

/** 内存 fake LogStore（同 cache.test.ts 口径，供 cache_logs 断言） */
class FakeCacheLogStore implements CacheLogStore {
  cacheLogs: Array<{ traceId: string; payload: CacheLogPayload }> = [];
  mirrors: CacheEntryMirror[] = [];
  updates: Array<{ id: number; patch: { hitCount?: number; lastAccessAt?: number } }> = [];
  deletes: number[] = [];
  clearCount = 0;

  appendCacheLog(traceId: string, payload: CacheLogPayload): void {
    this.cacheLogs.push({ traceId, payload });
  }
  insertCacheEntry(payload: CacheEntryMirror): void {
    this.mirrors.push(payload);
  }
  updateCacheEntry(id: number, patch: { hitCount?: number; lastAccessAt?: number }): void {
    this.updates.push({ id, patch });
  }
  deleteCacheEntry(id: number): void {
    this.deletes.push(id);
    const index = this.mirrors.findIndex((item) => item.id === id);
    if (index >= 0) {
      this.mirrors.splice(index, 1);
    }
  }
  clearCacheEntries(): void {
    this.clearCount += 1;
    this.mirrors = [];
  }
}

const RECALL_QUOTE = "云长提刀出阵，斩华雄于帐前！";
const RECALL_BODY = `众皆大惊曰：“${RECALL_QUOTE}”`;
const RECALL_TEXT = JSON.stringify([
  {
    id: "sanguo-yanyi:0005:c0001",
    text: RECALL_BODY,
    chapter: 5,
    title: "发矫诏诸镇应曹公　破关兵三英战吕布",
    type: "narration",
    segFrom: 4,
    segTo: 4,
    quoteBalanced: true,
    quotes: [{ offset: 7, len: RECALL_QUOTE.length }],
  },
]);

interface AgentFixture {
  agent: Agent;
  manager: CacheManager;
  transport: CacheMockTransport;
  logStore: FakeCacheLogStore;
  modelCalls: { total: number; classify: number; generation: number };
}

/** 标准装配：mock transport + 生成轮固定输出（走引用硬校验兜底路径产出带引用的 ChatData，非拒答类可入池） */
function makeAgentFixture(options: {
  vectors: Map<string, Float32Array>;
  failEmbed?: boolean;
  cacheEnabled?: boolean;
  withCache?: boolean;
}): AgentFixture {
  const vectors = options.vectors;
  const transport = new CacheMockTransport(vectors, options.failEmbed ?? false);
  const logStore = new FakeCacheLogStore();
  const modelCalls = { total: 0, classify: 0, generation: 0 };
  const modelCaller = async (messages: any[]): Promise<ModelResponse> => {
    modelCalls.total += 1;
    // 分类轮 = [system, user] 两条；生成轮（有注入）= 三条
    if (messages.length === 2) {
      modelCalls.classify += 1;
      return textResponse("1");
    }
    modelCalls.generation += 1;
    return textResponse("关羽斩了华雄。");
  };
  const manager = new CacheManager({
    transport,
    logStore,
    enabled: options.cacheEnabled ?? true,
    hitLine: 0.92,
    maxEntries: 500,
  });
  const agent = new Agent(transport, makeConfig(), {
    tools: [NOVEL_TOOL],
    modelCaller,
    aliasTable: loadAliasTable("a013-not-exist"),
    fallbackConcluder: async () => "斩华雄者系关羽",
    ...(options.withCache === false ? {} : { cacheManager: manager }),
  });
  return { agent, manager, transport, logStore, modelCalls };
}

function trace(traceId: string, fn: () => Promise<unknown>): Promise<unknown> {
  return runWithTraceId(traceId, fn);
}test("命中链路：sango-novel 原句二次提问命中——第二次 0 次 LLM + 0 次检索，返回与首次一致的答案对象，cache_logs 两行 hit=0/1", async () => {
  const vectors = new Map<string, Float32Array>();
  vectors.set("义释严颜是怎么回事", unitVector(0));
  const fixture = makeAgentFixture({ vectors });

  // 首问：池空 → miss-low → 走完整链路（检索 + LLM + 引用校验）→ 写缓存
  const first = (await trace("agt-1", () =>
    fixture.agent.processQueryData("义释严颜是怎么回事", "sango-novel")
  )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
  assert.ok(first.answer.length > 0);
  assert.ok(first.citations.length >= 1, "引用硬校验兜底应产出带引用的答案（非拒答类可入池）");
  assert.equal(fixture.modelCalls.generation, 1, "首问 1 次生成轮 LLM");
  assert.deepEqual(fixture.transport.toolCalls, ["sango_novel_search"], "首问 1 次检索");
  assert.equal(fixture.manager.getStatus().entryCount, 1, "首问写缓存入池");

  // 次问：命中 → 0 次 LLM + 0 次检索，直接返回缓存答案深拷贝
  const second = (await trace("agt-2", () =>
    fixture.agent.processQueryData("义释严颜是怎么回事", "sango-novel")
  )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
  assert.deepEqual(second, first, "命中返回与首次一致的答案对象");
  assert.notEqual(second, first, "命中返回深拷贝，不与缓存池共享引用");
  assert.equal(fixture.modelCalls.generation, 1, "命中轮 0 次生成轮 LLM");
  assert.equal(fixture.modelCalls.total, 1, "命中轮 0 次 LLM 调用");
  assert.equal(fixture.transport.toolCalls.length, 1, "命中轮 0 次检索");
  assert.equal(fixture.transport.embedCalls.length, 2, "两次请求各 1 次 embedding 判定");

  // cache_logs：首行 hit=0 (similarity=null)，次行 hit=1 (similarity=1)
  assert.equal(fixture.logStore.cacheLogs.length, 2, "命中 / 未命中一律一行");
  const firstRow = fixture.logStore.cacheLogs.find((item) => item.traceId === "agt-1")?.payload;
  assert.equal(firstRow?.hit, false);
  assert.equal(firstRow?.similarity, null);
  const secondRow = fixture.logStore.cacheLogs.find((item) => item.traceId === "agt-2")?.payload;
  assert.equal(secondRow?.hit, true);
  assert.equal(secondRow?.similarity, 1);
  assert.equal(secondRow?.hitLine, 0.92);
  assert.equal(secondRow?.nearestQuery, "义释严颜是怎么回事");
});

test("命中链路：等价问法（问经过换说法）命中，0 次 LLM + 0 次检索", async () => {
  const vectors = new Map<string, Float32Array>();
  vectors.set("义释严颜是怎么回事", unitVector(0));
  vectors.set("严颜是怎么被义释的", unitVector(0));
  const fixture = makeAgentFixture({ vectors });

  await trace("eq-1", () =>
    fixture.agent.processQueryData("义释严颜是怎么回事", "sango-novel")
  );
  const second = (await trace("eq-2", () =>
    fixture.agent.processQueryData("严颜是怎么被义释的", "sango-novel")
  )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
  assert.ok(second.answer.length > 0);
  assert.equal(fixture.modelCalls.generation, 1, "等价问法命中：第二次 0 次生成");
  assert.equal(fixture.transport.toolCalls.length, 1, "等价问法命中：第二次 0 次检索");
});

test("问点不同（chapter vs process）不命中：走原链路且不写缓存", async () => {
  const vectors = new Map<string, Float32Array>();
  vectors.set("严颜被义释是哪一回", unitVector(0));
  vectors.set("义释严颜的经过", unitVector(0));
  const fixture = makeAgentFixture({ vectors });

  await trace("fd-1", () =>
    fixture.agent.processQueryData("严颜被义释是哪一回", "sango-novel")
  );
  assert.equal(fixture.manager.getStatus().entryCount, 1);
  const second = (await trace("fd-2", () =>
    fixture.agent.processQueryData("义释严颜的经过", "sango-novel")
  )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
  assert.ok(second.answer.length > 0, "不命中应正常走检索 + LLM 返回答案");
  assert.equal(fixture.modelCalls.generation, 2, "问点不同：第二次仍走生成轮");
  assert.equal(fixture.transport.toolCalls.length, 2, "问点不同：第二次仍走检索");
  assert.equal(fixture.manager.getStatus().entryCount, 1, "焦点拒判不写缓存（池子不被近似重复污染）");
  const row = fixture.logStore.cacheLogs.find((item) => item.traceId === "fd-2")?.payload;
  assert.equal(row?.hit, false);
  assert.equal(row?.similarity, 1);
  assert.equal(row?.tieHits, 1);
  assert.equal(row?.nearestQuery, "严颜被义释是哪一回");
});

test("开关：关闭后同一问题再问走 LLM（不查不落），开启后恢复命中", async () => {
  const vectors = new Map<string, Float32Array>();
  vectors.set("谁斩了华雄", unitVector(0));
  const fixture = makeAgentFixture({ vectors });

  await trace("sw-1", () => fixture.agent.processQueryData("谁斩了华雄", "sango-novel"));
  fixture.manager.setEnabled(false);
  await trace("sw-2", () => fixture.agent.processQueryData("谁斩了华雄", "sango-novel"));
  assert.equal(fixture.modelCalls.generation, 2, "关闭后同一问题再问走 LLM");
  assert.equal(fixture.transport.toolCalls.length, 2, "关闭后同一问题再问走检索");
  assert.equal(fixture.transport.embedCalls.length, 1, "关闭后不查缓存（旁路不调 embed）");
  assert.equal(fixture.logStore.cacheLogs.length, 1, "关闭后不落 cache_logs");
  fixture.manager.setEnabled(true);
  await trace("sw-3", () => fixture.agent.processQueryData("谁斩了华雄", "sango-novel"));
  assert.equal(fixture.modelCalls.generation, 2, "开启后恢复命中（0 次 LLM）");
  assert.equal(fixture.transport.toolCalls.length, 2, "开启后恢复命中（检索次数不再增长）");
  assert.equal(fixture.transport.embedCalls.length, 2, "开启后恢复判定（embed 调用恢复）");
});

test("embedding 降级：/api/chat 等价行为不受影响，请求正常返回，console.warn 一次", async () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warns.push(String(message));
  };
  try {
    const vectors = new Map<string, Float32Array>();
    vectors.set("谁斩了华雄", unitVector(0));
    const fixture = makeAgentFixture({ vectors, failEmbed: true });
    const data = (await trace("dg-1", () =>
      fixture.agent.processQueryData("谁斩了华雄", "sango-novel")
    )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
    assert.ok(data.answer.length > 0, "降级旁路应正常走原链路返回答案");
    assert.equal(fixture.modelCalls.generation, 1);
    assert.equal(fixture.transport.toolCalls.length, 1);
    assert.equal(fixture.manager.getStatus().entryCount, 0, "降级不写缓存");
    assert.equal(fixture.logStore.cacheLogs.length, 0, "降级不落 cache_logs");
    assert.equal(
      warns.filter((item) => item.includes(SANGO_QUERY_EMBED_TOOL)).length,
      1,
      "降级 console.warn 一次"
    );
  } finally {
    console.warn = originalWarn;
  }
});test("auto 域：分类轮判定 sango-novel 后命中缓存——仅分类 1 次 LLM，生成 0 次、检索 0 次", async () => {
  const vectors = new Map<string, Float32Array>();
  vectors.set("谁斩了华雄", unitVector(0));
  const fixture = makeAgentFixture({ vectors });

  // 预热：domain 锁定首问入池（生成轮 1 次）
  await trace("cl-1", () => fixture.agent.processQueryData("谁斩了华雄", "sango-novel"));
  const classifyCallsBefore = fixture.modelCalls.classify;
  assert.equal(fixture.modelCalls.generation, 1);

  // 二次提问不带 domain：路由判定 = 轻量分类轮出编号 1（sango-novel）→ 查缓存命中
  const second = (await trace("cl-2", () =>
    fixture.agent.processQueryData("谁斩了华雄")
  )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
  assert.ok(second.answer.length > 0);
  assert.equal(fixture.modelCalls.classify, classifyCallsBefore + 1, "分类轮 1 次（路由判定本身，命中前必经）");
  assert.equal(fixture.modelCalls.generation, 1, "命中轮 0 次生成（0 次 LLM 生成）");
  assert.equal(fixture.transport.toolCalls.length, 1, "命中轮 0 次检索");
  const row = fixture.logStore.cacheLogs.find((item) => item.traceId === "cl-2")?.payload;
  assert.equal(row?.hit, true);
  assert.equal(row?.similarity, 1);
});

test("回归：cacheManager 未注入时行为与存量一致（不查缓存、不落 cache_logs、请求正常）", async () => {
  const vectors = new Map<string, Float32Array>();
  vectors.set("谁斩了华雄", unitVector(0));
  const fixture = makeAgentFixture({ vectors, withCache: false });
  const data = (await trace("nc-1", () =>
    fixture.agent.processQueryData("谁斩了华雄", "sango-novel")
  )) as Awaited<ReturnType<typeof fixture.agent.processQueryData>>;
  assert.ok(data.answer.length > 0);
  assert.equal(fixture.modelCalls.generation, 1);
  assert.equal(fixture.transport.toolCalls.length, 1);
  assert.equal(fixture.transport.embedCalls.length, 0, "未注入 cacheManager 不触发 lookup");
  assert.equal(fixture.logStore.cacheLogs.length, 0);
});