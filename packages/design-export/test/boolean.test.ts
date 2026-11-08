import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

function rect(id: string, parentId: string, x: number, y: number, width: number, height: number): DesignNode {
  return {
    id, type: "rectangle", name: id, parentId, childIds: [], visible: true, locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#8b5cf6" }] },
  };
}

function booleanDocument(operation: "union" | "intersect"): DesignDocument {
  const document = createDocument("doc:bool", "Boolean");
  document.nodes["bool"] = {
    id: "bool", type: "boolean", name: "bool", parentId: "page:1", childIds: ["a", "b"],
    visible: true, locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 150, height: 150 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#8b5cf6" }] },
    operation,
  } as DesignNode;
  document.nodes["a"] = rect("a", "bool", 0, 0, 100, 100);
  document.nodes["b"] = rect("b", "bool", 50, 50, 100, 100);
  document.pages["page:1"]!.childIds = ["bool"];
  return document;
}

const VIEWPORT = { width: 400, height: 400 };

test("SVG exports the boolean result as one path, not the operands", () => {
  const result = exportPageToSvg(booleanDocument("union"), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(result.svg, /data-node-id="bool"/);
  assert.match(result.svg, /<path d="M/);
  // 操作数只是运算输入，不应该各自再导出一次。
  assert.doesNotMatch(result.svg, /data-node-id="a"/);
  assert.doesNotMatch(result.svg, /data-node-id="b"/);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.feature === "boolean"), false);
});

test("HTML inlines the boolean path in an svg", () => {
  const result = exportPageToHtml(booleanDocument("union"), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(result.html, /data-node-id="bool"/);
  assert.match(result.html, /<svg viewBox="0 0 150 150"/);
  assert.match(result.html, /<path d="M/);
});

test("an empty boolean result produces a diagnostic instead of a broken path", () => {
  const document = booleanDocument("intersect");
  // 两个不相交的矩形：交集为空。
  document.nodes["b"]!.layout = { ...document.nodes["b"]!.layout, x: 300, y: 300 };
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: VIEWPORT });
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.feature === "boolean"), true);
  // 操作数不会作为普通子节点漏出来。\n  assert.doesNotMatch(result.svg, /data-node-id="a"/);\n  assert.doesNotMatch(result.svg, /data-node-id="b"/);
});
