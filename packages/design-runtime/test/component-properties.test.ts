import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, effectiveComponentProperties, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

/**
 * 组件属性（component props）的运行时行为。
 *
 * 规格见 `docs/component-properties.md`。
 */

const frame = (id: string, parentId = "page:1"): DesignNode => ({
  id,
  type: "frame",
  name: id,
  parentId,
  childIds: [],
  visible: true,
  locked: false,
  layout: defaultLayout(),
  appearance: defaultAppearance(),
});

const text = (id: string, parentId: string, content: string): DesignNode => ({
  ...frame(id, parentId),
  type: "text",
  text: content,
  fontFamily: "Inter",
  fontSize: 16,
  lineHeight: 24,
});

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

/**
 * 建一个含组件的运行时。
 *
 * 结构：page → root(组件根) → label(文本) + box(形状)。
 */
function propertyRuntime(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("root") } },
    { type: "node.create", payload: { node: text("label", "root", "Hello") } },
    { type: "node.create", payload: { node: frame("box", "root") } },
  ]));
  runtime.execute(envelope(1, [
    { type: "node.reparent", payload: { id: "label", parentId: "root", index: 0 } },
    { type: "node.reparent", payload: { id: "box", parentId: "root", index: 1 } },
  ]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  return runtime;
}

/** 声明属性并绑定到 label 的文本。 */
function declareTitleProperty(runtime: DesignRuntime, revision: number, defaultValue = "确定"): void {
  runtime.execute(envelope(revision, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:title", name: "标题", type: "text", defaultValue } } },
  ]));
  runtime.execute(envelope(revision + 1, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:title", nodeId: "label", field: "text" } },
  ]));
}

function instantiate(runtime: DesignRuntime, revision: number, id = "instance:1"): void {
  runtime.execute(envelope(revision, [{
    type: "component.instantiate",
    payload: { node: { ...frame(id), type: "instance", componentId: "component:button", overrides: {} } },
  }]));
}

test("declares a property and binds it to a text node", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.components["component:button"]!.properties, [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "确定" },
  ]);
  assert.equal(snapshot.nodes["label"]!.componentPropertyBindings?.text, "prop:title");
});

test("rejects a property with an empty name or id", () => {
  const runtime = propertyRuntime();
  assert.throws(
    () => runtime.execute(envelope(3, [{ type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:a", name: " ", type: "text", defaultValue: "x" } } }])),
    /name cannot be empty/,
  );
  assert.throws(
    () => runtime.execute(envelope(3, [{ type: "component.property.set", payload: { componentId: "component:button", property: { id: " ", name: "标题", type: "text", defaultValue: "x" } } }])),
    /id cannot be empty/,
  );
});

test("rejects binding a node outside the component", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [{ type: "node.create", payload: { node: text("outside", "page:1", "外部") } }]));
  runtime.execute(envelope(4, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:title", name: "标题", type: "text", defaultValue: "确定" } } },
  ]));
  assert.throws(
    () => runtime.execute(envelope(5, [{ type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:title", nodeId: "outside", field: "text" } }])),
    /not inside component/,
  );
});

test("rejects binding the component root itself", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:title", name: "标题", type: "text", defaultValue: "确定" } } },
  ]));
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:title", nodeId: "root", field: "text" } }])),
    /not inside component/,
  );
});

test("rejects binding a boolean property to text", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:flag", name: "开关", type: "boolean", defaultValue: true } } },
  ]));
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:flag", nodeId: "label", field: "text" } }])),
    /cannot bind text/,
  );
});

test("applies the property default to a new instance", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  const snapshot = runtime.snapshot();
  const copy = snapshot.nodes["instance:1--label"]!;
  assert.equal(copy.type === "text" ? copy.text : "", "确定");
});

