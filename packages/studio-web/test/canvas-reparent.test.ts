import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "@ufira/design-runtime";
import {
  canHostChildren,
  dropContainerFor,
  emptiedParents,
  findDropContainerInScene,
  isDescendantOf,
  planCanvasReparent,
  previewCenter,
  topLevelDraggedIds,
} from "../src/canvas-reparent";
import type { SceneNode } from "../src/renderer/scene";

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

test("编组内部若干子节点整组搬出：全部换父级，相对位置不变", () => {
  const document = scene();
  // group 里有三个兄弟节点，整组拖到另一个容器 target。
  const group = frame("group", "outer");
  const g1 = frame("g1", "group");
  const g2 = frame("g2", "group");
  const g3 = frame("g3", "group");
  const target = frame("target");
  group.childIds = ["g1", "g2", "g3"];
  document.nodes = { ...document.nodes, group, g1, g2, g3, target };
  document.pages["page:1"]!.childIds = ["outer", "loose", "target"];

  // 三个节点在页面坐标上的位置（相对彼此间隔 10px）。
  const boxes = {
    g1: { x: 200, y: 100 },
    g2: { x: 230, y: 100 },
    g3: { x: 260, y: 100 },
  };
  const plan = planCanvasReparent({
    document,
    draggedIds: ["g1", "g2", "g3"],
    containerId: "target",
    boxes,
    // target 的内容盒原点在页面坐标 (180, 80)。
    containerOrigin: { x: 180, y: 80 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const reparents = plan.commands.filter(command => command.type === "node.reparent");
  assert.equal(reparents.length, 3);
  assert.deepEqual(
    reparents.map(command => (command.payload as { parentId: string }).parentId),
    ["target", "target", "target"],
  );
  // 局部坐标 = 页面坐标 - 新父级原点，彼此间隔仍是 30 / 10。
  const locals = plan.commands
    .filter(command => command.type === "node.patch")
    .map(command => (command.payload as { patch: { layout: { x: number; y: number } } }).patch.layout);
  assert.deepEqual(locals.map(layout => layout.x), [20, 50, 80]);
  assert.deepEqual(locals.map(layout => layout.y), [20, 20, 20]);
});

test("整组搬出后原编组变空：空编组是否留着由调用方决定", () => {
  const document = scene();
  const group = frame("group", "outer");
  const g1 = frame("g1", "group");
  group.childIds = ["g1"];
  document.nodes = { ...document.nodes, group, g1 };
  document.pages["page:1"]!.childIds.push("group");
  const plan = planCanvasReparent({
    document,
    draggedIds: ["g1"],
    containerId: "outer",
    boxes: { g1: { x: 0, y: 0 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  // 搬回原来的祖先时，编组会变空——这条命令序列里应当包含删除空编组的那一步。
  const deletes = plan.commands.filter(command => command.type === "node.delete");
  assert.equal(deletes.length, 1);
  assert.deepEqual((deletes[0]?.payload as { id: string }).id, "group");
});

test("部分搬移时编组保留：没有掏空就不删", () => {
  const document = scene();
  const group = frame("group", "outer");
  const g1 = frame("g1", "group");
  const g2 = frame("g2", "group");
  group.childIds = ["g1", "g2"];
  document.nodes = { ...document.nodes, group, g1, g2 };
  const plan = planCanvasReparent({
    document,
    draggedIds: ["g1"],
    containerId: "outer",
    boxes: { g1: { x: 0, y: 0 } },
    containerOrigin: { x: 0, y: 0 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.commands.filter(command => command.type === "node.delete").length, 0);
});

test("掏空判定：只算这次真被搬走的节点", () => {
  const document = scene();
  const group = frame("group", "outer");
  const g1 = frame("g1", "group");
  const g2 = frame("g2", "group");
  group.childIds = ["g1", "g2"];
  document.nodes = { ...document.nodes, group, g1, g2 };
  // 两个都搬走 → group 被掏空。
  assert.deepEqual(emptiedParents(document, ["g1", "g2"], "outer"), ["group"]);
  // 只搬一个 → 还剩一个，不掏空。
  assert.deepEqual(emptiedParents(document, ["g1"], "outer"), []);
});

function sceneNode(id: string, x: number, y: number, width: number, height: number, children: SceneNode[] = []): SceneNode {
  return { id, type: "frame", box: { x, y, width, height }, clip: true, opacity: 1, strokeWidth: 0, radius: 0, children };
}

test("落点容器：场景里找包含该点的最深容器", () => {
  const inner = sceneNode("inner", 20, 20, 50, 50);
  const group = sceneNode("group", 0, 0, 200, 100, [inner]);
  const target = sceneNode("target", 300, 0, 200, 100);
  const scene = [group, target];

  assert.equal(findDropContainerInScene(scene, { x: 30, y: 30 }, new Set()), "inner");
  assert.equal(findDropContainerInScene(scene, { x: 100, y: 80 }, new Set()), "group");
  assert.equal(findDropContainerInScene(scene, { x: 350, y: 50 }, new Set()), "target");
  // 空白处：落在页面层。
  assert.equal(findDropContainerInScene(scene, { x: 250, y: 50 }, new Set()), undefined);
});

test("落点容器：被拖动的节点连同子树整体排除", () => {
  const moved = sceneNode("moved", 10, 10, 30, 30);
  const group = sceneNode("group", 0, 0, 200, 100, [moved]);
  const scene = [group];

  // 点落在被拖节点自己身上 → 它被排除，回落到它的容器。
  assert.equal(findDropContainerInScene(scene, { x: 20, y: 20 }, new Set(["moved"])), "group");
  // 点落在被拖节点的区域但不在容器内 → 没有容器可落（页面层）。
  const loose = sceneNode("loose", 100, 100, 30, 30);
  assert.equal(findDropContainerInScene([loose], { x: 110, y: 110 }, new Set(["loose"])), undefined);
});

test("预览中心：多节点的包围盒中心", () => {
  assert.deepEqual(
    previewCenter([
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 40, y: 0, width: 20, height: 20 },
    ]),
    { x: 30, y: 10 },
  );
  assert.equal(previewCenter([]), undefined);
});

test("整组搬出在运行时落地：子节点换父级、坐标是局部坐标、编组消失", () => {
  const document = scene();
  const group = frame("group", "outer");
  const g1 = frame("g1", "group");
  const g2 = frame("g2", "group");
  const target = frame("target");
  group.childIds = ["g1", "g2"];
  document.nodes.outer!.childIds = ["inner", "group"];
  document.nodes = { ...document.nodes, group, g1, g2, target };
  document.pages["page:1"]!.childIds = ["outer", "loose", "target"];

  const plan = planCanvasReparent({
    document,
    draggedIds: ["g1", "g2"],
    containerId: "target",
    boxes: { g1: { x: 200, y: 100 }, g2: { x: 230, y: 100 } },
    containerOrigin: { x: 180, y: 80 },
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  const runtime = new DesignRuntime(document);
  runtime.execute({
    commandId: "cmd:1",
    documentId: document.id,
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: plan.commands,
  });
  const after = runtime.snapshot();
  // 两个子节点都进了 target，编组被掏空后删除。
  assert.deepEqual(after.nodes.target?.childIds, ["g1", "g2"]);
  assert.equal(after.nodes.group, undefined);
  assert.equal(after.nodes.g1?.parentId, "target");
  // 坐标写的是新父级的局部坐标：页面坐标 200/230 - target 原点 180 = 20/50。
  assert.equal(after.nodes.g1?.layout.x, 20);
  assert.equal(after.nodes.g2?.layout.x, 50);
  assert.equal(after.nodes.g1?.layout.y, 20);
});
