import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, resolveGap, resolveRadius, resolveStroke, tokenColor, tokenNumber, type DesignNode } from "../src/index";

function node(overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id: "rect:1",
    type: "rectangle",
    name: "色块",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 100 },
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

function documentWithTokens() {
  const document = createDocument("doc:1", "Demo");
  document.tokens = {
    "color.primary": { type: "color", value: "#2563eb" },
    "space.md": { type: "number", value: 16 },
    "radius.card": { type: "number", value: 12 },
    "font.body": { type: "string", value: "Inter" },
  };
  return document;
}

test("resolves typed token values and rejects mismatched types", () => {
  const document = documentWithTokens();
  assert.equal(tokenNumber(document, "space.md"), 16);
  assert.equal(tokenColor(document, "color.primary"), "#2563eb");
  // 类型不匹配不能强行转换。
  assert.equal(tokenNumber(document, "color.primary"), undefined);
  assert.equal(tokenColor(document, "font.body"), undefined);
  assert.equal(tokenNumber(document, "missing"), undefined);
  assert.equal(tokenNumber(document, undefined), undefined);
});

test("radius binding wins over the node value, with fallback when the token is gone", () => {
  const document = documentWithTokens();
  assert.equal(resolveRadius(document, node({ bindings: { radius: "radius.card" } })), 12);
  assert.equal(resolveRadius(document, node({ appearance: { ...defaultAppearance(), cornerRadius: 4 } })), 4);
  // 绑定的 token 被删掉：退回节点自身值，而不是 undefined。
  assert.equal(resolveRadius(document, node({ bindings: { radius: "gone" }, appearance: { ...defaultAppearance(), cornerRadius: 4 } })), 4);
  assert.equal(resolveRadius(document, node()), undefined);
});

test("gap binding drives auto-layout spacing", () => {
  const document = documentWithTokens();
  const stacked = node({ layout: { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 4 }, bindings: { spacing: "space.md" } });
  assert.equal(resolveGap(document, stacked), 16);
  assert.equal(resolveGap(document, node({ layout: { ...defaultLayout(), gap: 4 } })), 4);
  assert.equal(resolveGap(document, node()), 0);
});

test("stroke binding wins over the node value", () => {
  const document = documentWithTokens();
  assert.equal(resolveStroke(document, node({ bindings: { stroke: "color.primary" } })), "#2563eb");
  assert.equal(resolveStroke(document, node({ appearance: { ...defaultAppearance(), stroke: "#000000" } })), "#000000");
  assert.equal(resolveStroke(document, node()), undefined);
});