test("the explicit instance value wins over the default", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  const snapshot = runtime.snapshot();
  const copy = snapshot.nodes["instance:1--label"]!;
  assert.equal(copy.type === "text" ? copy.text : "", "提交");
  assert.deepEqual((snapshot.nodes["instance:1"] as { propValues?: unknown }).propValues, { "prop:title": "提交" });
});

test("resetting the instance value falls back to the default", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  runtime.execute(envelope(7, [
    { type: "instance.property.reset", payload: { instanceId: "instance:1", propertyId: "prop:title" } },
  ]));
  const snapshot = runtime.snapshot();
  const copy = snapshot.nodes["instance:1--label"]!;
  assert.equal(copy.type === "text" ? copy.text : "", "确定");
  assert.deepEqual((snapshot.nodes["instance:1"] as { propValues?: unknown }).propValues, {});
});

test("changing the default reaches instances that did not set a value", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  runtime.execute(envelope(7, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:title", name: "标题", type: "text", defaultValue: "发送" } } },
  ]));
  const snapshot = runtime.snapshot();
  // 显式改过的实例保持自己的值。
  assert.equal((snapshot.nodes["instance:1--label"] as { text: string }).text, "提交");
});

test("property values win over instance overrides", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  runtime.execute(envelope(5, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: { label: { text: "覆盖值" } } } },
  }]));
  const snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--label"] as { text: string }).text, "确定");
});

test("overriding a property-bound field is refused", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  assert.throws(
    () => runtime.execute(envelope(6, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { text: "覆盖值" } } }])),
    /controlled by component property prop:title/,
  );
});

test("a boolean property controls visibility", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:badge", name: "角标", type: "boolean", defaultValue: true } } },
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:badge", nodeId: "box", field: "visible" } },
  ]));
  instantiate(runtime, 4);
  runtime.execute(envelope(5, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:badge", value: false } },
  ]));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes["instance:1--box"]!.visible, false);
});

test("unbinding restores the original value", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  runtime.execute(envelope(7, [
    { type: "component.property.unbind", payload: { componentId: "component:button", propertyId: "prop:title", nodeId: "label", field: "text" } },
  ]));
  const snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--label"] as { text: string }).text, "Hello");
  assert.equal(snapshot.nodes["label"]!.componentPropertyBindings, undefined);
});

test("removing a property clears bindings and instance values", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  runtime.execute(envelope(7, [
    { type: "component.property.remove", payload: { componentId: "component:button", propertyId: "prop:title" } },
  ]));
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.components["component:button"]!.properties, []);
  assert.equal(snapshot.nodes["label"]!.componentPropertyBindings, undefined);
  assert.deepEqual((snapshot.nodes["instance:1"] as { propValues?: unknown }).propValues, {});
  assert.equal((snapshot.nodes["instance:1--label"] as { text: string }).text, "Hello");
});

test("a variant inherits the property declarations and keeps instance values", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  runtime.execute(envelope(7, [
    { type: "component.setCreate", payload: { set: { id: "set:button", name: "Button", properties: ["state"] } } },
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:button", variant: { state: "default" } } },
  ]));
  runtime.execute(envelope(8, [
    { type: "component.createVariant", payload: { sourceComponentId: "component:button", componentId: "component:button-hover", name: "Button hover", values: { state: "hover" } } },
  ]));
  const created = runtime.snapshot();
  assert.deepEqual(created.components["component:button-hover"]!.properties, [
    { id: "prop:title", name: "标题", type: "text", defaultValue: "确定" },
  ]);

  runtime.execute(envelope(9, [
    { type: "component.switchVariant", payload: { id: "instance:1", componentId: "component:button-hover" } },
  ]));
  const snapshot = runtime.snapshot();
  assert.deepEqual((snapshot.nodes["instance:1"] as { propValues?: unknown }).propValues, { "prop:title": "提交" });
  // 变体的根子树节点 id 带组件前缀，所以副本 id 也跟着变。
  const copy = snapshot.nodes["instance:1--component:button-hover--label"];
  assert.equal(copy?.type === "text" ? copy.text : "", "提交");
});

