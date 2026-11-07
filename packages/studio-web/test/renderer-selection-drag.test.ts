import assert from "node:assert/strict";
import test from "node:test";
import { applyBoxOverrides, layoutPatches, offsetSubtreeBoxes, resizeBox } from "../src/renderer/selection-drag";
import type { SceneNode } from "../src/renderer/scene";

function node(id: string, x: number, y: number, width = 100, height = 50, children: SceneNode[] = []): SceneNode {
  return { id, type: "frame", box: { x, y, width, height }, clip: true, opacity: 1, strokeWidth: 0, radius: 0, children };
}

test("dragging offsets the whole selected subtree but not siblings", () => {
  const child = node("child", 10, 10, 20, 20);
  const group = node("group", 0, 0, 100, 100, [child]);
  const sibling = node("sibling", 200, 0, 50, 50);
  const overrides = offsetSubtreeBoxes([group, sibling], new Set(["group"]), 30, 40);
  assert.deepEqual(overrides.group, { x: 30, y: 40, width: 100, height: 100 });
  assert.deepEqual(overrides.child, { x: 40, y: 50, width: 20, height: 20 });
  assert.equal(overrides.sibling, undefined);
});

test("nested selection offsets each selected subtree once", () => {
  const child = node("child", 10, 10, 20, 20);
  const group = node("group", 0, 0, 100, 100, [child]);
  const overrides = offsetSubtreeBoxes([group], new Set(["group", "child"]), 5, 5);
  // 子节点被外层拖动覆盖，不会因为自己也选中而叠加两次位移。
  assert.deepEqual(overrides.child, { x: 15, y: 15, width: 20, height: 20 });
});

test("applyBoxOverrides only clones affected nodes", () => {
  const a = node("a", 0, 0);
  const b = node("b", 100, 0);
  const untouched = applyBoxOverrides([a, b], {});
  assert.equal(untouched, untouched);
  assert.equal(untouched[0], a);

  const shifted = applyBoxOverrides([a, b], { a: { x: 10, y: 0, width: 100, height: 50 } });
  assert.equal(shifted[0]?.box.x, 10);
  assert.equal(shifted[1], b);
  assert.equal(a.box.x, 0); // 原场景不被修改
});

test("resizeBox anchors the opposite edge and clamps to the minimum", () => {
  const box = { x: 10, y: 20, width: 100, height: 60 };
  assert.deepEqual(resizeBox(box, "se", 20, 10), { x: 10, y: 20, width: 120, height: 70 });
  assert.deepEqual(resizeBox(box, "nw", 10, 5), { x: 20, y: 25, width: 90, height: 55 });
  assert.deepEqual(resizeBox(box, "e", -500, 0), { x: 10, y: 20, width: 4, height: 60 });
});

test("layoutPatches skips ids without boxes", () => {
  const patches = layoutPatches({ a: { x: 1, y: 2, width: 3, height: 4 } }, ["a", "missing"]);
  assert.deepEqual(patches, [{ id: "a", box: { x: 1, y: 2, width: 3, height: 4 } }]);
});
