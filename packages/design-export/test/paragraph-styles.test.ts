import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, LIST_INDENT_STEP, LIST_MARKER_WIDTH, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 段落样式（列表 + 缩进）的导出。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

function documentWithText(content: string, paragraphStyles?: any[]): DesignDocument {
  const document = createDocument("doc:list", "列表");
  const node = {
    id: "text:1",
    type: "text",
    name: "text:1",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 10, width: 200, height: 40 },
    appearance: defaultAppearance(),
    text: content,
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...(paragraphStyles ? { paragraphStyles } : {}),
  } as DesignNode;
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

const VIEWPORT = { width: 400, height: 200 };

test("HTML keeps the old output for text without paragraph styles", () => {
  const exported = exportPageToHtml(documentWithText("a\nb"), { pageId: "page:1", viewport: VIEWPORT });
  // 没有段落样式时仍然是单个 <p>：旧文档的产物逐字不变。
  assert.match(exported.html, /<p [^>]*>a\s+b<\/p>/);
  assert.doesNotMatch(exported.html, /<ul|<ol/);
});

test("HTML renders bullet paragraphs as a real list", () => {
  const exported = exportPageToHtml(
    documentWithText("a\nb", [{ from: 0, to: 1, style: { listType: "bullet" } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, /<ul class="design-list"[^>]*><li style="padding-left:20px">a<\/li><\/ul>/);
  // 普通段落仍然是 <p>。
  assert.match(exported.html, /<p class="design-paragraph">b<\/p>/);
});

test("HTML renders ordered paragraphs with the computed number", () => {
  const exported = exportPageToHtml(
    documentWithText("a\nb", [{ from: 0, to: 3, style: { listType: "ordered" } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, /<ol class="design-list"[^>]*>/);
  // 编号显式给值，与画布一致（两段连续的编号列表是 1. / 2.）。
  assert.match(exported.html, /<li value="1" style="padding-left:20px;list-style-type:decimal">a<\/li>/);
  assert.match(exported.html, /<li value="2" style="padding-left:20px;list-style-type:decimal">b<\/li>/);
});

test("HTML indents the list item by the level", () => {
  const exported = exportPageToHtml(
    documentWithText("a", [{ from: 0, to: 1, style: { listType: "bullet", indent: 2 } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  const padding = 2 * LIST_INDENT_STEP + LIST_MARKER_WIDTH;
  assert.match(exported.html, new RegExp(`<li style="padding-left:${padding}px">a</li>`));
});

test("HTML uses the letter format on the second level", () => {
  const exported = exportPageToHtml(
    documentWithText("a", [{ from: 0, to: 1, style: { listType: "ordered", indent: 1 } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, /list-style-type:lower-alpha/);
});

test("HTML keeps the run styles inside a list item", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [
      { from: 0, to: 2, style: { listType: "bullet" } },
    ]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, /<li style="padding-left:20px">ab<\/li>/);
});

test("SVG keeps the old output for text without paragraph styles", () => {
  const exported = exportPageToSvg(documentWithText("a\nb"), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(exported.svg, /<text [^>]*>a\s+b<\/text>/);
  assert.doesNotMatch(exported.svg, /text-anchor="end"/);
});

test("SVG draws the marker in its own text element", () => {
  const exported = exportPageToSvg(
    documentWithText("a", [{ from: 0, to: 1, style: { listType: "bullet" } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  // 标记右对齐在正文左侧一个间隙处。
  assert.match(exported.svg, /<text x="26" y="10" dominant-baseline="hanging" text-anchor="end">•<\/text>/);
  // 正文按缩进右移。
  assert.match(exported.svg, /<text x="30" y="10" dominant-baseline="hanging">a<\/text>/);
});

test("SVG draws the number of an ordered list", () => {
  const exported = exportPageToSvg(
    documentWithText("a\nb", [{ from: 0, to: 3, style: { listType: "ordered" } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.svg, /text-anchor="end">1\.<\/text>/);
  assert.match(exported.svg, /text-anchor="end">2\.<\/text>/);
});

test("the support matrix reports the paragraph styles as exact", () => {
  const exported = exportPageToHtml(
    documentWithText("a", [{ from: 0, to: 1, style: { listType: "bullet" } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.equal(exported.diagnostics.some(diagnostic => diagnostic.feature === "paragraph-styles"), false);
});
