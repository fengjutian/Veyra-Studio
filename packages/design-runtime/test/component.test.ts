import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

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

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

const text = (id: string, parentId: string, content: string): DesignNode => ({
  ...frame(id, parentId),
  type: "text",
  text: content,
  fontFamily: "Inter",
  fontSize: 16,
  lineHeight: 24,
});

function componentRuntime(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("root") } },
    { type: "node.create", payload: { node: text("label", "root", "Hello") } },
  ]));
  // Wire the child into its parent.
  runtime.execute(envelope(1, [{ type: "node.reparent", payload: { id: "label", parentId: "root", index: 0 } }]));
  return runtime;
}

test("promotes a node into a component root", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes.root.type, "component");
  assert.equal(snapshot.components["component:button"].rootNodeId, "root");
  assert.equal(snapshot.components["component:button"].name, "Button");
});

test("refuses to promote the same node twice", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  assert.throws(() => runtime.execute(envelope(3, [{ type: "component.create", payload: { id: "component:other", nodeId: "root", name: "Other" } }])), /already a component root/);
});

test("materializes the component subtree when instantiating", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));

  const snapshot = runtime.snapshot();
  const instance = snapshot.nodes["instance:1"];
  assert.equal(instance?.type, "instance");
  assert.equal(instance?.childIds.length, 1);
  const copy = snapshot.nodes[instance!.childIds[0]!];
  assert.equal(copy?.type, "text");
  assert.equal(copy?.type === "text" ? copy.text : "", "Hello");
  assert.notEqual(copy?.id, "label");
  assert.equal(copy?.parentId, "instance:1");
});

test("applies instance overrides onto the materialized copy", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: { label: { text: "Custom" } } } },
  }]));
  const snapshot = runtime.snapshot();
  const instance = snapshot.nodes["instance:1"]!;
  const copy = snapshot.nodes[instance.childIds[0]!];
  assert.equal(copy?.type === "text" ? copy.text : "", "Custom");
});

test("rejects an override that targets a node outside the component", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  assert.throws(() => runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: { "not-in-component": { text: "x" } } } },
  }])), /is not part of component/);
});

test("rejects instantiating an unknown component", () => {
  const runtime = componentRuntime();
  assert.throws(() => runtime.execute(envelope(2, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:missing", overrides: {} } },
  }])), /does not exist/);
});

test("keeps the component definition when an instance is deleted", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));
  runtime.execute(envelope(4, [{ type: "node.delete", payload: { id: "instance:1" } }]));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes["instance:1"], undefined);
  assert.equal(snapshot.components["component:button"] !== undefined, true);
  // The materialized copy is removed with the instance.
  assert.equal(Object.values(snapshot.nodes).some(node => node.id.startsWith("instance:1--")), false);
});

test("blocks component removal while an instance still uses it", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));
  assert.throws(() => runtime.execute(envelope(4, [{ type: "component.remove", payload: { id: "component:button" } }])), /still used/);
});

test("detaches an instance into a plain frame and keeps its children", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: { label: { text: "Hi" } } } },
  }]));

  runtime.execute(envelope(4, [{ type: "component.detach", payload: { id: "instance:1" } }]));
  const snapshot = runtime.snapshot();
  const detached = snapshot.nodes["instance:1"] as Record<string, unknown>;

  assert.equal(detached.type, "frame");
  assert.equal("componentId" in detached, false);
  assert.equal("overrides" in detached, false);
  // 物化的子节点原样保留，展开的文字也还在。
  assert.equal((snapshot.nodes["instance:1--label"] as { text?: string }).text, "Hi");

  // 脱离之后组件不再被引用，可以删除。
  runtime.execute(envelope(5, [{ type: "component.remove", payload: { id: "component:button" } }]));
  assert.equal(runtime.snapshot().components["component:button"], undefined);
});

test("refuses to detach a node that is not an instance", () => {
  const runtime = componentRuntime();
  assert.throws(() => runtime.execute(envelope(2, [{ type: "component.detach", payload: { id: "root" } }])), /not a component instance/);
});

test("rejects moving an instance into its own component subtree", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:card", nodeId: "root", name: "Card" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:card", overrides: {} } },
  }]));

  // root 是组件 card 的根：把 card 的实例塞回去会形成自引用。
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "node.reparent", payload: { id: "instance:1", parentId: "root" } }])),
    /component cycle/,
  );
});

