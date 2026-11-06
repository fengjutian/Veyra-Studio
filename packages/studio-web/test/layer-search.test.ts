import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { layerMatches, visibleLayerIds } from "../src/layer-search";

test("matches a layer by name, ignoring case", () => {
  assert.equal(layerMatches(node("frame:a", "Hero Card"), "hero"), true);
  assert.equal(layerMatches(node("frame:a", "Hero Card"), "nope"), false);
});

test("matches a text layer by the text it holds", () => {
  const textNode = { ...node("text:a", "标题"), type: "text" as const, text: "欢迎来到设计编辑器", fontFamily: "Inter", fontSize: 20, lineHeight: 28 };
  assert.equal(layerMatches(textNode, "欢迎"), true);
  assert.equal(layerMatches(textNode, "标题"), true);
});

test("keeps the ancestors of a match visible", () => {
  const document = buildDocument();
  const visible = visibleLayerIds(document, ["frame:a"], "标题");
  assert.deepEqual([...visible].sort(), ["frame:a", "text:a"]);
});

test("hides the layers that do not match", () => {
  const document = buildDocument();
  const visible = visibleLayerIds(document, ["frame:a"], "卡片");
  assert.deepEqual([...visible], ["frame:a"]);
});

test("keeps the whole tree visible without a query", () => {
  const document = buildDocument();
  const visible = visibleLayerIds(document, ["frame:a"], "   ");
  assert.deepEqual([...visible].sort(), ["frame:a", "frame:b", "text:a"]);
});

function node(id: string, name: string): DesignNode {
  return {
    id,
    type: "frame",
    name,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout() },
    appearance: { ...defaultAppearance() },
  };
}

function buildDocument(): DesignDocument {
  const parent = { ...node("frame:a", "卡片组"), childIds: ["frame:b", "text:a"] };
  const child = { ...node("frame:b", "矩形"), parentId: "frame:a" };
  const text = { ...node("text:a", "标题"), type: "text" as const, parentId: "frame:a", text: "欢迎来到设计编辑器", fontFamily: "Inter", fontSize: 20, lineHeight: 28 };
  return {
    schemaVersion: 1,
    id: "doc:1",
    revision: 1,
    meta: { name: "文档", createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z" },
    pageOrder: ["page:1"],
    pages: { "page:1": { id: "page:1", name: "Page 1", childIds: ["frame:a"] } },
    nodes: { "frame:a": parent, "frame:b": child, "text:a": text },
    components: {},
    tokens: {},
    assets: {},
  };
}
