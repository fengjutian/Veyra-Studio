import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type TextNode } from "@ufira/design-schema";
import { collectExportFonts } from "../src/font-inline";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 字体 token 的导出。
 *
 * 导出物里不写绑定，只写生效后的具体样式；字体内联也必须按 token 的族名收集，
 * 否则「设计稿用了 token 字体、导出物却没内联它」。
 */

const PAGE_ID = "page:1";
const VIEWPORT = { width: 960, height: 680 };

function typographyDocument(): DesignDocument {
  const document = createDocument("doc:typo", "Typography", PAGE_ID);
  document.tokens = {
    "text.display": { type: "typography", value: { fontFamily: "Source Serif", fontSize: 32, lineHeight: 40, fontWeight: 700 } },
  };
  const node: TextNode = {
    id: "text:1",
    type: "text",
    name: "Title",
    parentId: PAGE_ID,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 400, height: 60 },
    appearance: defaultAppearance(),
    text: "Hello",
    fontFamily: "Inter",
    fontSize: 12,
    lineHeight: 16,
    bindings: { typography: "text.display" },
  };
  document.nodes[node.id] = node;
  document.pages[PAGE_ID]!.childIds = [node.id];
  return document;
}

test("typography token: HTML 导出写 token 生效后的字体与字号", () => {
  const html = exportPageToHtml(typographyDocument(), { pageId: PAGE_ID, viewport: VIEWPORT }).html;
  assert.match(html, /font-family:&quot;?Source Serif/);
  assert.match(html, /font-size:32px/);
  assert.match(html, /line-height:40px/);
  assert.match(html, /font-weight:700/);
  assert.doesNotMatch(html, /font-size:12px/);
});

test("typography token: SVG 导出写 token 生效后的字号", () => {
  const svg = exportPageToSvg(typographyDocument(), { pageId: PAGE_ID, viewport: VIEWPORT }).svg;
  assert.match(svg, /font-size:32/);
  assert.match(svg, /font-family:&quot;?Source Serif|font-family:Source Serif/);
});

test("typography token: 字体收集按 token 的族名与字重", () => {
  const fonts = collectExportFonts(typographyDocument(), { pageId: PAGE_ID });
  assert.deepEqual(fonts, [{ family: "Source Serif", weight: 700, style: "normal" }]);
});

test("typography token: 没有绑定的文档导出结果不变", () => {
  const document = typographyDocument();
  delete document.nodes["text:1"]!.bindings;
  const html = exportPageToHtml(document, { pageId: PAGE_ID, viewport: VIEWPORT }).html;
  assert.match(html, /font-size:12px/);
  assert.match(html, /font-family:&quot;Inter&quot;/);
});
