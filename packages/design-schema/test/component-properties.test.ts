import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  effectiveComponentProperties,
  isInsideSubtree,
  propertyTargets,
  resolvePropertyValue,
  sharedPropertyTypeConflicts,
  validateDocument,
  validatePropertyValue,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

/**
 * 组件属性（component props）的数据模型与文档级校验。
 *
 * 规格见 `docs/component-properties.md`。
 */

function frame(id: string, parentId: string, extra: Record<string, unknown> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

function textNode(id: string, parentId: string, content: string, extra: Record<string, unknown> = {}): DesignNode {
  return {
    ...frame(id, parentId, extra),
    type: "text",
    text: content,
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  } as DesignNode;
}

/** 一个含「组件根 → 文本节点 / 形状」的文档。 */
function componentDocument(): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  const root = frame("root", "page:1", { type: "component" });
  const label = textNode("label", "root", "Hello");
  const box = frame("box", "root");
  root.childIds = [label.id, box.id];
  document.nodes[root.id] = root;
  document.nodes[label.id] = label;
  document.nodes[box.id] = box;
  document.pages["page:1"]!.childIds.push(root.id);
  document.components["component:button"] = { id: "component:button", name: "Button", rootNodeId: "root" };
  return document;
}

test("accepts component properties, bindings and instance values", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "确定" },
    { id: "prop:danger", name: "危险", type: "boolean", defaultValue: false },
  ];
  document.nodes["label"]!.componentPropertyBindings = { text: "prop:title" };
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:title": "提交" },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");

  assert.doesNotThrow(() => validateDocument(document));
});

test("rejects a property whose default value does not match its type", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: false as unknown as string },
  ];
  assert.throws(() => validateDocument(document), /defaultValue/);
});

test("rejects duplicate property ids inside one component", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "a" },
    { id: "prop:title", name: "标题二", type: "text", defaultValue: "b" },
  ];
  assert.throws(() => validateDocument(document), /duplicate property prop:title/);
});

test("rejects a binding that references an unknown property", () => {
  const document = componentDocument();
  document.nodes["label"]!.componentPropertyBindings = { text: "prop:missing" };
  assert.throws(() => validateDocument(document), /references unknown property prop:missing/);
});

test("rejects a binding whose property type does not match the field", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "a" },
  ];
  document.nodes["label"]!.componentPropertyBindings = { visible: "prop:title" };
  assert.throws(() => validateDocument(document), /visible binding cannot use text property/);
});

test("rejects a text binding on a non-text node", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "a" },
  ];
  document.nodes["box"]!.componentPropertyBindings = { text: "prop:title" };
  assert.throws(() => validateDocument(document), /text binding requires a text node/);
});

test("rejects a binding on a node that is not inside the component", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "a" },
  ];
  const outside = textNode("outside", "page:1", "外部");
  document.nodes["outside"] = outside;
  document.pages["page:1"]!.childIds.push("outside");
  document.nodes["outside"]!.componentPropertyBindings = { text: "prop:title" };
  assert.throws(() => validateDocument(document), /not inside a component/);
});

test("rejects an instance value for an unknown property", () => {
  const document = componentDocument();
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:missing": "x" },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");
  assert.throws(() => validateDocument(document), /sets unknown component property prop:missing/);
});

test("rejects an instance value whose type does not match the property", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "a" },
  ];
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:title": true as unknown as string },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");
  assert.throws(() => validateDocument(document), /must be a string/);
});

test("isInsideSubtree excludes the subtree root itself", () => {
  const document = componentDocument();
  assert.equal(isInsideSubtree(document, "label", "root"), true);
  assert.equal(isInsideSubtree(document, "root", "root"), false);
  assert.equal(isInsideSubtree(document, "outside", "root"), false);
});

test("propertyTargets lists only bindings whose property still exists", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "a" },
  ];
  document.nodes["label"]!.componentPropertyBindings = { text: "prop:title" };
  document.nodes["box"]!.componentPropertyBindings = { text: "prop:gone" };

  const targets = propertyTargets(document, "component:button");
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.property.id, "prop:title");
  assert.equal(targets[0]!.sourceNodeId, "label");
  assert.equal(targets[0]!.field, "text");
});

test("resolvePropertyValue prefers the explicit instance value", () => {
  const document = componentDocument();
  const instance = {
    id: "instance:1",
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:title": "提交" },
  } as unknown as Extract<DesignNode, { type: "instance" }>;
  const property = { id: "prop:title", name: "标题", type: "text" as const, defaultValue: "确定" };
  assert.equal(resolvePropertyValue(document, instance, property), "提交");

  const untouched = { ...instance, propValues: {} };
  assert.equal(resolvePropertyValue(document, untouched, property), "确定");
});

test("accepts the three new property types", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" },
    { id: "prop:size", name: "字号", type: "number", defaultValue: 18 },
    { id: "prop:icon", name: "图标", type: "instance-swap", defaultValue: "component:icon" },
  ];
  document.components["component:icon"] = { id: "component:icon", name: "Icon", rootNodeId: "icon-root" };
  document.nodes["icon-root"] = frame("icon-root", "page:1", { type: "component" });
  document.pages["page:1"]!.childIds.push("icon-root");

  document.nodes["label"]!.componentPropertyBindings = { fontSize: "prop:size" };
  document.nodes["box"]!.componentPropertyBindings = { fill: "prop:tint" };
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:tint": "#00ff00", "prop:size": 24, "prop:icon": "component:icon" },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");

  assert.doesNotThrow(() => validateDocument(document));
});

