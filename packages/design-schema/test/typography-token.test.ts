import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTypographyToken,
  createDocument,
  defaultAppearance,
  defaultLayout,
  validateDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

/**
 * 字体（typography）token 的渲染语义。
 *
 * 这是复合 token：绑定到文本节点后覆盖族名/字号/行高/字重/字形/字距，
 * 省略的字段不覆盖节点自身值。
 */

function documentWith(bindings: DesignNode["bindings"], token?: DesignDocument["tokens"][string]): DesignDocument {
  const document = createDocument("doc:typo", "Typography");
  document.tokens = token ? { "text.body": token } : {};
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
    fontWeight: 500,
    ...(bindings ? { bindings } : {}),
  };
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

const bodyToken = {
  type: "typography" as const,
  value: { fontFamily: "Source Serif", fontSize: 32, lineHeight: 40, fontWeight: 700 },
};

test("typography token: 合法声明通过文档校验", () => {
  const document = documentWith({ typography: "text.body" }, bodyToken);
  assert.deepEqual(validateDocument(document), document);
});

test("typography token: 绑定后覆盖文字样式，省略字段保留节点值", () => {
  const document = documentWith({ typography: "text.body" }, { type: "typography", value: { fontFamily: "Source Serif", fontSize: 32 } });
  const applied = applyTypographyToken(document, document.nodes["text:1"]!);
  assert.equal(applied.type, "text");
  if (applied.type !== "text") return;
  assert.equal(applied.fontFamily, "Source Serif");
  assert.equal(applied.fontSize, 32);
  // token 没写行高/字重 → 保留节点自身的值。
  assert.equal(applied.lineHeight, 16);
  assert.equal(applied.fontWeight, 500);
});

test("typography token: 没绑定或绑定失效时原样返回同一个对象", () => {
  const plain = documentWith(undefined, bodyToken);
  assert.equal(applyTypographyToken(plain, plain.nodes["text:1"]!), plain.nodes["text:1"]);

  // 指向不存在的 token：解析失败退回节点自身，不抛错。
  const broken = documentWith({ typography: "text.missing" }, bodyToken);
  const text = applyTypographyToken(broken, broken.nodes["text:1"]!) as Extract<DesignNode, { type: "text" }>;
  assert.equal(text.fontSize, 12);
});

test("typography token: 字号必须为正", () => {
  const document = documentWith({ typography: "text.body" }, { type: "typography", value: { fontFamily: "Inter", fontSize: 0 } });
  assert.throws(() => validateDocument(document), /tokens\.text\.body\.value\.fontSize/);
});

test("typography token: 字重必须在 100–900", () => {
  const document = documentWith({ typography: "text.body" }, { type: "typography", value: { fontFamily: "Inter", fontSize: 14, fontWeight: 50 } });
  assert.throws(() => validateDocument(document), /tokens\.text\.body\.value\.fontWeight/);
});

test("typography token: 不能绑到非文本节点", () => {
  const document = createDocument("doc:typo", "Typography");
  document.tokens = { "text.body": bodyToken };
  document.nodes["frame:1"] = {
    id: "frame:1",
    type: "frame",
    name: "Card",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    bindings: { typography: "text.body" },
  };
  document.pages["page:1"]!.childIds = ["frame:1"];
  assert.throws(() => validateDocument(document), /typography binding requires a text node/);
});

test("typography token: 颜色 token 不能绑成字体", () => {
  const document = documentWith({ typography: "text.body" }, { type: "color", value: "#111111" });
  assert.throws(() => validateDocument(document), /typography binding cannot use color token/);
});
