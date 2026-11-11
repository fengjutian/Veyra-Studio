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

test("左侧页面与图层使用独立页签", () => {
  assert.match(mainSource, /leftPanelTab.*useState<"pages" \| "layers">\("layers"\)/);
  assert.match(mainSource, /role="tablist" aria-label="左侧面板"/);
  assert.match(mainSource, /leftPanelTab === "pages".*pages-block/s);
  assert.match(mainSource, /leftPanelTab === "layers".*layers-block/s);
});

test("页面和低频图层操作收进菜单", () => {
  assert.match(mainSource, /<ToolbarMenu label="页面操作" icon="more" iconOnly/);
  assert.match(mainSource, /<ToolbarMenu label="更多图层操作" icon="more" iconOnly/);
  assert.match(mainSource, /label: "设置页面主题"/);
  assert.match(mainSource, /label: "置于顶层"/);
});

test("检查器使用卡片分区和统一控件表面", () => {
  const workbenchCss = readFileSync(fileURLToPath(new URL("../src/workbench.css", import.meta.url)), "utf8");
  assert.match(workbenchCss, /--control-surface:/);
  assert.match(workbenchCss, /\.inspector-body > \.inspector-section/);
  assert.match(workbenchCss, /\.inspector select,/);
});

test("AI 工作区按描述、候选、提交三步组织", () => {
  assert.match(mainSource, /className="ai-flow"/);
  assert.match(mainSource, />1 · 描述任务</);
  assert.match(mainSource, /高级：自主运行/);
  assert.match(mainSource, /className="inspector-section ai-advanced-section"/);
});

test("画布背景弱化网格并强化画板边界", () => {
  const workbenchCss = readFileSync(fileURLToPath(new URL("../src/workbench.css", import.meta.url)), "utf8");
  assert.match(workbenchCss, /background-size: 100% 100%, 24px 24px/);
  assert.match(workbenchCss, /outline: 1px solid #ffffff17/);
});

test("画布显示统一反馈条", () => {
  assert.match(mainSource, /<WorkbenchFeedback message=\{message\}/);
  assert.match(mainSource, /onDismiss=\{\(\) => setMessage\("就绪"\)\}/);
});