test("detaching an instance drops its property values", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "提交" } },
  ]));
  runtime.execute(envelope(7, [{ type: "component.detach", payload: { id: "instance:1" } }]));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes["instance:1"]!.type, "frame");
  assert.equal((snapshot.nodes["instance:1"] as { propValues?: unknown }).propValues, undefined);
});

test("rejects an instance value for a property the component does not declare", () => {
  const runtime = propertyRuntime();
  instantiate(runtime, 3);
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:nope", value: "x" } }])),
    /not declared by component/,
  );
});

test("rejects an instance value whose type does not match the property", () => {
  const runtime = propertyRuntime();
  declareTitleProperty(runtime, 3);
  instantiate(runtime, 5);
  assert.throws(
    () => runtime.execute(envelope(6, [{ type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: true } }])),
    /must be a string/,
  );
});

test("applies a color property to the bound node's fill", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:tint", nodeId: "box", field: "fill" } },
  ]));
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:tint", value: "#00ff00" } },
  ]));
  const copy = runtime.snapshot().nodes["instance:1--box"]!;
  const fill = copy.appearance.fills?.[0];
  assert.equal(fill?.type === "solid" ? fill.color : "", "#00ff00");
});

test("applies a number property to the bound text node's font size", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:size", name: "字号", type: "number", defaultValue: 18 } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:size", nodeId: "label", field: "fontSize" } },
  ]));
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:size", value: 32 } },
  ]));
  const copy = runtime.snapshot().nodes["instance:1--label"]!;
  assert.equal(copy.type === "text" ? copy.fontSize : 0, 32);
});

test("swaps the inner instance when an instance-swap property changes", () => {
  const runtime = propertyRuntime();
  // 组件里放一个内部实例（图标）。
  runtime.execute(envelope(3, [{ type: "node.create", payload: { node: frame("icon-root", "page:1") } }]));
  runtime.execute(envelope(4, [{ type: "component.create", payload: { id: "component:icon", nodeId: "icon-root", name: "Icon" } }]));
  runtime.execute(envelope(5, [
    { type: "node.create", payload: { node: { ...frame("icon", "page:1"), type: "instance", componentId: "component:icon", overrides: {} } } },
  ]));
  runtime.execute(envelope(6, [{ type: "node.reparent", payload: { id: "icon", parentId: "root", index: 2 } }]));
  runtime.execute(envelope(7, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:icon", name: "图标", type: "instance-swap", defaultValue: "component:icon" } } },
  ]));
  runtime.execute(envelope(8, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:icon", nodeId: "icon", field: "instance" } },
  ]));
  // 另一个可替换的组件。
  runtime.execute(envelope(9, [{ type: "node.create", payload: { node: frame("star-root", "page:1") } }]));
  runtime.execute(envelope(10, [{ type: "component.create", payload: { id: "component:star", nodeId: "star-root", name: "Star" } }]));

  instantiate(runtime, 11);
  runtime.execute(envelope(12, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:icon", value: "component:star" } },
  ]));
  const copy = runtime.snapshot().nodes["instance:1--icon"]!;
  assert.equal(copy.type === "instance" ? copy.componentId : "", "component:star");
});

test("rejects binding a number property to a field that is not a number", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:size", name: "字号", type: "number", defaultValue: 18 } } },
  ]));
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:size", nodeId: "box", field: "fontSize" } }])),
    /is not a text node and cannot bind fontSize/,
  );
});

test("rejects an instance-swap value that points to a missing component", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:icon", name: "图标", type: "instance-swap", defaultValue: "" } } },
  ]));
  instantiate(runtime, 4);
  assert.throws(
    () => runtime.execute(envelope(5, [{ type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:icon", value: "component:ghost" } }])),
    /points to a component that does not exist/,
  );
});

test("a variant set shares one property declaration with all of its members", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.setCreate", payload: { set: { id: "set:1", name: "按钮", properties: ["size"] } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:1", variant: { size: "md" } } },
  ]));
  runtime.execute(envelope(5, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" } } },
  ]));
  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.componentSets!["set:1"]!.componentProperties, [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" },
  ]);
  // 成员组件自己没有声明，但共享声明对它有效。
  assert.deepEqual(snapshot.components["component:button"]!.properties, undefined);
});

