import assert from "node:assert/strict";
import test from "node:test";
import { countSceneNodes, cullScene, intersects, type CullViewport } from "../src/renderer/culling";
import type { SceneNode } from "../src/renderer/scene";

function node(id: string, x: number, y: number, width = 100, height = 100, children: SceneNode[] = []): SceneNode {
  return {
    id,
    type: "frame",
    box: { x, y, width, height },
    clip: true,
    opacity: 1,
    strokeWidth: 0,
    radius: 0,
    children,
  };
}

const viewport: CullViewport = { x: 0, y: 0, width: 960, height: 680 };

test("intersects handles overlap, touching edges and separation", () => {
  assert.equal(intersects({ x: 10, y: 10, width: 100, height: 100 }, viewport), true);
  assert.equal(intersects({ x: 960, y: 0, width: 50, height: 50 }, viewport), true); // 贴边
  assert.equal(intersects({ x: 961, y: 0, width: 50, height: 50 }, viewport), false);
  assert.equal(intersects({ x: -50, y: -50, width: 40, height: 40 }, viewport), false);
  assert.equal(intersects({ x: -50, y: -50, width: 60, height: 60 }, viewport), true); // 跨过原点
});

test("margin keeps近 edge shapes visible", () => {
  const justOutside = { x: 1000, y: 0, width: 50, height: 50 };
  assert.equal(intersects(justOutside, viewport), false);
  assert.equal(intersects(justOutside, viewport, 64), true);
});

test("cullScene drops off-screen roots but keeps their subtrees intact", () => {
  const visible = node("visible", 10, 10, 100, 100, [node("child", 1000, 1000)]);
  const hidden = node("hidden", 5000, 5000);
  const culled = cullScene([visible, hidden], viewport);
  assert.deepEqual(culled.map(item => item.id), ["visible"]);
  // 子节点即使跑到视口外也不删，避免半截内容/阴影消失。
  assert.deepEqual(culled[0]?.children.map(item => item.id), ["child"]);
});

test("empty viewport means no culling", () => {
  const nodes = [node("a", 0, 0), node("b", 5000, 5000)];
  assert.deepEqual(cullScene(nodes, undefined), nodes);
  assert.deepEqual(cullScene(nodes, { x: 0, y: 0, width: 0, height: 0 }), nodes);
});

test("countSceneNodes walks the whole tree", () => {
  const scene = [node("a", 0, 0, 10, 10, [node("b", 0, 0, 10, 10, [node("c", 0, 0, 10, 10)])]), node("d", 0, 0)];
  assert.equal(countSceneNodes(scene), 4);
});
