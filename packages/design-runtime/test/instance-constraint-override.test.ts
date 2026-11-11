import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

/**
 * 实例内的约束覆盖。
 *
 * 约束是「父级尺寸变了怎么办」：同一个组件放在不同父级里，各自的摆放方式可能不一样。
 * 覆盖写在实例的覆盖记录里，只作用于这个实例的物化副本——组件定义和别的实例不动。
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

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

/** 一个组件定义：root 下面挂一个 frame，frame 自己带约束。 */
function runtimeWithComponent(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("root") } }]));
  runtime.execute(envelope(1, [{
    type: "node.create",
    payload: { node: { ...frame("label", "root"), constraints: { horizontal: "start", vertical: "start" } } },
  }]));
  runtime.execute(envelope(2, [{ type: "component.create", payload: { id: "component:card", nodeId: "root", name: "Card" } }]));
  return runtime;
}

const instanceNode = (id: string, overrides: Record<string, unknown> = {}): DesignNode => ({
  ...frame(id),
  type: "instance",
  componentId: "component:card",
  overrides,
} as DesignNode);

test("覆盖实例里的约束：只改这个实例的副本，组件定义与别的实例不动", () => {
  const runtime = runtimeWithComponent();
  runtime.execute(envelope(3, [{ type: "component.instantiate", payload: { node: instanceNode("instance:1") } }]));
  runtime.execute(envelope(4, [{ type: "component.instantiate", payload: { node: instanceNode("instance:2") } }]));

  runtime.execute(envelope(5, [{
    type: "component.override",
    payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { constraints: { horizontal: "end", vertical: "center" } } },
  }]));

  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.nodes["instance:1--label"]?.constraints, { horizontal: "end", vertical: "center" });
  // 组件定义里的源节点不动。
  assert.deepEqual(snapshot.nodes.label?.constraints, { horizontal: "start", vertical: "start" });
  // 另一个实例不动。
  assert.deepEqual(snapshot.nodes["instance:2--label"]?.constraints, { horizontal: "start", vertical: "start" });
  // 覆盖记录里有这一条：语义上属于这个实例。
  const overrides = (snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> }).overrides;
  assert.deepEqual(overrides?.label, { constraints: { horizontal: "end", vertical: "center" } });
});

test("只覆盖一个轴时，另一个轴沿用原来的值", () => {
  const runtime = runtimeWithComponent();
  runtime.execute(envelope(3, [{ type: "component.instantiate", payload: { node: instanceNode("instance:1") } }]));
  runtime.execute(envelope(4, [{
    type: "component.override",
    payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { constraints: { horizontal: "end" } } },
  }]));
  assert.deepEqual(runtime.snapshot().nodes["instance:1--label"]?.constraints, { horizontal: "end", vertical: "start" });
});

test("重置覆盖时约束回到组件定义里的样子", () => {
  const runtime = runtimeWithComponent();
  runtime.execute(envelope(3, [{ type: "component.instantiate", payload: { node: instanceNode("instance:1") } }]));
  runtime.execute(envelope(4, [{
    type: "component.override",
    payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { constraints: { horizontal: "end", vertical: "end" } } },
  }]));
  runtime.execute(envelope(5, [{ type: "component.resetOverride", payload: { instanceId: "instance:1", sourceNodeId: "label" } }]));

  const snapshot = runtime.snapshot();
  assert.deepEqual(snapshot.nodes["instance:1--label"]?.constraints, { horizontal: "start", vertical: "start" });
  const overrides = (snapshot.nodes["instance:1"] as { overrides?: Record<string, unknown> }).overrides;
  assert.equal(overrides?.label, undefined);
});

test("实例化时就带着的覆盖，落到物化副本上", () => {
  const runtime = runtimeWithComponent();
  runtime.execute(envelope(3, [{
    type: "component.instantiate",
    payload: { node: instanceNode("instance:1", { label: { constraints: { horizontal: "stretch", vertical: "end" } } }) },
  }]));
  assert.deepEqual(runtime.snapshot().nodes["instance:1--label"]?.constraints, { horizontal: "stretch", vertical: "end" });
});

test("非法的约束轴值被拒", () => {
  const runtime = runtimeWithComponent();
  runtime.execute(envelope(3, [{ type: "component.instantiate", payload: { node: instanceNode("instance:1") } }]));
  assert.throws(
    () => runtime.execute(envelope(4, [{
      type: "component.override",
      payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { constraints: { horizontal: "middle", vertical: "start" } } },
    }])),
    /horizontal constraint must be one of/,
  );
  assert.throws(
    () => runtime.execute(envelope(4, [{
      type: "component.override",
      payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { constraints: { horizontal: "start", vertical: "nowhere" } } },
    }])),
    /vertical constraint must be one of/,
  );
});

test("改约束不改组件定义：组件定义改了也不该把实例的覆盖抹掉", () => {
  const runtime = runtimeWithComponent();
  runtime.execute(envelope(3, [{ type: "component.instantiate", payload: { node: instanceNode("instance:1") } }]));
  runtime.execute(envelope(4, [{
    type: "component.override",
    payload: { instanceId: "instance:1", sourceNodeId: "label", patch: { constraints: { horizontal: "end", vertical: "start" } } },
  }]));
  // 组件定义里的源节点被改了一下（这里改外观，模拟「定义后续又调整了」）。
  runtime.execute(envelope(5, [{ type: "node.patch", payload: { id: "label", patch: { name: "新标签" } } }]));
  assert.deepEqual(runtime.snapshot().nodes["instance:1--label"]?.constraints, { horizontal: "end", vertical: "start" });
});
