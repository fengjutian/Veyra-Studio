import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainSource = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");

test("顶栏把项目与导出操作收进菜单", () => {
  assert.match(mainSource, /<ToolbarMenu label="项目菜单"/);
  assert.match(mainSource, /<ToolbarMenu label="导出与导入"/);
  assert.match(mainSource, /label: "删除当前项目"/);
  assert.match(mainSource, /label: "导出 PNG"/);
});

test("右侧主导航保持四个高频入口", () => {
  assert.match(mainSource, /tab\.id !== "export" && tab\.id !== "settings"/);
  assert.match(mainSource, /aria-label="打开导出面板"/);
  assert.match(mainSource, /aria-label="打开设置面板"/);
});

test("AI 工作区打开时不再重复显示画布命令条", () => {
  assert.match(mainSource, /!\(rightPanelOpen && inspectorTab === "ai"\)/);
});
