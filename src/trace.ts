import { AsyncLocalStorage } from 'node:async_hooks';

type TraceContext = { traceId: string };

const als = new AsyncLocalStorage<TraceContext>();

/** 在 traceId 上下文中执行 fn，供 server.ts 中间件包裹请求处理 */
export function runWithTraceId<T>(traceId: string, fn: () => T): T {
  return als.run({ traceId }, fn);
}

/** 当前请求的 traceId（未在请求上下文内时为 undefined） */
export function getTraceId(): string | undefined {
  return als.getStore()?.traceId;
}