test("rejects a member that changes the type of a shared property", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.setCreate", payload: { set: { id: "set:1", name: "按钮", properties: ["size"] } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:1", variant: { size: "md" } } },
  ]));
  runtime.execute(envelope(5, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" } } },
  ]));
  assert.throws(
    () => runtime.execute(envelope(6, [
      { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:tint", name: "主色", type: "text", defaultValue: "x" } } },
    ])),
    /shared by the variant set/,
  );
});

test("removing a shared property clears the bindings and values of members", () => {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.setCreate", payload: { set: { id: "set:1", name: "按钮", properties: ["size"] } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:1", variant: { size: "md" } } },
  ]));
  runtime.execute(envelope(5, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" } } },
  ]));
  runtime.execute(envelope(6, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:tint", nodeId: "box", field: "fill" } },
  ]));
  instantiate(runtime, 7);
  runtime.execute(envelope(8, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:tint", value: "#00ff00" } },
  ]));
  runtime.execute(envelope(9, [
    { type: "component.setProperty.remove", payload: { setId: "set:1", propertyId: "prop:tint" } },
  ]));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes["box"]!.componentPropertyBindings?.fill, undefined);
  assert.deepEqual((snapshot.nodes["instance:1"] as { propValues?: unknown }).propValues, {});
});

/**
 * 集合共享属性 + 变体。
 *
 * 结构：set:1 → component:button（md）+ component:button-lg（lg）。
 */
function variantSetRuntime(): DesignRuntime {
  const runtime = propertyRuntime();
  runtime.execute(envelope(3, [
    { type: "component.setCreate", payload: { set: { id: "set:1", name: "按钮", properties: ["size"] } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:1", variant: { size: "md" } } },
  ]));
  runtime.execute(envelope(5, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" } } },
  ]));
  runtime.execute(envelope(6, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:tint", nodeId: "box", field: "fill" } },
  ]));
  runtime.execute(envelope(7, [
    { type: "component.createVariant", payload: { sourceComponentId: "component:button", componentId: "component:button-lg", name: "Button lg", values: { size: "lg" } } },
  ]));
  return runtime;
}

test("a new variant inherits the shared declaration instead of copying it", () => {
  const runtime = variantSetRuntime();
  const snapshot = runtime.snapshot();
  // 从集继承来的拷贝不复制：复制了就会显示共享声明的旧默认值。
  assert.equal(snapshot.components["component:button-lg"]!.properties, undefined);
  assert.deepEqual(effectiveComponentProperties(snapshot, "component:button-lg"), [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" },
  ]);
});

test("changing the shared default reaches the variants that only inherited it", () => {
  const runtime = variantSetRuntime();
  runtime.execute(envelope(8, [
    { type: "component.instantiate", payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button-lg", overrides: {} } } },
  ]));
  runtime.execute(envelope(9, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#00ff00" } } },
  ]));
  const snapshot = runtime.snapshot();
  assert.deepEqual(effectiveComponentProperties(snapshot, "component:button-lg"), [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#00ff00" },
  ]);
  // 实例副本跟着新的集合默认值走。
  const copy = snapshot.nodes["instance:1--component:button-lg--box"];
  assert.equal(copy?.appearance.fills?.[0]?.type === "solid" ? copy.appearance.fills[0].color : "", "#00ff00");
});

