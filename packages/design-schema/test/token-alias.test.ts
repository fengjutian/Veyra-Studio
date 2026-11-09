import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTypographyToken,
  createDocument,
  defaultAppearance,
  defaultLayout,
  resolveTokenTarget,
  tokenColor,
  tokenNumber,
  tokenTypography,
  validateDocument,
  type DesignDocument,
  type DesignNode,
  type TokenValue,
} from "../src/index";

/**
 * 别名（alias）token。
 *
 * 语义分层：`text.primary` → `gray.900`。解析沿链取最终值，断链与环在文档校验阶段拒绝。
 */

function documentWithTokens(tokens: Record<string, TokenValue>): DesignDocument {
  const document = createDocument("doc:alias", "Alias");
  document.tokens = tokens;
  return document;
}

function withTextNode(document: DesignDocument, bindings?: DesignNode["bindings"]): DesignDocument {
  const node: DesignNode = {
    id: "text:1",
    type: "text",
    name: "Body",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "Hello",
    fontFamily: "Inter",
    fontSize: 12,
    lineHeight: 16,
    ...(bindings ? { bindings } : {}),
  };
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

test("alias: 解析到最终值，支持多级链", () => {
  const document = documentWithTokens({
    "gray.900": { type: "color", value: "#111111" },
    "text.primary": { type: "alias", value: "gray.900" },
    "text.body": { type: "alias", value: "text.primary" },
    "space.md": { type: "number", value: 16 },
    "space.gutter": { type: "alias", value: "space.md" },
  });
  assert.equal(tokenColor(document, "text.body"), "#111111");
  assert.equal(tokenNumber(document, "space.gutter"), 16);
  assert.equal(resolveTokenTarget(document, "text.body")?.name, "gray.900");
});

test("alias: 断链与环解析成 undefined，不抛错", () => {
  const broken = documentWithTokens({ "a": { type: "alias", value: "missing" } });
  assert.equal(resolveTokenTarget(broken, "a"), undefined);
  assert.equal(tokenColor(broken, "a"), undefined);

  const cyclic = documentWithTokens({
    "a": { type: "alias", value: "b" },
    "b": { type: "alias", value: "a" },
  });
  assert.equal(resolveTokenTarget(cyclic, "a"), undefined);
  assert.throws(() => validateDocument(cyclic), /cyclic alias chain/);
});

test("alias: 指向不存在的 token 会被文档校验拒绝", () => {
  const document = documentWithTokens({ "a": { type: "alias", value: "missing" } });
  assert.throws(() => validateDocument(document), /token a alias references missing token missing/);
});

test("alias: 自引用被拒绝", () => {
  const document = documentWithTokens({ "a": { type: "alias", value: "a" } });
  assert.throws(() => validateDocument(document), /cyclic alias chain/);
});

test("alias: 绑定按最终类型判定——颜色别名可以绑填充", () => {
  const document = withTextNode(documentWithTokens({
    "gray.900": { type: "color", value: "#111111" },
    "text.primary": { type: "alias", value: "gray.900" },
  }), { fill: "text.primary" });
  assert.deepEqual(validateDocument(document), document);
});

test("alias: 最终类型不匹配时绑定被拒绝", () => {
  const document = withTextNode(documentWithTokens({
    "space.md": { type: "number", value: 16 },
    "space.gutter": { type: "alias", value: "space.md" },
  }), { fill: "space.gutter" });
  assert.throws(() => validateDocument(document), /fill binding cannot use number token/);
});

test("alias: 指向字体 token 的别名仍然覆盖文字样式", () => {
  const document = withTextNode(documentWithTokens({
    "text.display": { type: "typography", value: { fontFamily: "Serif", fontSize: 40 } },
    "heading.base": { type: "alias", value: "text.display" },
  }), { typography: "heading.base" });

  assert.deepEqual(validateDocument(document), document);
  const applied = applyTypographyToken(document, document.nodes["text:1"]!) as Extract<DesignNode, { type: "text" }>;
  assert.equal(applied.fontSize, 40);
  assert.equal(applied.fontFamily, "Serif");
  assert.equal(tokenTypography(document, "heading.base")?.fontSize, 40);
});

test("alias: 字面量 token 的旧文档不受影响", () => {
  const document = documentWithTokens({ "color.primary": { type: "color", value: "#3366ff" } });
  assert.deepEqual(validateDocument(document), document);
  assert.equal(tokenColor(document, "color.primary"), "#3366ff");
});
