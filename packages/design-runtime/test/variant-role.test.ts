import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

/**
 * 变体间的角色（role）。
 *
 * 变体是各自深拷贝的树，节点 id 必然不同。结构一模一样时，覆盖靠结构路径迁移；
 * 结构一旦不同（多一层包裹、少一个兄弟节点），路径就对不上——**角色**就是为这种
 * 情况准备的：同一组件集里「同一个东西」起同一个角色名，切换变体时按角色迁移，
 * 路径兜底。
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
 * 一个变体集：default 变体的 root 下有一个文本节点 label，hover 变体是它的深拷贝。
 * 节点带 role="title"。
 */
function roleVariantRuntime(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("root") } }]));
  runtime.execute(envelope(1, [{ type: "node.create", payload: { node: text("label", "root", "Hello") } }]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  // 角色先设上：变体是深拷贝，角色会跟着复制过去。
  runtime.execute(envelope(3, [{ type: "node.patch", payload: { id: "label", patch: { role: "title" } } }]));
  runtime.execute(envelope(4, [
    { type: "component.setCreate", payload: { set: { id: "set:button", name: "Button set", properties: ["state"] } } },
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:button", variant: { state: "default" } } },
    { type: "component.createVariant", payload: { sourceComponentId: "component:button", componentId: "component:button-hover", name: "Button / hover", values: { state: "hover" } } },
  ]));
  return runtime;
}

test("角色是可选项，没设角色的节点照旧按结构路径迁移", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("root") } }]));
  runtime.execute(envelope(1, [{ type: "node.create", payload: { node: text("label", "root", "Hello") } }]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:button", nodeId: "root", name: "Button" } }]));
  runtime.execute(envelope(3, [
    { type: "component.setCreate", payload: { set: { id: "set:button", name: "Button set", properties: ["state"] } } },
    { type: "component.setVariant", payload: { id: "component:button", variantSetId: "set:button", variant: { state: "default" } } },
    { type: "component.createVariant", payload: { sourceComponentId: "component:button", componentId: "component:button-hover", name: "Button / hover", values: { state: "hover" } } },
  ]));
  runtime.execute(envelope(4, [{ type: "component.instantiate", payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } } }]));
  runtime.execute(envelope(5, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { text: "改过的" } } }]));
  runtime.execute(envelope(6, [{ type: "component.switchVariant", payload: { id: "instance:1", componentId: "component:button-hover" } }]));

  const snapshot = runtime.snapshot();
  const copy = snapshot.nodes["instance:1--component:button-hover--label"];
  assert.equal(copy?.type === "text" ? copy.text : "", "改过的");
});

test("复制变体时角色跟着复制过去", () => {
  const runtime = roleVariantRuntime();
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes.label?.role, "title");
  assert.equal(snapshot.nodes["component:button-hover--label"]?.role, "title");
});

test("结构不一样时，覆盖按角色迁移到同一个角色上", () => {
  const runtime = roleVariantRuntime();
  // hover 变体里给 label 套一层 wrapper：结构路径变了，角色没变。
  runtime.execute(envelope(5, [{ type: "node.create", payload: { node: frame("wrapper", "component:button-hover--root") } }]));
  runtime.execute(envelope(6, [{ type: "node.reparent", payload: { id: "component:button-hover--label", parentId: "wrapper", index: 0 } }]));

  runtime.execute(envelope(7, [{ type: "component.instantiate", payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } } }]));
  runtime.execute(envelope(8, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { text: "改过的" } } }]));
  runtime.execute(envelope(9, [{ type: "component.switchVariant", payload: { id: "instance:1", componentId: "component:button-hover" } }]));

  const snapshot = runtime.snapshot();
  const instance = snapshot.nodes["instance:1"]!;
  const overrides = (instance as { overrides?: Record<string, unknown> }).overrides;
  // 覆盖落到了 hover 变体里那个带 title 角色的节点上。
  assert.deepEqual(Object.keys(overrides ?? {}), ["component:button-hover--label"]);
  const copy = snapshot.nodes["instance:1--component:button-hover--label"];
  assert.equal(copy?.type === "text" ? copy.text : "", "改过的");
});

test("同一个变体里角色重复时不按角色映射（会指错节点），退回结构路径", () => {
  const runtime = roleVariantRuntime();
  // hover 变体里再放一个同角色的节点：角色不再唯一。
  runtime.execute(envelope(5, [{ type: "node.create", payload: { node: { ...frame("other", "component:button-hover--root"), role: "title" } } }]));
  runtime.execute(envelope(6, [{ type: "component.instantiate", payload: { node: { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } } }]));
  runtime.execute(envelope(7, [{ type: "component.override", payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { text: "改过的" } } }]));
  runtime.execute(envelope(8, [{ type: "component.switchVariant", payload: { id: "instance:1", componentId: "component:button-hover" } }]));

  const snapshot = runtime.snapshot();
  const instance = snapshot.nodes["instance:1"]!;
  const overrides = (instance as { overrides?: Record<string, unknown> }).overrides;
  // 退回路径迁移：落到结构上同一个位置的节点。
  assert.deepEqual(Object.keys(overrides ?? {}), ["component:button-hover--label"]);
});

test("角色可以清空：空字符串把字段删掉", () => {
  const runtime = roleVariantRuntime();
  runtime.execute(envelope(5, [{ type: "node.patch", payload: { id: "label", patch: { role: "" } } }]));
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.nodes.label?.role, undefined);
});

test("角色必须是字符串", () => {
  const runtime = roleVariantRuntime();
  assert.throws(
    () => runtime.execute(envelope(5, [{ type: "node.patch", payload: { id: "label", patch: { role: 42 } } }])),
    /role must be a string/,
  );
});
