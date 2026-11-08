import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * token 变量名在 HTML 和 SVG 里必须是同一个。
 *
 * 曾经这里给 SVG 多补了一个 `--`，于是根变量写成 `----color-primary`，
 * 而节点引用的是 `var(--color-primary)` —— 颜色在 SVG 里静默失效。这条测试
 * 同时锁住"定义"和"引用"两侧。
 */
function documentWithToken() {
  const document = createDocument("project:tokens", "Tokens", "page:1");
  document.tokens = { "color.primary": { type: "color", value: "#2563eb" } };
  document.nodes["rect:1"] = {
    id: "rect:1",
    type: "rectangle",
    name: "色块",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 10, width: 40, height: 40 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#2563eb" }] },
    bindings: { fill: "color.primary" },
  };
  document.pages["page:1"]!.childIds = ["rect:1"];
  return document;
}

test("SVG 与 HTML 用同一个带单前缀的 token 变量名", () => {
  const document = documentWithToken();
  const svg = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 200, height: 200 } }).svg;
  const html = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 200, height: 200 } }).document;

  assert.match(svg, /--color-primary: #2563eb;/);
  assert.match(html, /--color-primary: #2563eb;/);
  // 定义和引用不能各差一个或各多一个前缀。
  assert.doesNotMatch(svg, /----/);
  assert.match(svg, /var\(--color-primary\)/);
  assert.match(html, /var\(--color-primary\)/);
});
