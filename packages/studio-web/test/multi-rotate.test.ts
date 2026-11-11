import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "@ufira/design-runtime";
import { computePageLayout } from "@ufira/design-layout";
import { buildScene } from "../src/renderer/scene";
import { parentContentOrigin } from "../src/canvas-reparent";
import { groupPivot, planRotation, rotateTargets, rotationRelayoutNotice, toParentLocalLayout, type RotateTarget } from "../src/renderer/multi-rotate";

function target(id: string, x: number, y: number, width = 100, height = 100, rotation = 0): RotateTarget {
  return { id, box: { x, y, width, height }, rotation };
}

test("组枢轴是合并包围盒的中心", () => {
  const pivot = groupPivot([{ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 0, width: 100, height: 100 }]);
  assert.deepEqual(pivot, { x: 150, y: 50 });
});

test("组旋转是刚性变换：相对位置与尺寸都不变", () => {
  const targets = [target("a", 0, 0), target("b", 200, 0)];
  const pivot = { x: 150, y: 50 };
  const outcomes = rotateTargets(targets, pivot, 90);

  // 尺寸不变。
  assert.deepEqual(outcomes[0]!.box.width, 100);
  assert.deepEqual(outcomes[0]!.box.height, 100);
  // 中心绕枢轴转了 90°。
  assert.deepEqual(outcomes[0]!.center, { x: 150, y: -50 });
  assert.deepEqual(outcomes[1]!.center, { x: 150, y: 150 });
  // 两个中心的距离不变（刚性）。
  const before = Math.hypot(250 - 50, 50 - 50);
  const after = Math.hypot(outcomes[1]!.center.x - outcomes[0]!.center.x, outcomes[1]!.center.y - outcomes[0]!.center.y);
  assert.ok(Math.abs(before - after) < 1e-9, `${before} vs ${after}`);
  // 各自的角度加上同一个增量。
  assert.equal(outcomes[0]!.rotation, 90);
  assert.equal(outcomes[1]!.rotation, 90);
});

test("每个节点的角度都加上同一个增量", () => {
  const outcomes = rotateTargets([target("a", 0, 0, 100, 100, 30), target("b", 200, 0, 100, 100, -20)], { x: 150, y: 50 }, 15);
  assert.equal(outcomes[0]!.rotation, 45);
  assert.equal(outcomes[1]!.rotation, -5);
});

test("Shift 时多选按增量吸附，单选按绝对角度吸附", () => {
  const multi = planRotation({
    targets: [target("a", 0, 0), target("b", 200, 0)],
    pivot: { x: 150, y: 50 },
    pointerAngle: 40,
    startPointerAngle: 0,
    snap: true,
  });
  // 增量 40° 吸附到 45°。
  assert.equal(multi.angle, 45);
  assert.equal(multi.items[0]!.rotation, 45);

  const single = planRotation({
    targets: [target("a", 0, 0, 100, 100, 20)],
    pivot: { x: 50, y: 50 },
    pointerAngle: 40,
    startPointerAngle: 0,
    snap: true,
  });
  // 绝对角 20 + 40 = 60°，吸附到 60°（15 的整数倍）。
  assert.equal(single.angle, 60);
  // 单选枢轴是自己的中心，位置不动。
  assert.deepEqual(single.items[0]!.box, { x: 0, y: 0, width: 100, height: 100 });
});

test("不按 Shift 时角度就是指针的增量", () => {
  const preview = planRotation({
    targets: [target("a", 0, 0)],
    pivot: { x: 50, y: 50 },
    pointerAngle: 37,
    startPointerAngle: 0,
  });
  assert.equal(preview.angle, 37);
  assert.equal(preview.items[0]!.rotation, 37);
});

test("旋转提交传绝对坐标：嵌套节点的 x/y 不会被减两次父级原点", () => {
  // 父容器在页面 (100, 60)，子节点存的是相对父级的局部坐标 (20, 30)。
  const layout = { ...defaultLayout(), x: 20, y: 30, width: 40, height: 40 };
  const origin = { x: 100, y: 60 };
  const absolute = { x: layout.x + origin.x, y: layout.y + origin.y };

  // 新路径：旋转提交传绝对坐标，提交层换算一次 → 局部坐标不变。
  const fixed = toParentLocalLayout(layout, absolute, origin);
  assert.deepEqual([fixed.x, fixed.y], [layout.x, layout.y]);

  // 旧路径：旋转提交传的是存储里的局部坐标，提交层又减了一次父级原点。
  // 结果是节点被挪到 (-80, -30)，跑到父容器外面去了——顶层节点因为原点是 (0,0) 才看不出来。
  const buggy = toParentLocalLayout(layout, { x: layout.x, y: layout.y }, origin);
  assert.deepEqual([buggy.x, buggy.y], [-80, -30]);
  assert.notDeepEqual([buggy.x, buggy.y], [layout.x, layout.y]);
});

