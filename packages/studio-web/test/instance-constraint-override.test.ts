import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { collectInstanceConstraintTargets, findInstanceCopy, INSTANCE_CONSTRAINT_OVERRIDE_SUPPORTED, planInstanceConstraintOverride } from "../src/instance-constraint-override";

/**
 * 一个带物化副本的实例。
 *
 * 副本 id 是 `instanceId--sourceId`（design-runtime 物化时的规则），覆盖记录用的键是
 * 组件定义里的 sourceNodeId。
 */
function documentWithInstance(): DesignDocument {
  const document = createDocument("project:1", "Demo");
  const instance: DesignNode = {
    id: "instance:1",
    type: "instance",
    name: "按钮",
    parentId: "page:1",
    childIds: ["instance:1--node:label"],
    visible: true,
    locked: false,
    componentId: "component:1",
    overrides: {},
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  const source: DesignNode = {
    id: "node:label",
    type: "frame",
    name: "标签",
    parentId: "component:root",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  const copy: DesignNode = {
    id: "instance:1--node:label",
    type: "frame",
    name: "标签",
    parentId: "instance:1",
    childIds: [],
    visible: true,
    locked: false,
    constraints: { horizontal: "end", vertical: "start" },
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  const plain: DesignNode = {
    id: "frame:plain",
    type: "frame",
    name: "普通节点",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  document.nodes = { "instance:1": instance, "node:label": source, "instance:1--node:label": copy, "frame:plain": plain };
  document.pages["page:1"]!.childIds = ["instance:1", "frame:plain"];
  return document;
}

test("能认出实例里的物化副本，并解析出源节点 id", () => {
  const document = documentWithInstance();
  assert.deepEqual(findInstanceCopy(document, "instance:1--node:label"), { instanceId: "instance:1", sourceNodeId: "node:label" });
  // 组件定义里的源节点与普通节点都不是副本。
  assert.equal(findInstanceCopy(document, "node:label"), undefined);
  assert.equal(findInstanceCopy(document, "frame:plain"), undefined);
});

test("实例里可覆盖约束的目标带着当前约束", () => {
  const document = documentWithInstance();
  const targets = collectInstanceConstraintTargets(document, "instance:1");
  assert.equal(targets.length, 1);
  assert.equal(targets[0]?.copyId, "instance:1--node:label");
  assert.equal(targets[0]?.sourceNodeId, "node:label");
  assert.deepEqual(targets[0]?.constraints, { horizontal: "end", vertical: "start" });
  // design-schema 的可覆盖字段白名单里还没有 constraints，所以现在一律不可覆盖。
  assert.equal(targets[0]?.overridable, false);
});

test("运行时没放行 constraints 时不规划命令，但把原因说清楚", () => {
  const document = documentWithInstance();
  const target = collectInstanceConstraintTargets(document, "instance:1")[0]!;
  const plan = planInstanceConstraintOverride(target, { horizontal: "center", vertical: "center" });
  assert.equal(plan.supported, false);
  assert.deepEqual(plan.patch, { constraints: { horizontal: "center", vertical: "center" } });
  // 原因要指名要改的字段：schema 的 OverrideField 与 runtime 的 component.override。
  assert.match(plan.reason ?? "", /OverrideField/);
  assert.match(plan.reason ?? "", /component\.override/);
  assert.equal(INSTANCE_CONSTRAINT_OVERRIDE_SUPPORTED, false);
});
