import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainSource = readFileSync(fileURLToPath(new URL("../src/main.tsx", import.meta.url)), "utf8");

test("顶栏提供 AI 一级入口并打开右侧 AI 工作区", () => {
  assert.match(mainSource, /aria-label="打开 AI 设计工作区"/);
  assert.match(mainSource, /setRightPanelOpen\(true\); setInspectorTab\("ai"\)/);
  assert.match(mainSource, /rightPanelOpen && inspectorTab === "ai"/);
});
