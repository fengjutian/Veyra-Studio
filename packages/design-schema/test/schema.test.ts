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

test("grid layout requires a track configuration", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Grid",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), mode: "grid" },
    appearance: defaultAppearance(),
  } as never;
  document.pages["page:1"]!.childIds = ["node:1"];
  // 没有轨道就没有格子可放——写入时就该被拒绝。
  assert.throws(() => validateDocument(document), /grid configuration/i);
});

test("grid configuration is rejected on a non-grid layout", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Grid",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: {
      ...defaultLayout(),
      mode: "absolute",
      grid: { columns: [{ type: "auto" }], rows: [{ type: "auto" }], columnGap: 0, rowGap: 0 },
    },
    appearance: defaultAppearance(),
  } as never;
  document.pages["page:1"]!.childIds = ["node:1"];
  // 留着 grid 配置会让「这个容器到底怎么排版」变得含糊。
  assert.throws(() => validateDocument(document), /only allowed on grid layouts/i);
});

test("accepts a valid grid layout", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Grid",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: {
      ...defaultLayout(),
      mode: "grid",
      grid: {
        columns: [{ type: "fixed", size: 100 }, { type: "fraction", weight: 1 }],
        rows: [{ type: "auto" }],
        columnGap: 8,
        rowGap: 0,
        cells: { "node:2": { row: 1, column: 2, rowSpan: 1, columnSpan: 1 } },
      },
    },
    appearance: defaultAppearance(),
  } as never;
  document.pages["page:1"]!.childIds = ["node:1"];
  assert.doesNotThrow(() => validateDocument(document));
});

test("rejects a fraction track with a non-positive weight", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Grid",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: {
      ...defaultLayout(),
      mode: "grid",
      grid: { columns: [{ type: "fraction", weight: 0 }], rows: [{ type: "auto" }], columnGap: 0, rowGap: 0 },
    },
    appearance: defaultAppearance(),
  } as never;
  document.pages["page:1"]!.childIds = ["node:1"];
  // 0 权重的 fraction 轨道永远分不到空间，等于把这条轨道废了。
  assert.throws(() => validateDocument(document));
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
test("validates elliptical paints", () => {
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
  assert.ok(validateDocument(make([{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops }])));
  // 两个半轴都必须为正：0 或负数画不出椭圆。
  assert.throws(() => validateDocument(make([{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0, ry: 0.5, stops }])), /fills/);
  assert.throws(() => validateDocument(make([{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: -1, stops }])), /fills/);
});
test("validates blend mode and background blur", () => {
  const make = (appearance: Record<string, unknown>) => {
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
      appearance: { ...defaultAppearance(), ...appearance } as never,
    };
    document.pages["page:1"]!.childIds = ["node:1"];
    return document;
  };
  assert.ok(validateDocument(make({ blendMode: "multiply" })));
  assert.ok(validateDocument(make({ blendMode: "luminosity" })));
  assert.ok(validateDocument(make({ backgroundBlur: 8 })));
  // 不认识的混合模式名会被拒绝：拼错的值不该静默变成 normal。
  assert.throws(() => validateDocument(make({ blendMode: "multiplyy" })), /appearance/);
  // 模糊半径不能为负。
  assert.throws(() => validateDocument(make({ backgroundBlur: -1 })), /appearance/);
});