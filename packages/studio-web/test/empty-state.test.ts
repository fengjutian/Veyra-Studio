import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const root = new URL("../src/", import.meta.url);
const main = readFileSync(new URL("main.tsx", root), "utf8");
const layerTree = readFileSync(new URL("layer-tree.tsx", root), "utf8");
const assetPanel = readFileSync(new URL("asset-panel.tsx", root), "utf8");

test("workbench surfaces share the EmptyState primitive", () => {
  for (const title of ["还没有页面", "还没有历史版本", "还没有自动备份", "还没有组件", "还没有候选方案"]) {
    assert.match(main, new RegExp(title));
  }
  assert.match(layerTree, /<EmptyState/);
  assert.match(assetPanel, /<EmptyState/);
});
