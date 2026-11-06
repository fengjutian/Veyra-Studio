import assert from "node:assert/strict";
import test from "node:test";
import type { ComputedBox } from "@ufira/design-layout";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "@ufira/design-runtime";
import { planGroup, planUngroup } from "../src/grouping";

const box = (x: number, y: number, width: number, height: number): ComputedBox => ({ x, y, width, height } as ComputedBox);

function frame(id: string, parentId: string, layout: { x: number; y: number; width: number; height: number }): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), ...layout },
    appearance: defaultAppearance(),
  };
}

function documentWith(nodes: DesignNode[], parentId = "page:1"): DesignDocument {
  const document = createDocument("project:1", "Demo");
  document.nodes = Object.fromEntries(nodes.map(node => [node.id, node]));
  document.pages[parentId]!.childIds = nodes.filter(node => node.parentId === parentId).map(node => node.id);
  return document;
}

function envelope(revision: number, commands: unknown[]) {
  return { commandId: `cmd:${revision}`, documentId: "project:1", baseRevision: revision, actor: { type: "human" as const, id: "local-user" }, commands: commands as never };
}

test("编组把同级对象包进一个按包围盒定位的 frame", () => {
  const document = documentWith([
    frame("frame:a", "page:1", { x: 10, y: 20, width: 100, height: 50 }),
    frame("frame:b", "page:1", { x: 200, y: 40, width: 50, height: 50 }),
  ]);
  const boxes = { "page:1": box(0, 0, 960, 680), "frame:a": box(10, 20, 100, 50), "frame:b": box(200, 40, 50, 50) };

  const plan = planGroup(document, ["frame:a", "frame:b"], boxes, { id: "frame:group" });
  assert.ok(plan);
  assert.equal(plan.commands[0]?.type, "node.create");

  const runtime = new DesignRuntime(document);
  runtime.execute(envelope(0, plan.commands));

  const after = runtime.snapshot();
  const group = after.nodes["frame:group"]!;
  assert.equal(group.parentId, "page:1");
  assert.deepEqual({ x: group.layout.x, y: group.layout.y, width: group.layout.width, height: group.layout.height }, { x: 10, y: 20, width: 240, height: 70 });
  assert.deepEqual(group.childIds, ["frame:a", "frame:b"]);
  // 子节点坐标变成相对编组，视觉位置不变。
  assert.deepEqual([after.nodes["frame:a"]!.layout.x, after.nodes["frame:a"]!.layout.y], [0, 0]);
  assert.deepEqual([after.nodes["frame:b"]!.layout.x, after.nodes["frame:b"]!.layout.y], [190, 20]);
  assert.deepEqual(after.pages["page:1"]!.childIds, ["frame:group"]);
});

test("嵌套编组按父级原点换算坐标", () => {
  const parent = frame("frame:parent", "page:1", { x: 50, y: 60, width: 400, height: 300 });
  const first = frame("frame:a", "frame:parent", { x: 80, y: 90, width: 40, height: 40 });
  const second = frame("frame:b", "frame:parent", { x: 160, y: 90, width: 40, height: 40 });
  parent.childIds = ["frame:a", "frame:b"];
  const document = documentWith([parent, first, second]);
  const boxes = {
    "page:1": box(0, 0, 960, 680),
    "frame:parent": box(50, 60, 400, 300),
    "frame:a": box(80, 90, 40, 40),
    "frame:b": box(160, 90, 40, 40),
  };

  const plan = planGroup(document, ["frame:a", "frame:b"], boxes, { id: "frame:group" });
  assert.ok(plan);
  const runtime = new DesignRuntime(document);
  runtime.execute(envelope(0, plan.commands));

  const after = runtime.snapshot();
  const group = after.nodes["frame:group"]!;
  assert.equal(group.parentId, "frame:parent");
  assert.deepEqual({ x: group.layout.x, y: group.layout.y, width: group.layout.width, height: group.layout.height }, { x: 30, y: 30, width: 120, height: 40 });
  assert.deepEqual(after.nodes["frame:a"]!.layout.x, 0);
  assert.deepEqual(after.nodes["frame:b"]!.layout.x, 80);
});

test("取消编组把子节点放回原位置并删掉空 frame", () => {
  const group = frame("frame:group", "page:1", { x: 10, y: 20, width: 240, height: 70 });
  const first = frame("frame:a", "frame:group", { x: 0, y: 0, width: 100, height: 50 });
  const second = frame("frame:b", "frame:group", { x: 190, y: 20, width: 50, height: 50 });
  group.childIds = ["frame:a", "frame:b"];
  const document = documentWith([group, first, second]);
  document.pages["page:1"]!.childIds = ["frame:group"];

  const boxes = {
    "page:1": box(0, 0, 960, 680),
    "frame:group": box(10, 20, 240, 70),
    "frame:a": box(10, 20, 100, 50),
    "frame:b": box(200, 40, 50, 50),
  };
  const plan = planUngroup(document, "frame:group", boxes);
  assert.ok(plan);

  const runtime = new DesignRuntime(document);
  runtime.execute(envelope(0, plan.commands));

  const after = runtime.snapshot();
  assert.equal(after.nodes["frame:group"], undefined);
  assert.deepEqual(after.pages["page:1"]!.childIds, ["frame:a", "frame:b"]);
  assert.deepEqual([after.nodes["frame:a"]!.layout.x, after.nodes["frame:a"]!.layout.y], [10, 20]);
  assert.deepEqual([after.nodes["frame:b"]!.layout.x, after.nodes["frame:b"]!.layout.y], [200, 40]);
});

test("跨父级、单个对象、缺盒子的选区都不编组", () => {
  const parent = frame("frame:parent", "page:1", { x: 100, y: 100, width: 200, height: 200 });
  const child = frame("frame:c", "frame:parent", { x: 120, y: 120, width: 10, height: 10 });
  parent.childIds = ["frame:c"];
  const document = documentWith([
    frame("frame:a", "page:1", { x: 0, y: 0, width: 10, height: 10 }),
    parent,
    child,
  ]);
  const boxes = {
    "page:1": box(0, 0, 960, 680),
    "frame:a": box(0, 0, 10, 10),
    "frame:parent": box(100, 100, 200, 200),
    "frame:c": box(120, 120, 10, 10),
  };

  assert.equal(planGroup(document, ["frame:a"], boxes, { id: "frame:group" }), undefined);
  assert.equal(planGroup(document, ["frame:a", "frame:c"], boxes, { id: "frame:group" }), undefined);
  assert.equal(planGroup(document, ["frame:a", "frame:parent"], { "page:1": box(0, 0, 960, 680) }, { id: "frame:group" }), undefined);
  assert.equal(planUngroup(document, "frame:a", boxes), undefined);
});