test("rejects an indirect component cycle created by reparenting", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("a-root") } },
    { type: "node.create", payload: { node: frame("b-root") } },
  ]));
  runtime.execute(envelope(1, [{ type: "component.create", payload: { id: "component:a", nodeId: "a-root", name: "A" } }]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:b", nodeId: "b-root", name: "B" } }]));
  // A 的实例放进 B：B -> A。
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:a"), type: "instance", componentId: "component:a", overrides: {} } },
  }]));
  runtime.execute(envelope(4, [{ type: "node.reparent", payload: { id: "instance:a", parentId: "b-root" } }]));

  // 再把 B 的实例放进 A，就会形成 A -> B -> A。
  runtime.execute(envelope(5, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:b"), type: "instance", componentId: "component:b", overrides: {} } },
  }]));
  assert.throws(
    () => runtime.execute(envelope(6, [{ type: "node.reparent", payload: { id: "instance:b", parentId: "a-root" } }])),
    /component cycle/,
  );
});

test("fills a component slot with template nodes and replaces previous content", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: { ...frame("card"), type: "component" } } },
    { type: "node.create", payload: { node: { ...frame("slot"), slot: true } } },
  ]));
  // slot 挂到组件根下。
  runtime.execute(envelope(1, [{ type: "node.reparent", payload: { id: "slot", parentId: "card" } }]));
  runtime.execute(envelope(2, [{ type: "component.define", payload: { component: { id: "component:card", name: "Card", rootNodeId: "card" } } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:card", overrides: {} } },
  }]));

  const materializedSlot = "instance:1--slot";
  const template = {
    roots: ["content"],
    nodes: {
      content: { ...frame("content", "slot"), type: "text", text: "标题", fontFamily: "Inter", fontSize: 16, lineHeight: 24 },
    },
  };

  runtime.execute(envelope(4, [{ type: "slot.fill", payload: { instanceId: "instance:1", slotNodeId: materializedSlot, template } }]));
  const firstFill = runtime.snapshot();
  assert.deepEqual(firstFill.nodes[materializedSlot]?.childIds, ["instance:1--slot--instance:1--slot--content"]);
  assert.equal((firstFill.nodes["instance:1--slot--instance:1--slot--content"] as { text?: string }).text, "标题");

  // 再填一次：旧内容被清掉，不会越堆越多。
  runtime.execute(envelope(5, [{ type: "slot.fill", payload: { instanceId: "instance:1", slotNodeId: materializedSlot, template } }]));
  assert.equal(runtime.snapshot().nodes[materializedSlot]?.childIds.length, 1);
});

test("rejects filling a node that is not a slot or does not belong to the instance", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: { ...frame("card"), type: "component" } } },
    { type: "node.create", payload: { node: { ...frame("slot"), slot: true } } },
    { type: "node.create", payload: { node: frame("plain") } },
  ]));
  runtime.execute(envelope(1, [{ type: "node.reparent", payload: { id: "slot", parentId: "card" } }]));
  runtime.execute(envelope(2, [{ type: "component.define", payload: { component: { id: "component:card", name: "Card", rootNodeId: "card" } } }]));
  runtime.execute(envelope(3, [
    { type: "component.instantiate", payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:card", overrides: {} } } },
    { type: "component.instantiate", payload: { node: { ...frame("instance:2"), type: "instance", componentId: "component:card", overrides: {} } } },
  ]));

  const template = { roots: [], nodes: {} };
  // plain 不是插槽。
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "slot.fill", payload: { instanceId: "instance:1", slotNodeId: "plain", template } }])),
    /not a slot/,
  );
  // instance:2 的插槽不属于 instance:1。
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "slot.fill", payload: { instanceId: "instance:1", slotNodeId: "instance:2--slot", template } }])),
    /does not belong/,
  );
});
test("rejects non-boolean slot flags", () => {
  const runtime = componentRuntime();
  assert.throws(() => runtime.execute(envelope(2, [{ type: "node.patch", payload: { id: "root", patch: { slot: "yes" } } }])), /boolean/);
});

test("records instance overrides and applies them to the materialized copy", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));

  runtime.execute(envelope(4, [{
    type: "component.override",
    payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { text: "已覆盖" } },
  }]));

  const snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--label"] as { text?: string }).text, "已覆盖");
  const instance = snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> };
  assert.deepEqual(instance.overrides?.label, { text: "已覆盖" });
  // 组件定义本身没有变化。
  assert.equal((snapshot.nodes.label as { text?: string }).text, "Hello");
});

