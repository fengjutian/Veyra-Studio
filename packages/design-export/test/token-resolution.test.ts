import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 数值 token（圆角、间距）与颜色 token（描边）都要在导出里生效。
 *
 * 这些字段过去只是"schema 里能写"，导出器并不读；现在统一走
 * `resolveRadius` / `resolveGap` / `resolveStroke`，画布和导出不会各算一套。
 */
function documentWithBoundNode(): DesignDocument {
  const document = createDocument("doc:1", "Tokens", "page:1");
  document.tokens = {
    "color.primary": { type: "color", value: "#2563eb" },
    "radius.card": { type: "number", value: 12 },
  };
  const node: DesignNode = {
    id: "rect:1",
    type: "rectangle",
    name: "色块",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 10, width: 80, height: 40 },
    appearance: defaultAppearance(),
    bindings: { radius: "radius.card", stroke: "color.primary" },
  };
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

test("HTML resolves radius and stroke tokens", () => {
  const html = exportPageToHtml(documentWithBoundNode(), { pageId: "page:1", viewport: { width: 400, height: 300 } }).document;
  assert.match(html, /border-radius:12px/);
  assert.match(html, /border:1px solid var\(--color-primary\)/);
});

test("SVG resolves radius and stroke tokens", () => {
  const svg = exportPageToSvg(documentWithBoundNode(), { pageId: "page:1", viewport: { width: 400, height: 300 } }).svg;
  assert.match(svg, /rx="12"/);
  assert.match(svg, /stroke:var\(--color-primary\)/);
});

test("HTML applies the spacing token to stack gap", () => {
  const document = createDocument("doc:1", "Tokens", "page:1");
  document.tokens = { "space.md": { type: "number", value: 24 } };
  const root: DesignNode = {
    id: "frame:root",
    type: "frame",
    name: "列表",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), mode: "stack", direction: "vertical", x: 0, y: 0, width: 200, height: 160, gap: 4 },
    appearance: defaultAppearance(),
    bindings: { spacing: "space.md" },
  };
  const child: DesignNode = {
    id: "rect:child",
    type: "rectangle",
    name: "子项",
    parentId: "frame:root",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 20 },
    appearance: defaultAppearance(),
  };
  root.childIds = [child.id];
  document.nodes[root.id] = root;
  document.nodes[child.id] = child;
  document.pages["page:1"]!.childIds = [root.id];

  const html = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 400, height: 300 } }).document;
  // 声明里的 gap 4 被 token 的 24 覆盖。
  assert.match(html, /gap:24px/);
  assert.doesNotMatch(html, /gap:4px/);
});
