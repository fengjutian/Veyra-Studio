import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, validateDocument } from "../src/index";

test("creates a valid empty document", () => {
  const document = createDocument("doc:1", "Demo");
  assert.deepEqual(validateDocument(document), document);
});

test("rejects orphan nodes", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Orphan",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  assert.throws(() => validateDocument(document), /orphaned/);
});

test("rejects missing and type-incompatible token bindings", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Bound",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    bindings: { fill: "spacing.large" },
  };
  document.pages["page:1"].childIds.push("node:1");
  document.tokens["spacing.large"] = { type: "number", value: 24 };
  assert.throws(() => validateDocument(document), /fill binding cannot use number token/);
});

test("rejects children on leaf nodes", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes.parent = {
    id: "parent",
    type: "text",
    name: "Text",
    parentId: "page:1",
    childIds: ["child"],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "Parent",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  };
  document.nodes.child = {
    id: "child",
    type: "rectangle",
    name: "Child",
    parentId: "parent",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  document.pages["page:1"].childIds = ["parent"];
  assert.throws(() => validateDocument(document), /text cannot contain children/);
});

test("accepts the optional text style fields", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes["text:1"] = {
    id: "text:1",
    type: "text",
    name: "Text",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "Hi",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 700,
    fontStyle: "italic",
    textAlign: "center",
    letterSpacing: 2,
  };
  document.pages["page:1"].childIds = ["text:1"];
  assert.deepEqual(validateDocument(document), document);
});

test("rejects invalid text style values", () => {
  const base = {
    id: "text:1",
    type: "text" as const,
    name: "Text",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "Hi",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  };
  for (const [field, value] of [["fontWeight", 95], ["fontStyle", "oblique"], ["textAlign", "justify"], ["letterSpacing", Number.NaN]] as const) {
    const document = createDocument("doc:1", "Demo");
    document.nodes["text:1"] = { ...base, [field]: value } as never;
    document.pages["page:1"].childIds = ["text:1"];
    assert.throws(() => validateDocument(document), new RegExp(field));
  }
});

test("only frames or components can be slots", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes["text:1"] = {
    id: "text:1",
    type: "text",
    name: "文字",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "x",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    slot: true,
  } as never;
  document.pages["page:1"]!.childIds = ["text:1"];
  assert.throws(() => validateDocument(document), /cannot be a slot/);
});

test("accepts four-value corner radii and rejects malformed tuples", () => {
  const make = (cornerRadii: unknown) => {
    const document = createDocument("doc:1", "Demo");
    document.nodes["node:1"] = {
      id: "node:1",
      type: "rectangle",
      name: "Card",
      parentId: "page:1",
      childIds: [],
      visible: true,
      locked: false,
      layout: defaultLayout(),
      appearance: { ...defaultAppearance(), cornerRadii: cornerRadii as [number, number, number, number] },
    };
    document.pages["page:1"]!.childIds = ["node:1"];
    return document;
  };
  assert.ok(validateDocument(make([4, 8, 12, 16])));
  assert.throws(() => validateDocument(make([4, 8, 12])), /cornerRadii/);
  assert.throws(() => validateDocument(make([4, -1, 12, 16])), /cornerRadii/);
});
test("validates paint layers", () => {
  const make = (fills: unknown) => {
    const document = createDocument("doc:1", "Demo");
    document.nodes["node:1"] = {
      id: "node:1",
      type: "rectangle",
      name: "Card",
      parentId: "page:1",
      childIds: [],
      visible: true,
      locked: false,
      layout: defaultLayout(),
      appearance: { ...defaultAppearance(), fills: fills as never },
    };
    document.pages["page:1"]!.childIds = ["node:1"];
    return document;
  };
  assert.ok(validateDocument(make([{ type: "solid", color: "#fff" }])));
  assert.ok(validateDocument(make([{ type: "linear", angle: 45, stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }] }])));
  // 少于两个色标画不出渐变；offset 超出 [0,1] 也不合法。
  assert.throws(() => validateDocument(make([{ type: "linear", angle: 45, stops: [{ offset: 0, color: "#fff" }] }])), /fills/);
  assert.throws(() => validateDocument(make([{ type: "linear", angle: 45, stops: [{ offset: 2, color: "#fff" }, { offset: 1, color: "#000" }] }])), /fills/);
});
test("validates radial paints", () => {
  const make = (fills: unknown) => {
    const document = createDocument("doc:1", "Demo");
    document.nodes["node:1"] = {
      id: "node:1",
      type: "rectangle",
      name: "Card",
      parentId: "page:1",
      childIds: [],
      visible: true,
      locked: false,
      layout: defaultLayout(),
      appearance: { ...defaultAppearance(), fills: fills as never },
    };
    document.pages["page:1"]!.childIds = ["node:1"];
    return document;
  };
  const stops = [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }];
  assert.ok(validateDocument(make([{ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops }])));
  // 半径必须为正：0 画不出任何东西。
  assert.throws(() => validateDocument(make([{ type: "radial", cx: 0.5, cy: 0.5, r: 0, stops }])), /fills/);
});