test("a variant holding an inherited copy follows the shared default", () => {
  const runtime = variantSetRuntime();
  // 历史文档的样子：变体自己存着一条与共享声明一模一样的拷贝。
  runtime.execute(envelope(8, [
    { type: "component.property.set", payload: { componentId: "component:button-lg", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" } } },
  ]));
  assert.deepEqual(runtime.snapshot().components["component:button-lg"]!.properties, [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#ff0000" },
  ]);
  runtime.execute(envelope(9, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#00ff00" } } },
  ]));
  const snapshot = runtime.snapshot();
  // 那条拷贝被丢掉，变体直接继承新的共享声明。
  assert.equal(snapshot.components["component:button-lg"]!.properties, undefined);
  assert.deepEqual(effectiveComponentProperties(snapshot, "component:button-lg"), [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#00ff00" },
  ]);
});

test("a variant that specialized the default keeps it when the shared default changes", () => {
  const runtime = variantSetRuntime();
  runtime.execute(envelope(8, [
    { type: "component.property.set", payload: { componentId: "component:button-lg", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#0000ff" } } },
  ]));
  runtime.execute(envelope(9, [
    { type: "component.setProperty.set", payload: { setId: "set:1", property: { id: "prop:tint", name: "主色", type: "color", defaultValue: "#00ff00" } } },
  ]));
  const snapshot = runtime.snapshot();
  // 显式特化保留：集合默认值不覆盖它。
  assert.deepEqual(snapshot.components["component:button-lg"]!.properties, [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#0000ff" },
  ]);
  assert.deepEqual(effectiveComponentProperties(snapshot, "component:button-lg"), [
    { id: "prop:tint", name: "主色", type: "color", defaultValue: "#0000ff" },
  ]);
});

test("writing a text property keeps the in-paragraph styles of the untouched parts", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("root") } },
    {
      type: "node.create",
      payload: {
        node: {
          ...text("label", "root", "Hello World"),
          runs: [{ from: 0, to: 5, style: { fontWeight: 700 } }],
          paragraphStyles: [{ from: 0, to: 11, style: { listType: "bullet" } }],
        },
      },
    },
  ]));
  runtime.execute(envelope(1, [
    { type: "node.reparent", payload: { id: "label", parentId: "root", index: 0 } },
  ]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:title", name: "标题", type: "text", defaultValue: "Hello World" } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:title", nodeId: "label", field: "text" } },
  ]));
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "Hello" } },
  ]));
  const copy = runtime.snapshot().nodes["instance:1--label"] as { text: string; runs?: unknown[]; paragraphStyles?: unknown[] };
  assert.equal(copy.text, "Hello");
  // 共有前缀里的加粗保留；段落样式按段落边界重新吸附到新文本。
  assert.deepEqual(copy.runs, [{ from: 0, to: 5, style: { fontWeight: 700 } }]);
  assert.deepEqual(copy.paragraphStyles, [{ from: 0, to: 5, style: { listType: "bullet" } }]);
});

test("writing a completely different text drops the in-paragraph styles", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("root") } },
    {
      type: "node.create",
      payload: {
        node: {
          ...text("label", "root", "Hello World"),
          runs: [{ from: 0, to: 5, style: { fontWeight: 700 } }],
        },
      },
    },
  ]));
  runtime.execute(envelope(1, [
    { type: "node.reparent", payload: { id: "label", parentId: "root", index: 0 } },
  ]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [
    { type: "component.property.set", payload: { componentId: "component:button", property: { id: "prop:title", name: "标题", type: "text", defaultValue: "Hello World" } } },
  ]));
  runtime.execute(envelope(4, [
    { type: "component.property.bind", payload: { componentId: "component:button", propertyId: "prop:title", nodeId: "label", field: "text" } },
  ]));
  instantiate(runtime, 5);
  runtime.execute(envelope(6, [
    { type: "instance.property.set", payload: { instanceId: "instance:1", propertyId: "prop:title", value: "完全不同" } },
  ]));
  const copy = runtime.snapshot().nodes["instance:1--label"] as { text: string; runs?: unknown[] };
  assert.equal(copy.text, "完全不同");
  assert.equal(copy.runs, undefined);
});