test("rejects an instance value whose type does not match the new property types", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:size", name: "字号", type: "number", defaultValue: 18 },
  ];
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:size": "big" as unknown as number },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");
  assert.throws(() => validateDocument(document), /must be a finite number/);
});

test("rejects a color value that is not a hex color", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" },
  ];
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:tint": "red" },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");
  assert.throws(() => validateDocument(document), /must be a #rgb or #rrggbb color/);
});

test("rejects an instance-swap value that points to a missing component", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:icon", name: "图标", type: "instance-swap", defaultValue: "" },
  ];
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:icon": "component:ghost" },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");
  assert.throws(() => validateDocument(document), /points to a component that does not exist/);
});

test("rejects a binding whose field does not match the new property types", () => {
  const document = componentDocument();
  document.components["component:button"]!.properties = [
    { id: "prop:size", name: "字号", type: "number", defaultValue: 18 },
  ];
  document.nodes["box"]!.componentPropertyBindings = { fontSize: "prop:size" };
  assert.throws(() => validateDocument(document), /fontSize binding requires a text node/);
});

test("validatePropertyValue accepts the documented shapes", () => {
  const color = { id: "p", name: "主色", type: "color" as const, defaultValue: "#000000" };
  assert.equal(validatePropertyValue(color, "#abc"), undefined);
  assert.equal(validatePropertyValue(color, "#abcdef"), undefined);
  assert.match(validatePropertyValue(color, "#abcdefgh") ?? "", /must be a #rgb or #rrggbb color/);

  const size = { id: "p", name: "字号", type: "number" as const, defaultValue: 16 };
  assert.equal(validatePropertyValue(size, 12), undefined);
  assert.match(validatePropertyValue(size, Number.NaN) ?? "", /must be a finite number/);
});

test("merges the variant set shared declarations with the component's own ones", () => {
  const document = componentDocument();
  document.componentSets = {
    "set:1": {
      id: "set:1",
      name: "按钮变体",
      properties: ["size"],
      componentProperties: [
        { id: "prop:tint", name: "主色", type: "color", defaultValue: "#111111" },
        { id: "prop:label", name: "文字", type: "text", defaultValue: "确定" },
      ],
    },
  };
  document.components["component:button"]!.variantSetId = "set:1";
  document.components["component:button"]!.variant = { size: "md" };
  document.components["component:button"]!.properties = [
    // 同名 id：组件自己的声明优先（覆盖整条定义）。
    { id: "prop:label", name: "文字", type: "text", defaultValue: "提交" },
    // 只有组件自己有的：追加在继承来的声明之后。
    { id: "prop:own", name: "自有", type: "boolean", defaultValue: true },
  ];

  const merged = effectiveComponentProperties(document, "component:button");
  assert.deepEqual(merged.map(property => property.id), ["prop:tint", "prop:label", "prop:own"]);
  assert.equal(merged[1]!.defaultValue, "提交");
  assert.deepEqual(sharedPropertyTypeConflicts(document, "component:button"), []);
});

test("reports a component that changes the type of a shared property", () => {
  const document = componentDocument();
  document.componentSets = {
    "set:1": {
      id: "set:1",
      name: "按钮变体",
      properties: ["size"],
      componentProperties: [{ id: "prop:tint", name: "主色", type: "color", defaultValue: "#111111" }],
    },
  };
  document.components["component:button"]!.variantSetId = "set:1";
  document.components["component:button"]!.variant = { size: "md" };
  document.components["component:button"]!.properties = [
    { id: "prop:tint", name: "主色", type: "text", defaultValue: "x" },
  ];
  assert.deepEqual(sharedPropertyTypeConflicts(document, "component:button"), ["prop:tint"]);
  assert.throws(() => validateDocument(document), /changes the type of shared property prop:tint/);
});

test("a shared property is visible to the instance even without a local declaration", () => {
  const document = componentDocument();
  document.componentSets = {
    "set:1": {
      id: "set:1",
      name: "按钮变体",
      properties: ["size"],
      componentProperties: [{ id: "prop:tint", name: "主色", type: "color", defaultValue: "#111111" }],
    },
  };
  document.components["component:button"]!.variantSetId = "set:1";
  document.components["component:button"]!.variant = { size: "md" };
  document.nodes["instance:1"] = {
    ...frame("instance:1", "page:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
    propValues: { "prop:tint": "#00ff00" },
  } as DesignNode;
  document.pages["page:1"]!.childIds.push("instance:1");
  assert.doesNotThrow(() => validateDocument(document));

  const property = { id: "prop:tint", name: "主色", type: "color" as const, defaultValue: "#111111" };
  const instance = document.nodes["instance:1"] as unknown as Extract<DesignNode, { type: "instance" }>;
  assert.equal(resolvePropertyValue(document, instance, property), "#00ff00");
});