test("旋转嵌套节点后位置不变：走真实布局引擎与运行时", () => {
  const document = createDocument("project:1", "Demo");
  const parent: DesignNode = {
    id: "frame:parent",
    type: "frame",
    name: "父容器",
    parentId: "page:1",
    childIds: ["frame:child"],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), mode: "absolute", x: 100, y: 60, width: 400, height: 300 },
    appearance: defaultAppearance(),
  };
  const child: DesignNode = {
    id: "frame:child",
    type: "frame",
    name: "子节点",
    parentId: "frame:parent",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 20, y: 30, width: 40, height: 40 },
    appearance: defaultAppearance(),
  };
  document.nodes = { "frame:parent": parent, "frame:child": child };
  document.pages["page:1"]!.childIds = ["frame:parent"];

  const layout = computePageLayout(document, "page:1", { viewport: { width: 960, height: 680 } });
  // 子节点的绝对盒 = 局部坐标 + 父级内容盒原点。
  assert.deepEqual([layout.boxes["frame:child"]!.x, layout.boxes["frame:child"]!.y], [120, 90]);
  const origin = parentContentOrigin(document, buildScene(document, "page:1", layout.boxes), "frame:parent");
  assert.deepEqual(origin, { x: 100, y: 60 });

  // 转 30°：绕自己的中心，位置不动。
  const preview = planRotation({
    targets: [{ id: "frame:child", box: layout.boxes["frame:child"]!, rotation: 0 }],
    pivot: { x: 140, y: 110 },
    pointerAngle: 30,
    startPointerAngle: 0,
  });
  assert.deepEqual([preview.items[0]!.box.x, preview.items[0]!.box.y], [120, 90]);
  assert.equal(preview.items[0]!.rotation, 30);

  // 提交：绝对坐标换算成父级局部坐标（只换算一次），角度一起带上。
  const patch = { ...toParentLocalLayout(document.nodes["frame:child"]!.layout, preview.items[0]!.box, origin), rotation: preview.items[0]!.rotation };
  assert.deepEqual([patch.x, patch.y], [20, 30]);
  assert.equal(patch.rotation, 30);

  const runtime = new DesignRuntime(document);
  runtime.execute({
    commandId: "cmd:1",
    documentId: "project:1",
    baseRevision: 0,
    actor: { type: "human", id: "local-user" },
    commands: [{ type: "node.patch", payload: { id: "frame:child", patch: { layout: patch } } }],
  });
  const after = runtime.snapshot();
  const afterLayout = computePageLayout(after, "page:1", { viewport: { width: 960, height: 680 } });
  // 位置没变，角度写进去了。
  assert.deepEqual([afterLayout.boxes["frame:child"]!.x, afterLayout.boxes["frame:child"]!.y], [120, 90]);
  assert.equal(after.nodes["frame:child"]!.layout.rotation, 30);
});

test("旋转后的自动布局重排提示只在自动布局父级下出现", () => {  const document = createDocument("project:1", "Demo");
  const absolute: DesignNode = { id: "frame:abs", type: "frame", name: "abs", parentId: "page:1", childIds: ["frame:abs-child"], visible: true, locked: false, layout: { ...defaultLayout(), mode: "absolute" }, appearance: defaultAppearance() };
  const stack: DesignNode = { id: "frame:stack", type: "frame", name: "stack", parentId: "page:1", childIds: ["frame:stack-child"], visible: true, locked: false, layout: { ...defaultLayout(), mode: "stack" }, appearance: defaultAppearance() };
  const absoluteChild: DesignNode = { id: "frame:abs-child", type: "frame", name: "abs-child", parentId: "frame:abs", childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
  const stackChild: DesignNode = { id: "frame:stack-child", type: "frame", name: "stack-child", parentId: "frame:stack", childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
  document.nodes = { "frame:abs": absolute, "frame:stack": stack, "frame:abs-child": absoluteChild, "frame:stack-child": stackChild };

  // 绝对布局的父级不受影响。
  assert.equal(rotationRelayoutNotice(document, ["frame:abs-child"]), undefined);
  // 自动布局的父级要提示：布局引擎不按旋转重排兄弟节点。
  const notice = rotationRelayoutNotice(document, ["frame:stack-child"]);
  assert.ok(notice);
  assert.match(notice, /自动布局/);
});
