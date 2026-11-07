import assert from "node:assert/strict";
import test from "node:test";
import { containsPoint, hitTest, hitTestStack } from "../src/renderer/hit-test";
import type { SceneNode } from "../src/renderer/scene";

function node(id: string, x: number, y: number, width = 100, height = 100, overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    type: "frame",
    box: { x, y, width, height },
    clip: true,
    opacity: 1,
    strokeWidth: 0,
    radius: 0,
    children: [],
    ...overrides,
  };
}

test("returns the topmost node when siblings overlap", () => {
  const scene = [node("bottom", 0, 0), node("top", 50, 50)];
  assert.equal(hitTest(scene, { x: 60, y: 60 }), "top");
  assert.equal(hitTest(scene, { x: 10, y: 10 }), "bottom");
});

test("children win over their parent and the stack goes deepest-first", () => {
  const child = node("child", 20, 20, 40, 40);
  const parent = node("parent", 0, 0, 200, 200, { children: [child] });
  assert.equal(hitTest([parent], { x: 30, y: 30 }), "child");
  assert.deepEqual(hitTestStack([parent], { x: 30, y: 30 }), ["child", "parent"]);
  assert.deepEqual(hitTestStack([parent], { x: 150, y: 150 }), ["parent"]);
});

test("misses outside every box and reports an empty stack", () => {
  assert.equal(hitTest([node("a", 0, 0)], { x: 500, y: 500 }), undefined);
  assert.deepEqual(hitTestStack([node("a", 0, 0)], { x: -10, y: 5 }), []);
});

test("transparent nodes are skipped, clicks fall through to the node below", () => {
  const under = node("under", 0, 0);
  const invisible = node("invisible", 0, 0, 100, 100, { opacity: 0 });
  assert.equal(hitTest([under, invisible], { x: 50, y: 50 }), "under");
});

test("ellipse corners are not clickable, the centre is", () => {
  const dot = node("dot", 0, 0, 100, 100, { type: "ellipse" });
  assert.equal(containsPoint(dot, { x: 50, y: 50 }), true);
  assert.equal(containsPoint(dot, { x: 1, y: 1 }), false);
  assert.equal(hitTest([dot], { x: 1, y: 1 }), undefined);
});

test("children outside a clipped parent are not hittable", () => {
  const child = node("child", 300, 0, 100, 100);
  const parent = node("parent", 0, 0, 200, 200, { children: [child] });
  assert.equal(hitTest([parent], { x: 350, y: 50 }), undefined);
  assert.equal(hitTest([parent], { x: 50, y: 50 }), "parent");
});

test("text leaves are hittable and return their own id", () => {
  const text = node("text", 10, 10, 120, 24, { type: "text" });
  assert.equal(hitTest([text], { x: 20, y: 20 }), "text");
});
