import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMCPServerConfigs,
  SANGO_SERVER_NAME,
  WEATHER_SERVER_NAME,
} from "../../transport.js";

test("MCP_WEATHER_SCRIPT + MCP_SANGO_SCRIPT：weather 必需、sango 可缺配", () => {
  assert.deepEqual(
    resolveMCPServerConfigs({
      MCP_WEATHER_SCRIPT: "D:/weather/src/index.js",
      MCP_SANGO_SCRIPT: "D:/sango/dist/index.js",
    }),
    [
      { name: WEATHER_SERVER_NAME, scriptPath: "D:/weather/src/index.js", required: true },
      { name: SANGO_SERVER_NAME, scriptPath: "D:/sango/dist/index.js", required: false },
    ]
  );
});

test("缺配 sango：只注册 weather", () => {
  assert.deepEqual(resolveMCPServerConfigs({ MCP_WEATHER_SCRIPT: "w.js" }), [
    { name: WEATHER_SERVER_NAME, scriptPath: "w.js", required: true },
  ]);
});

test("不再兼容旧配置：MCP_SERVER_SCRIPT 不生效（注册表只认 MCP_WEATHER_SCRIPT）", () => {
  assert.deepEqual(resolveMCPServerConfigs({ MCP_SERVER_SCRIPT: "legacy.js" }), []);
});

test("全缺配：注册表为空（weather 未配置 → 启动层应报错退出）", () => {
  assert.deepEqual(resolveMCPServerConfigs({}), []);
});
