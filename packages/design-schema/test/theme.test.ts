import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThemeTokens,
  createDocument,
  defaultAppearance,
  defaultLayout,
  findTheme,
  isTokenOverridden,
  resolveFills,
  themeTokenMap,
  tokenColor,
  tokenTypography,
  validateDocument,
  type DesignDocument,
  type DesignNode,
  type Theme,
} from "../src/index";

/**
 * 主题：token 值的可选覆盖。
 *
 * 主题不改解析规则——进入布局/渲染/导出前把覆盖合并进 token 表（`applyThemeTokens`），
 * 之后别名、字体 token、组件都按普通 token 走。
 */

const baseTokens: DesignDocument["tokens"] = {
  "gray.900": { type: "color", value: "#111111" },
  "text.primary": { type: "alias", value: "gray.900" },
  "space.md": { type: "number", value: 16 },
};

function documentWith(themes?: Theme[]): DesignDocument {
  const document = createDocument("doc:theme", "Theme");
  document.tokens = structuredClone(baseTokens);
  if (themes) document.themes = themes;
  document.nodes["frame:1"] = {
    id: "frame:1",
    type: "frame",
    name: "Card",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ff0000" }] },
    bindings: { fill: "text.primary" },
  };
  document.pages["page:1"]!.childIds = ["frame:1"];
  return document;
}

const dark: Theme = { id: "theme:dark", name: "深色", tokens: { "gray.900": { type: "color", value: "#f5f5f5" } } };

test("theme: 合法主题通过校验", () => {
  const document = documentWith([dark]);
  assert.deepEqual(validateDocument(document), document);
});

test("theme: 没有主题时原样返回同一个对象", () => {
  const document = documentWith();
  assert.equal(applyThemeTokens(document, undefined), document);
  assert.equal(applyThemeTokens(document, "theme:missing"), document);
});

test("theme: 合并覆盖后，别名解析到主题值", () => {
  const document = documentWith([dark]);
  assert.equal(tokenColor(document, "text.primary"), "#111111");
  const themed = applyThemeTokens(document, "theme:dark");
  assert.equal(tokenColor(themed, "text.primary"), "#f5f5f5");
  // 填充也随主题走。
  assert.deepEqual(resolveFills(themed, themed.nodes["frame:1"]!), [{ type: "solid", color: "#f5f5f5" }]);
  // 基础文档没有被修改。
  assert.equal(tokenColor(document, "text.primary"), "#111111");
});

test("theme: 主题可以覆盖成字体 token 并影响文字样式", () => {
  const document = documentWith([
    { id: "theme:type", name: "大字", tokens: { "text.body": { type: "typography", value: { fontFamily: "Serif", fontSize: 40 } } } },
  ]);
  document.tokens["text.body"] = { type: "typography", value: { fontFamily: "Inter", fontSize: 12 } };
  const themed = applyThemeTokens(document, "theme:type");
  assert.deepEqual(tokenTypography(themed, "text.body"), { fontFamily: "Serif", fontSize: 40 });
});

test("theme: themeTokenMap 与 isTokenOverridden 反映覆盖状态", () => {
  const document = documentWith([dark]);
  assert.equal(isTokenOverridden(document, "theme:dark", "gray.900"), true);
  assert.equal(isTokenOverridden(document, "theme:dark", "space.md"), false);
  assert.equal(themeTokenMap(document, "theme:dark")["gray.900"], dark.tokens["gray.900"]);
  assert.equal(findTheme(document, "theme:dark")?.name, "深色");
});

test("theme: 覆盖不存在的 token 会被拒绝（拼错名字要早报）", () => {
  const document = documentWith([{ id: "theme:typo", name: "错字", tokens: { "gray.90": { type: "color", value: "#fff" } } }]);
  assert.throws(() => validateDocument(document), /theme theme:typo overrides missing token gray\.90/);
});

test("theme: 主题 id 必须唯一、名称不能为空", () => {
  const duplicate = documentWith([dark, { ...dark, name: "另一个" }]);
  assert.throws(() => validateDocument(duplicate), /theme ids must be unique/);
  const unnamed = documentWith([{ id: "theme:x", name: "  ", tokens: {} }]);
  assert.throws(() => validateDocument(unnamed), /theme theme:x name cannot be empty/);
});

test("theme: 主题把基础 token 覆盖成别名环时被拒绝", () => {
  const document = documentWith([{ id: "theme:loop", name: "环", tokens: { "gray.900": { type: "alias", value: "text.primary" } } }]);
  // 合并后 text.primary → gray.900 → text.primary。
  assert.throws(() => validateDocument(document), /theme theme:loop token .* cyclic alias chain/);
});

test("theme: 没有主题覆盖的旧文档依然合法", () => {
  const document = documentWith();
  assert.deepEqual(validateDocument(document), document);
});
