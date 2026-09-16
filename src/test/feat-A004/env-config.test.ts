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

test("旧配置兼容：MCP_SERVER_SCRIPT 兜底为 weather", () => {
  assert.deepEqual(resolveMCPServerConfigs({ MCP_SERVER_SCRIPT: "legacy.js" }), [
    { name: WEATHER_SERVER_NAME, scriptPath: "legacy.js", required: true },
  ]);
});

test("旧配置兼容：CLI 第 2 参 process.argv[2] 兜底为 weather", () => {
  assert.deepEqual(
    resolveMCPServerConfigs({}, ["node", "build/cli.js", "argv-script.js"]),
    [{ name: WEATHER_SERVER_NAME, scriptPath: "argv-script.js", required: true }]
  );
});

test("新变量优先于旧配置（MCP_WEATHER_SCRIPT > MCP_SERVER_SCRIPT > argv[2]）", () => {
  assert.deepEqual(
    resolveMCPServerConfigs(
      { MCP_WEATHER_SCRIPT: "new.js", MCP_SERVER_SCRIPT: "legacy.js" },
      ["node", "cli.js", "argv.js"]
    ),
    [{ name: WEATHER_SERVER_NAME, scriptPath: "new.js", required: true }]
  );
});

test("全缺配：注册表为空（weather 未配置 → 启动层应报错退出）", () => {
  assert.deepEqual(resolveMCPServerConfigs({}), []);
});
