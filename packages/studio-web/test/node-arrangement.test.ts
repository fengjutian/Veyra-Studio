import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { arrangeNodes } from "../src/node-arrangement";

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

function frame(id: string, x: number, y: number, width: number, height: number): DesignNode {
  return { id, type: "frame", name: id, parentId: "page:1", childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x, y, width, height }, appearance: defaultAppearance() };
}
