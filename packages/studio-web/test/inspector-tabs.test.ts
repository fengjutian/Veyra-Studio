import assert from "node:assert/strict";
import test from "node:test";
import { inspectorTabs, type InspectorTabInput } from "../src/inspector-tabs";

function input(overrides: Partial<InspectorTabInput> = {}): InspectorTabInput {
  return {
    selectionCount: 0,
    exportScope: "page",
    revision: 7,
    assetCount: 0,
    componentCount: 0,
    diagnosticCount: 0,
    warningCount: 0,
    missingAssetCount: 0,
    ...overrides,
  };
}

test("分段固定为属性、导出、历史、数据、AI、设置六页", () => {
  assert.deepEqual(inspectorTabs(input()).map(tab => [tab.id, tab.label]), [
    ["properties", "属性"],
    ["export", "导出"],
    ["history", "历史"],
    ["data", "数据"],
    ["ai", "AI"],
    ["settings", "设置"],
  ]);
});

test("标题上下文跟着选中状态变化", () => {
  assert.equal(inspectorTabs(input())[0]?.meta, "未选中");
  assert.equal(inspectorTabs(input({ selectionCount: 1, selectedName: "卡片" }))[0]?.meta, "卡片");
  assert.equal(inspectorTabs(input({ selectionCount: 1 }))[0]?.meta, "未命名节点");
  assert.equal(inspectorTabs(input({ selectionCount: 3, selectedName: "卡片" }))[0]?.meta, "已选 3 个");
});

test("导出分段说明范围和当前版本", () => {
  const tabs = inspectorTabs(input({ exportScope: "selection", revision: 12 }));
  assert.equal(tabs[1]?.meta, "导出选区");
  assert.equal(tabs[2]?.meta, "当前 r12");
});

test("数据分段汇总资源与组件，AI 分段显示模型名或演示规划器", () => {
  const tabs = inspectorTabs(input({ assetCount: 2, componentCount: 3 }));
  assert.equal(tabs[3]?.meta, "2 资源 · 3 组件");
  assert.equal(tabs[4]?.meta, "演示规划器");
  assert.equal(inspectorTabs(input({ aiModel: "gpt-4o-mini" }))[4]?.meta, "gpt-4o-mini");
});

test("只有需要处理的条目才带角标，0 不显示", () => {
  assert.deepEqual(inspectorTabs(input()).map(tab => tab.badge), [undefined, undefined, undefined, undefined, undefined, undefined]);
  const tabs = inspectorTabs(input({ warningCount: 2, diagnosticCount: 4, missingAssetCount: 1 }));
  assert.equal(tabs[0]?.badge, 2);
  assert.equal(tabs[1]?.badge, 4);
  assert.equal(tabs[2]?.badge, undefined);
  assert.equal(tabs[3]?.badge, 1);
});
