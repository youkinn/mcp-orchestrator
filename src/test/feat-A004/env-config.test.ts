import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMCPServerConfigs,
  SANGO_SERVER_NAME,
  FENGYUNSANGUO_SERVER_NAME,
} from "../../transport.js";

test("MCP_SANGO_SCRIPT + MCP_FENGYUNSANGUO_SCRIPT：sango 与 fengyunsanguo 可缺配，残留 MCP_WEATHER_SCRIPT 忽略不注册", () => {
  assert.deepEqual(
    resolveMCPServerConfigs({
      MCP_WEATHER_SCRIPT: "D:/weather/src/index.js",
      MCP_SANGO_SCRIPT: "D:/sango/dist/index.js",
      MCP_FENGYUNSANGUO_SCRIPT: "D:/fengyunsanguo/dist/index.js",
    }),
    [
      { name: SANGO_SERVER_NAME, scriptPath: "D:/sango/dist/index.js", required: false },
      { name: FENGYUNSANGUO_SERVER_NAME, scriptPath: "D:/fengyunsanguo/dist/index.js", required: false },
    ]
  );
});

test("缺配 fengyunsanguo：只注册 sango（残留 MCP_WEATHER_SCRIPT 忽略）", () => {
  assert.deepEqual(
    resolveMCPServerConfigs({
      MCP_WEATHER_SCRIPT: "w.js",
      MCP_SANGO_SCRIPT: "s.js",
    }),
    [
      { name: SANGO_SERVER_NAME, scriptPath: "s.js", required: false },
    ]
  );
});

test("只配 MCP_WEATHER_SCRIPT：weather 已下线直接忽略，注册表为空（不再必需校验）", () => {
  assert.deepEqual(resolveMCPServerConfigs({ MCP_WEATHER_SCRIPT: "w.js" }), []);
});

test("不再兼容旧配置：MCP_SERVER_SCRIPT 不生效（注册表只认 MCP_SANGO_SCRIPT / MCP_FENGYUNSANGUO_SCRIPT）", () => {
  assert.deepEqual(resolveMCPServerConfigs({ MCP_SERVER_SCRIPT: "legacy.js" }), []);
});

test("全缺配：注册表为空（无必需 server，启动层不再 exit）", () => {
  assert.deepEqual(resolveMCPServerConfigs({}), []);
});
