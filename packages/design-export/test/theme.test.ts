import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 导出时的主题选择。
 *
 * 主题在导出入口合并进 token 表：产物里写的是**该主题生效后**的颜色，
 * 而不是基础值或绑定表达式。
 */

const PAGE_ID = "page:1";
const VIEWPORT = { width: 960, height: 680 };

function themedDocument(): DesignDocument {
  const document = createDocument("doc:theme", "Theme", PAGE_ID);
  document.tokens = {
    "brand.primary": { type: "color", value: "#3366ff" },
    "text.on-brand": { type: "alias", value: "brand.primary" },
  };
  document.themes = [
    { id: "theme:dark", name: "深色", tokens: { "brand.primary": { type: "color", value: "#ff6600" } } },
  ];
  const node: DesignNode = {
    id: "frame:1",
    type: "frame",
    name: "Card",
    parentId: PAGE_ID,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 200, height: 100 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#000000" }] },
    bindings: { fill: "text.on-brand" },
  };
  document.nodes[node.id] = node;
  document.pages[PAGE_ID]!.childIds = [node.id];
  return document;
}

test("theme: 不传 themeId 时 HTML 用基础 token", () => {
  const result = exportPageToHtml(themedDocument(), { pageId: PAGE_ID, viewport: VIEWPORT });
  // 绑定了 token 的填充写成 CSS 变量，值在 `:root` 里。
  assert.match(result.css, /#3366ff/);
  assert.doesNotMatch(result.css, /#ff6600/);
});

test("theme: 传 themeId 时 HTML 用主题覆盖值（别名也跟着走）", () => {
  const result = exportPageToHtml(themedDocument(), { pageId: PAGE_ID, viewport: VIEWPORT, themeId: "theme:dark" });
  assert.match(result.css, /#ff6600/);
  assert.doesNotMatch(result.css, /#3366ff/);
});

test("theme: SVG 导出同样支持主题选择", () => {
  const result = exportPageToSvg(themedDocument(), { pageId: PAGE_ID, viewport: VIEWPORT, themeId: "theme:dark" });
  assert.match(result.svg, /#ff6600/);
});

test("theme: 不存在的 themeId 等价于基础值，不报错", () => {
  const result = exportPageToHtml(themedDocument(), { pageId: PAGE_ID, viewport: VIEWPORT, themeId: "theme:missing" });
  assert.match(result.css, /#3366ff/);
});
