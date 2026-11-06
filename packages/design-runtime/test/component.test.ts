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
