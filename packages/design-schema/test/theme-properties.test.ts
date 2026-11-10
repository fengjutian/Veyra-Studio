import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThemeForPage,
  applyThemeProperties,
  createDocument,
  defaultAppearance,
  defaultLayout,
  themePropertyMap,
  validateDocument,
  type DesignDocument,
  type Theme,
} from "../src/index";

/**
 * 主题的属性覆盖：改节点自己写死的字段（圆角、间距、内边距、字号、不透明度）。
 *
 * 与 token 覆盖分开：token 覆盖改的是「值从哪来」，属性覆盖改的是「节点字段」。
 */

/** 一个带名字与类型的节点。 */
function makeNode(id: string, name: string, type: "frame" | "text"): DesignDocument["nodes"][string] {
  if (type === "text") {
    return {
      id,
      type: "text",
      name,
      parentId: "page:1",
      childIds: [],
      visible: true,
      locked: false,
      layout: defaultLayout(),
      appearance: defaultAppearance(),
      text: "标题",
      fontFamily: "Inter",
      fontSize: 16,
      lineHeight: 20,
    };
  }
  return {
    id,
    type: "frame",
    name,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 4 },
    appearance: { ...defaultAppearance(), cornerRadius: 4 },
  };
}

function documentWith(themes?: Theme[]): DesignDocument {
  const document = createDocument("doc:props", "Props");
  document.nodes["frame:1"] = makeNode("frame:1", "Card", "frame");
  document.nodes["text:1"] = makeNode("text:1", "标题", "text");
  document.pages["page:1"]!.childIds = ["frame:1", "text:1"];
  if (themes) document.themes = themes;
  return document;
}

const dark: Theme = {
  id: "theme:dark",
  name: "深色",
  tokens: {},
  properties: { Card: { cornerRadius: 16, gap: 12 } },
};

test("属性覆盖：圆角、间距被改写，基础文档不受影响", () => {
  const document = documentWith([dark]);
  const themed = applyThemeProperties(document, "theme:dark");
  assert.equal(themed.nodes["frame:1"]!.appearance.cornerRadius, 16);
  assert.equal(themed.nodes["frame:1"]!.layout.gap, 12);
  // 原文档没被动过。
  assert.equal(document.nodes["frame:1"]!.appearance.cornerRadius, 4);
  assert.equal(document.nodes["frame:1"]!.layout.gap, 4);
});

test("属性覆盖：字号只对文本节点生效", () => {
  const document = documentWith([{ id: "theme:t", name: "大字", tokens: {}, properties: { 标题: { fontSize: 32 }, Card: { fontSize: 32 } } }]);
  const themed = applyThemeProperties(document, "theme:t");
  assert.equal((themed.nodes["text:1"] as { fontSize: number }).fontSize, 32);
  // 非文本节点没有字号可改。
  assert.equal((themed.nodes["frame:1"] as { fontSize?: number }).fontSize, undefined);
});

test("属性覆盖：内边距四边一起设，不透明度照设", () => {
  const document = documentWith([{ id: "theme:t", name: "T", tokens: {}, properties: { Card: { padding: 10, opacity: 0.5 } } }]);
  const themed = applyThemeProperties(document, "theme:t");
  assert.deepEqual(themed.nodes["frame:1"]!.layout.padding, { top: 10, right: 10, bottom: 10, left: 10 });
  assert.equal(themed.nodes["frame:1"]!.appearance.opacity, 0.5);
});

test("属性覆盖：绑定了对应 token 的节点不参与", () => {
  const document = documentWith([dark]);
  // 这个节点自己绑了 radius token：它的圆角来自 token，该去改 token 而不是改字段。
  document.nodes["frame:1"]!.bindings = { radius: "space.md" };
  document.tokens["space.md"] = { type: "number", value: 24 };
  const themed = applyThemeProperties(document, "theme:dark");
  assert.equal(themed.nodes["frame:1"]!.appearance.cornerRadius, 4);
  // 没有绑定的间距照旧被覆盖。
  assert.equal(themed.nodes["frame:1"]!.layout.gap, 12);
});

test("属性覆盖：type 可以把范围收窄到某一种节点类型", () => {
  const document = documentWith([{ id: "theme:t", name: "T", tokens: {}, properties: { Card: { type: "text", cornerRadius: 16 } } }]);
  const themed = applyThemeProperties(document, "theme:t");
  // 节点是 frame，与 type: "text" 不符 → 不覆盖。
  assert.equal(themed.nodes["frame:1"]!.appearance.cornerRadius, 4);
});

test("属性覆盖：继承链上逐字段叠加，后代只覆盖自己写的字段", () => {
  const document = documentWith([
    { id: "theme:base", name: "基础", tokens: {}, properties: { Card: { cornerRadius: 8, gap: 6 } } },
    { id: "theme:child", name: "子", extends: "theme:base", tokens: {}, properties: { Card: { gap: 20 } } },
  ]);
  const merged = themePropertyMap(document, "theme:child");
  assert.deepEqual(merged["Card"], { cornerRadius: 8, gap: 20 });
  const themed = applyThemeProperties(document, "theme:child");
  assert.equal(themed.nodes["frame:1"]!.appearance.cornerRadius, 8);
  assert.equal(themed.nodes["frame:1"]!.layout.gap, 20);
});

test("属性覆盖：没有覆盖时原样返回同一个对象", () => {
  const document = documentWith();
  assert.equal(applyThemeProperties(document, undefined), document);
  assert.equal(applyThemeProperties(document, "theme:missing"), document);
});

test("属性覆盖：按页面合并主题时一起生效", () => {
  const document = documentWith([dark]);
  document.pages["page:1"]!.themeId = "theme:dark";
  const themed = applyThemeForPage(document, "page:1");
  assert.equal(themed.nodes["frame:1"]!.appearance.cornerRadius, 16);
});

test("属性覆盖：合法的主题带属性覆盖能通过校验", () => {
  const document = documentWith([dark]);
  assert.deepEqual(validateDocument(document), document);
});

test("属性覆盖：节点名为空串不合法", () => {
  const document = documentWith([{ id: "theme:t", name: "T", tokens: {}, properties: { "": { cornerRadius: 4 } } }]);
  assert.throws(() => validateDocument(document), /empty node name/);
});
