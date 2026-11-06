import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { arrangeNodes, nudgeNodes, nudgeReorder } from "../src/node-arrangement";

test("aligns nodes against their shared bounding box", () => {
  const nodes = [frame("a", 10, 20, 40, 20), frame("b", 90, 60, 20, 40)];
  assert.deepEqual(arrangeNodes(nodes, "left").map(change => change.layout.x), [10, 10]);
  assert.deepEqual(arrangeNodes(nodes, "centerX").map(change => change.layout.x), [40, 50]);
  assert.deepEqual(arrangeNodes(nodes, "bottom").map(change => change.layout.y), [80, 60]);
});

test("distributes nodes while preserving the outer edges", () => {
  const nodes = [frame("a", 0, 0, 10, 10), frame("b", 25, 30, 20, 20), frame("c", 90, 100, 10, 10)];
  assert.deepEqual(arrangeNodes(nodes, "distributeX").map(change => change.layout.x), [0, 40, 90]);
  assert.deepEqual(arrangeNodes(nodes, "distributeY").map(change => change.layout.y), [0, 45, 100]);
});

test("requires three nodes for distribution", () => {
  assert.deepEqual(arrangeNodes([frame("a", 0, 0, 10, 10), frame("b", 10, 0, 10, 10)], "distributeX"), []);
});

test("nudges every selected node by the same delta", () => {
  const changes = nudgeNodes([frame("a", 10, 20, 10, 10), frame("b", -5, 8, 10, 10)], 10, -1);
  assert.deepEqual(changes.map(change => [change.layout.x, change.layout.y]), [[20, 19], [5, 7]]);
});

test("moves an auto-layout child earlier or later by one slot", () => {
  const siblings = ["a", "b", "c"];
  assert.equal(nudgeReorder(siblings, "b", -1, 0), 0);
  assert.equal(nudgeReorder(siblings, "b", 0, -1), 0);
  assert.equal(nudgeReorder(siblings, "b", 1, 0), 2);
  assert.equal(nudgeReorder(siblings, "b", 0, 1), 2);
});

test("keeps auto-layout order at the edges and for unknown nodes", () => {
  const siblings = ["a", "b", "c"];
  assert.equal(nudgeReorder(siblings, "a", -1, 0), undefined);
  assert.equal(nudgeReorder(siblings, "c", 1, 0), undefined);
  assert.equal(nudgeReorder(siblings, "a", 0, 1), 1);
  assert.equal(nudgeReorder(siblings, "missing", 1, 0), undefined);
  assert.equal(nudgeReorder(siblings, "b", 0, 0), undefined);
  // 斜向输入（两个轴都被按下）同样按一个方向处理。
  assert.equal(nudgeReorder(siblings, "a", 1, 1), 1);
});

function frame(id: string, x: number, y: number, width: number, height: number): DesignNode {
  return { id, type: "frame", name: id, parentId: "page:1", childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x, y, width, height }, appearance: defaultAppearance() };
}
