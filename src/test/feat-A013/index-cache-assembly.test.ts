// feat-A013 总台装配点测试（index.ts 组装链复刻，测试即文档）：
// 不 import index.ts（入口 main() 会自动执行并校验 API_KEY），按代码事实复刻其组装——
// CacheManager 构造（transport=callInternal 通道 / logStore=getLogStore 形状）→ 构造即清一次 cache_entries 镜像 →
// env 缺省语义（CACHE_ENABLED 缺省开 / CACHE_HIT_LINE 缺省 0.92 / CACHE_MAX_ENTRIES 缺省 500，解析在 CacheManager 构造内）→
// createServer options.cacheManager 注入挂载 /api/v1/cache*。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { CacheManager } from '../../cache.js';
import { createServer } from '../../server.js';
import { createLogStore, type LogStore } from '../../storage/logs.js';
import type { Agent } from '../../agent.js';
import type { MCPTransport } from '../../transport.js';
import type { ToolCallResult } from '../../types.js';

class StubAgent {
  async processQueryData(query: string): Promise<{ answer: string; citations: [] }> {
    return { answer: '统一 Agent 回复', citations: [] };
  }

  async listTools(): Promise<unknown[]> {
    return [];
  }
}

class QuizSimTransport {
  async fengyunsanguo_quiz_command(message: string): Promise<ToolCallResult> {
    return { content: [{ type: 'text', text: `模拟回复：${message}` }] };
  }
}

/** CacheEmbeddingClient 形状（§1.7.2）：callInternal；装配测试不真跑 embed（lookup 才会调用） */
class FakeEmbedClient {
  async callInternal(_name: string, _args: Record<string, unknown>): Promise<ToolCallResult> {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            dim: 1024,
            encoding: 'base64-float32-le',
            data: Buffer.alloc(4096).toString('base64'),
          }),
        },
      ],
    };
  }
}

/** 记录修改前的 env 并在测试结束时恢复 */
function withEnv(t: TestContext, patch: Record<string, string | undefined>): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function startServer(
  t: TestContext,
  logStore: LogStore,
  cacheManager: CacheManager
): Promise<string> {
  const app = createServer(
    new StubAgent() as unknown as Agent,
    new QuizSimTransport() as unknown as MCPTransport,
    { port: 0, allowedOrigin: '*', logStore, cacheManager }
  );
  const server = app.listen(0);
  await once(server, 'listening');
  t.after(() => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test('① CacheManager 构造即清一次 cache_entries 镜像（§2.3 启动清镜像，index 装配语义）', (t) => {
  withEnv(t, { CACHE_ENABLED: undefined, CACHE_HIT_LINE: undefined, CACHE_MAX_ENTRIES: undefined });
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  logStore.insertCacheEntry({
    queryText: '残留条目',
    embeddingB64: 'x',
    answerJson: '{}',
    answerBytes: 2,
    hitCount: 0,
    lastAccessAt: 1,
    createdAt: 1,
    versionTag: 'v1',
  });
  assert.equal(logStore.countCacheEntries(), 1, '先造一条镜像残留');

  // 与 index.ts 同款构造（transport 形状 = CacheEmbeddingClient）
  const cacheManager = new CacheManager({ transport: new FakeEmbedClient(), logStore });
  assert.equal(cacheManager.getStatus().entryCount, 0);
  assert.equal(logStore.countCacheEntries(), 0, '构造即清镜像，防残留展示陈旧数据');
});

test('② env 缺省语义：无 CACHE_* 配置 → 开 / 0.92 / 500（index 装配不传即走构造缺省）', (t) => {
  withEnv(t, { CACHE_ENABLED: undefined, CACHE_HIT_LINE: undefined, CACHE_MAX_ENTRIES: undefined });
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const cacheManager = new CacheManager({ transport: new FakeEmbedClient(), logStore });
  assert.deepEqual(cacheManager.getStatus(), {
    enabled: true,
    hitLine: 0.92,
    maxEntries: 500,
    entryCount: 0,
  });
});

test('③ env 覆盖生效：CACHE_ENABLED=false / CACHE_HIT_LINE=0.9 / CACHE_MAX_ENTRIES=1000；非法值回退默认', (t) => {
  withEnv(t, {
    CACHE_ENABLED: 'false',
    CACHE_HIT_LINE: '0.9',
    CACHE_MAX_ENTRIES: '1000',
  });
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const cacheManager = new CacheManager({ transport: new FakeEmbedClient(), logStore });
  const status = cacheManager.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.hitLine, 0.9);
  assert.equal(status.maxEntries, 1000);

  withEnv(t, { CACHE_HIT_LINE: 'abc', CACHE_MAX_ENTRIES: '1.9' });
  const fallback = new CacheManager({ transport: new FakeEmbedClient(), logStore });
  // 非法 env 值回退默认（解析在 CacheManager 构造内：Number('abc')=NaN → DEFAULT_HIT_LINE=0.92）
  assert.equal(fallback.getStatus().hitLine, 0.92, '非法命中线回退默认 0.92');
});

test('④ 装配闭环：CacheManager → createServer 挂载 /api/v1/cache*（enabled 反射 env，开关即生效）', async (t) => {
  withEnv(t, { CACHE_ENABLED: 'false', CACHE_HIT_LINE: undefined, CACHE_MAX_ENTRIES: undefined });
  const logStore = createLogStore({ dbPath: ':memory:' });
  t.after(() => logStore.close());
  const cacheManager = new CacheManager({ transport: new FakeEmbedClient(), logStore });
  const baseUrl = await startServer(t, logStore, cacheManager);

  const statusRes = await fetch(`${baseUrl}/api/v1/cache/status`);
  const status = (await statusRes.json()) as { data: { enabled: boolean; hitLine: number; entryCount: number } };
  assert.equal(status.data.enabled, false, 'index.ts 注入同一实例，开关初始值反射 env');
  assert.equal(status.data.hitLine, 0.92);
  assert.equal(status.data.entryCount, 0);

  const putRes = await fetch(`${baseUrl}/api/v1/cache/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(putRes.status, 200);
  const after = await fetch(`${baseUrl}/api/v1/cache/status`);
  assert.equal(((await after.json()) as { data: { enabled: boolean } }).data.enabled, true, '运行时开关切换生效');
});
