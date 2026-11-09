import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import {
  canHostChildren,
  dropContainerFor,
  isDescendantOf,
  planCanvasReparent,
  topLevelDraggedIds,
} from "../src/canvas-reparent";

/**
 * 画布上的跨容器拖拽。
 *
 * 规格见 `docs/editor-tooling-roadmap.md` §0.3.0。要证明的是**约束**与
 * **坐标换算**：拖进容器要真的换父级、坐标要换算到新父级的局部坐标，
 * 该拒绝的要拒绝并给出人话。
 */

function frame(id: string, parentId = "page:1"): DesignNode {
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
  };
}

function text(id: string, parentId = "page:1"): DesignNode {
  return { ...frame(id, parentId), type: "text", text: id, fontFamily: "Inter", fontSize: 14, lineHeight: 20 };
}

/** 一页文档：page:1 下有 outer（absolute），outer 里有 inner，inner 里有个叶子节点 box。 */
function scene(): DesignDocument {
  const document = createDocument("doc:1", "拖拽");
  const outer = frame("outer");
  const inner = frame("inner", "outer");
  const box = text("box", "inner");
  const loose = frame("loose");
  outer.childIds = ["inner"];
  inner.childIds = ["box"];
  document.nodes = { outer, inner, box, loose };
  document.pages["page:1"]!.childIds = ["outer", "loose"];
  return document;
}

test("能容纳子节点的类型", () => {
  assert.equal(canHostChildren({ type: "frame" }), true);
  assert.equal(canHostChildren({ type: "component" }), true);
  assert.equal(canHostChildren({ type: "instance" }), true);
  assert.equal(canHostChildren({ type: "text" }), false);
  assert.equal(canHostChildren({ type: "rectangle" }), false);
});

test("落点容器：命中容器自己就是它，命中叶子是它的容器祖先", () => {
  const document = scene();
  assert.equal(dropContainerFor(document, "inner"), "inner");
  assert.equal(dropContainerFor(document, "box"), "inner");
  assert.equal(dropContainerFor(document, "outer"), "outer");
  // 页面层：没有容器祖先。
  assert.equal(dropContainerFor(document, undefined), undefined);
});

test("拖进容器：换父级，坐标换算到新父级的局部坐标", () => {
  const document = scene();
  const plan = planCanvasReparent({
    document,
    draggedIds: ["box"],
    containerId: "outer",
    // 页面坐标：盒子左上角在 (120, 60)。
    boxes: { box: { x: 120, y: 60 } },
    // outer 的内容盒原点在页面坐标 (100, 40)。
    containerOrigin: { x: 100, y: 40 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.commands[0]?.type, "node.reparent");
  assert.deepEqual(plan.commands[0]?.payload, { id: "box", parentId: "outer" });
  const patch = plan.commands[1];
  assert.equal(patch?.type, "node.patch");
  assert.deepEqual(
    (patch?.payload as { patch: { layout: { x: number; y: number } } }).patch.layout,
    { ...document.nodes.box!.layout, x: 20, y: 20 },
  );
});

test("拖到页面层：换到页面父级，坐标就是页面坐标", () => {
  const document = scene();
  const plan = planCanvasReparent({
    document,
    draggedIds: ["box"],
    containerId: "page:1",
    boxes: { box: { x: 300, y: 200 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.containerIsPage, true);
  assert.deepEqual(plan.commands[0]?.payload, { id: "box", parentId: "page:1" });
  assert.equal(
    (plan.commands[1]?.payload as { patch: { layout: { x: number } } }).patch.layout.x,
    300,
  );
});

test("本来就在这个容器里：只改坐标，不发 reparent", () => {
  const document = scene();
  const plan = planCanvasReparent({
    document,
    draggedIds: ["box"],
    containerId: "inner",
    boxes: { box: { x: 20, y: 30 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0]?.type, "node.patch");
});

test("拒绝：拖进自己的子级里", () => {
  const document = scene();
  const plan = planCanvasReparent({
    document,
    draggedIds: ["outer"],
    containerId: "inner",
    boxes: { outer: { x: 0, y: 0 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /子级/);
});

test("拒绝：拖进自动布局容器（位置由布局决定）", () => {
  const document = scene();
  const stack = { ...frame("stack"), layout: { ...defaultLayout(), mode: "stack" as const } };
  document.nodes.stack = stack;
  document.pages["page:1"]!.childIds.push("stack");
  const plan = planCanvasReparent({
    document,
    draggedIds: ["loose"],
    containerId: "stack",
    boxes: { loose: { x: 0, y: 0 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.reason, /自动布局/);
});

test("拒绝：拖进不能容纳子节点的节点、隐藏容器、锁定容器", () => {
  const document = scene();
  document.nodes.leaf = text("leaf");
  const hidden = { ...frame("hidden"), visible: false };
  const locked = { ...frame("locked"), locked: true };
  document.nodes.hidden = hidden;
  document.nodes.locked = locked;

  const leaf = planCanvasReparent({ document, draggedIds: ["loose"], containerId: "leaf", boxes: { loose: { x: 0, y: 0 } }, containerOrigin: { x: 0, y: 0 } });
  assert.equal(leaf.ok, false);
  if (!leaf.ok) assert.match(leaf.reason, /不能容纳子节点/);

  const hiddenPlan = planCanvasReparent({ document, draggedIds: ["loose"], containerId: "hidden", boxes: { loose: { x: 0, y: 0 } }, containerOrigin: { x: 0, y: 0 } });
  assert.equal(hiddenPlan.ok, false);
  if (!hiddenPlan.ok) assert.match(hiddenPlan.reason, /隐藏/);

  const lockedPlan = planCanvasReparent({ document, draggedIds: ["loose"], containerId: "locked", boxes: { loose: { x: 0, y: 0 } }, containerOrigin: { x: 0, y: 0 } });
  assert.equal(lockedPlan.ok, false);
  if (!lockedPlan.ok) assert.match(lockedPlan.reason, /锁定/);
});

test("多选：父子同时被选中时只搬顶层那个", () => {
  const document = scene();
  assert.deepEqual(topLevelDraggedIds(document, ["box", "inner"]), ["inner"]);
  const plan = planCanvasReparent({
    document,
    draggedIds: ["box", "inner", "loose"],
    containerId: "outer",
    boxes: { inner: { x: 10, y: 10 }, loose: { x: 40, y: 50 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  // inner 已经在 outer 里（只改坐标），loose 从页面搬进 outer（换父级 + 改坐标）；
  // box 被 inner 盖住，不单独搬。
  assert.equal(plan.commands.length, 3);
  const reparents = plan.commands.filter(command => command.type === "node.reparent");
  assert.deepEqual(reparents.map(command => (command.payload as { id: string }).id), ["loose"]);
});

test("子树判定", () => {
  const document = scene();
  assert.equal(isDescendantOf(document, "outer", "box"), true);
  assert.equal(isDescendantOf(document, "outer", "loose"), false);
  assert.equal(isDescendantOf(document, "inner", "outer"), false);
});
