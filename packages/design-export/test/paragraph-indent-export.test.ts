import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, LIST_MARKER_WIDTH, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml } from "../src/index";

/**
 * 段落缩进 / 悬挂列表 / 列表间距的 HTML 导出。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

function documentWithText(content: string, paragraphStyles?: any[], extra: Partial<DesignNode> = {}): DesignDocument {
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
    ...extra,
  } as DesignNode;
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

const VIEWPORT = { width: 400, height: 200 };

test("HTML adds the paragraph indent to the padding of a plain paragraph", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [{ from: 0, to: 2, style: { paragraphIndent: 30 } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, /<p class="design-paragraph" style="padding-left:30px">ab<\/p>/);
});

test("HTML leaves the paragraph indent out for centered text", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [{ from: 0, to: 2, style: { paragraphIndent: 30 } }], { textAlign: "center" }),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  // 居中时画布会把缩进扣掉，HTML 也不能再补 padding。
  assert.match(exported.html, /<p class="design-paragraph">ab<\/p>/);
});

test("HTML stacks the paragraph indent on top of the list padding", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [{ from: 0, to: 2, style: { listType: "bullet", paragraphIndent: 10 } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, new RegExp(`<li style="padding-left:${LIST_MARKER_WIDTH + 10}px">ab</li>`));
});

test("HTML gives a hanging marker no width", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [{ from: 0, to: 2, style: { listType: "bullet", hanging: true } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  // 悬挂列表：标记不占正文宽度 → padding-left 里没有标记区宽度。
  assert.match(exported.html, new RegExp(`<li style="padding-left:0px">ab</li>`));
  // 列表本身仍然是 outside：标记会画到列表框外面。
  assert.match(exported.html, /list-style-position:outside/);
});

test("HTML expresses the list spacing as a margin", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [{ from: 0, to: 2, style: { listSpacing: 12 } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  assert.match(exported.html, /<p class="design-paragraph" style="margin-bottom:12px">ab<\/p>/);
});

test("HTML keeps the old output for a list without the new fields", () => {
  const exported = exportPageToHtml(
    documentWithText("ab", [{ from: 0, to: 2, style: { listType: "bullet" } }]),
    { pageId: "page:1", viewport: VIEWPORT },
  );
  // 旧文档的产物逐字不变：没有 padding 之外的多余声明。
  assert.match(exported.html, new RegExp(`<li style="padding-left:${LIST_MARKER_WIDTH}px">ab</li>`));
});
