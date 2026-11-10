import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThemeForPage,
  applyThemeTokens,
  createDocument,
  defaultAppearance,
  defaultLayout,
  findTheme,
  inheritedTokenSource,
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

// ── 主题继承（2026-11-10）────────────────────────────────────────────

const brand: Theme = { id: "theme:brand", name: "品牌色", tokens: { "gray.900": { type: "color", value: "#ff6600" } } };

test("theme: 子主题继承父主题的覆盖", () => {
  const document = documentWith([brand, { id: "theme:child", name: "深色", extends: "theme:brand", tokens: {} }]);
  const themed = applyThemeTokens(document, "theme:child");
  assert.equal(tokenColor(themed, "text.primary"), "#ff6600");
});

test("theme: 子主题自己的覆盖盖过父主题", () => {
  const document = documentWith([
    brand,
    { id: "theme:child", name: "深色", extends: "theme:brand", tokens: { "gray.900": { type: "color", value: "#f5f5f5" } } },
  ]);
  const themed = applyThemeTokens(document, "theme:child");
  assert.equal(tokenColor(themed, "text.primary"), "#f5f5f5");
  // 父主题不受影响。
  assert.equal(tokenColor(applyThemeTokens(document, "theme:brand"), "text.primary"), "#ff6600");
});

test("theme: 继承链多层叠加，祖先先后代后", () => {
  const document = documentWith([
    { id: "theme:a", name: "A", tokens: { "gray.900": { type: "color", value: "#111111" }, "space.md": { type: "number", value: 8 } } },
    { id: "theme:b", name: "B", extends: "theme:a", tokens: { "gray.900": { type: "color", value: "#222222" } } },
    { id: "theme:c", name: "C", extends: "theme:b", tokens: {} },
  ]);
  const map = themeTokenMap(document, "theme:c");
  // B 盖掉了 A 的颜色；A 的数值没被覆盖，沿用 A 的值。
  assert.deepEqual(map["gray.900"], { type: "color", value: "#222222" });
  assert.deepEqual(map["space.md"], { type: "number", value: 8 });
});

test("theme: 继承链成环会被拒绝", () => {
  const document = documentWith([
    { id: "theme:a", name: "A", extends: "theme:b", tokens: {} },
    { id: "theme:b", name: "B", extends: "theme:a", tokens: {} },
  ]);
  assert.throws(() => validateDocument(document), /cyclic extends chain/);
});

test("theme: 继承不存在的父主题会被拒绝", () => {
  const document = documentWith([{ id: "theme:child", name: "子", extends: "theme:missing", tokens: {} }]);
  assert.throws(() => validateDocument(document), /extends missing theme theme:missing/);
});

test("theme: 自己写的覆盖与继承来的覆盖分得清", () => {
  const document = documentWith([
    brand,
    { id: "theme:child", name: "深色", extends: "theme:brand", tokens: { "space.md": { type: "number", value: 24 } } },
  ]);
  // 自己覆盖的：可以「恢复基础值」。
  assert.equal(isTokenOverridden(document, "theme:child", "space.md"), true);
  // 继承来的：不是自己写的。
  assert.equal(isTokenOverridden(document, "theme:child", "gray.900"), false);
  // 但要说得出它从哪来。
  assert.equal(inheritedTokenSource(document, "theme:child", "gray.900")?.id, "theme:brand");
  assert.equal(inheritedTokenSource(document, "theme:child", "space.md")?.id, "theme:child");
  assert.equal(inheritedTokenSource(document, "theme:child", "text.primary"), undefined);
});

// ── 按页面切换主题（2026-11-10）──────────────────────────────────────

test("theme: 页面自带的主题在导出时生效", () => {
  const document = documentWith([dark]);
  document.pages["page:1"]!.themeId = "theme:dark";
  assert.equal(tokenColor(applyThemeForPage(document, "page:1"), "text.primary"), "#f5f5f5");
  // 别的页没有指定主题 → 基础值。
  document.pages["page:2"] = { id: "page:2", name: "第二页", childIds: [] };
  assert.equal(tokenColor(applyThemeForPage(document, "page:2"), "text.primary"), "#111111");
});

test("theme: 显式指定的主题盖过页面自带的主题", () => {
  const document = documentWith([dark, brand]);
  document.pages["page:1"]!.themeId = "theme:dark";
  // 显式选品牌色 → 品牌色赢（导出时用户说了算）。
  assert.equal(tokenColor(applyThemeForPage(document, "page:1", "theme:brand"), "text.primary"), "#ff6600");
  // 显式选暗色 → 暗色赢。
  assert.equal(tokenColor(applyThemeForPage(document, "page:1", "theme:dark"), "text.primary"), "#f5f5f5");
});

test("theme: 页面指向不存在的主题会被拒绝", () => {
  const document = documentWith([dark]);
  document.pages["page:1"]!.themeId = "theme:missing";
  assert.throws(() => validateDocument(document), /page page:1 references missing theme theme:missing/);
});