test("rejects overrides for unknown nodes, foreign instances and non-text fields", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));

  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "missing", patch: { text: "x" } } }])),
    /does not exist/,
  );
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "root", sourceNodeId: "label", patch: { text: "x" } } }])),
    /not a component instance/,
  );
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "root", patch: { text: "x" } } }])),
    /not a text node|does not exist/,
  );
});

test("overrides appearance and can reset an instance back to the component definition", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));

  runtime.execute(envelope(4, [{
    type: "component.override",
    payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { text: "覆盖", appearance: { fill: "#ff0000" } } },
  }]));
  let snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--label"] as { appearance?: { fill?: string } }).appearance?.fill, "#ff0000");
  assert.deepEqual((snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> }).overrides?.label, { text: "覆盖", appearance: { fill: "#ff0000" } });
  // 组件定义没被改动。
  assert.equal((snapshot.nodes.label as { text?: string }).text, "Hello");

  runtime.execute(envelope(5, [{ type: "component.resetOverride", payload: { instanceId: "instance:1", sourceNodeId: "label" } }]));
  snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--label"] as { text?: string }).text, "Hello");
  assert.notEqual((snapshot.nodes["instance:1--label"] as { appearance?: { fill?: string } }).appearance?.fill, "#ff0000");
  assert.deepEqual((snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> }).overrides, {});
});

test("reset refuses nodes outside the component definition", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.resetOverride", payload: { instanceId: "instance:1", sourceNodeId: "outside" } }])),
    /does not exist|not part of component/,
  );
});

test("batch reset clears every override in one transaction", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: { ...frame("card"), type: "component" } } },
    { type: "node.create", payload: { node: text("title", "card", "标题") } },
    { type: "node.create", payload: { node: text("body", "card", "正文") } },
  ]));
  runtime.execute(envelope(1, [{ type: "node.reparent", payload: { id: "title", parentId: "card" } }]));
  runtime.execute(envelope(2, [{ type: "node.reparent", payload: { id: "body", parentId: "card" } }]));
  runtime.execute(envelope(3, [{ type: "component.define", payload: { component: { id: "component:card", name: "Card", rootNodeId: "card" } } }]));
  runtime.execute(envelope(4, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:card", overrides: {} } },
  }]));
  runtime.execute(envelope(5, [
    { type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "title", patch: { text: "新标题" } } },
    { type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "body", patch: { text: "新正文" } } },
  ]));

  runtime.execute(envelope(6, [{ type: "component.resetOverrides", payload: { instanceId: "instance:1" } }]));
  const snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--title"] as { text?: string }).text, "标题");
  assert.equal((snapshot.nodes["instance:1--body"] as { text?: string }).text, "正文");
  assert.deepEqual((snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> }).overrides, {});
});

test("batch reset can target a subset and keeps the rest", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: { ...frame("card"), type: "component" } } },
    { type: "node.create", payload: { node: text("title", "card", "标题") } },
    { type: "node.create", payload: { node: text("body", "card", "正文") } },
  ]));
  runtime.execute(envelope(1, [{ type: "node.reparent", payload: { id: "title", parentId: "card" } }]));
  runtime.execute(envelope(2, [{ type: "node.reparent", payload: { id: "body", parentId: "card" } }]));
  runtime.execute(envelope(3, [{ type: "component.define", payload: { component: { id: "component:card", name: "Card", rootNodeId: "card" } } }]));
  runtime.execute(envelope(4, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:card", overrides: {} } },
  }]));
  runtime.execute(envelope(5, [
    { type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "title", patch: { text: "新标题" } } },
    { type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "body", patch: { text: "新正文" } } },
  ]));

  runtime.execute(envelope(6, [{ type: "component.resetOverrides", payload: { instanceId: "instance:1", sourceNodeIds: ["title"] } }]));
  const snapshot = runtime.snapshot();
  assert.equal((snapshot.nodes["instance:1--title"] as { text?: string }).text, "标题");
  assert.deepEqual((snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> }).overrides, { body: { text: "新正文" } });
});

test("validates override patches against the exposed field contract", () => {
  const runtime = componentRuntime();
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } },
  }]));

  assert.throws(() => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: {} } }])), /cannot be empty/);
  assert.throws(() => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { layout: {} } } }])), /cannot override/);
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { appearance: { opacity: 2 } } } }])),
    /between 0 and 1/,
  );
  assert.throws(
    () => runtime.execute(envelope(4, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { appearance: { cornerRadius: -1 } } } }])),
    /non-negative/,
  );
});
