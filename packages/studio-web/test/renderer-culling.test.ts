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

test("cullScene drops off-screen roots and their off-screen children", () => {
  const visible = node("visible", 10, 10, 100, 100, [node("child", 1000, 1000)]);
  const hidden = node("hidden", 5000, 5000);
  const culled = cullScene([visible, hidden], viewport);
  assert.deepEqual(culled.map(item => item.id), ["visible"]);
  // 激进策略（默认）：子节点也在视口外，就不画了——省下的就是渲染开销。
  assert.deepEqual(culled[0]?.children.map(item => item.id), []);
});

test("保守策略只裁根节点，整棵子树照旧保留", () => {
  const visible = node("visible", 10, 10, 100, 100, [node("child", 1000, 1000)]);
  const hidden = node("hidden", 5000, 5000);
  const culled = cullScene([visible, hidden], viewport, { mode: "conservative" });
  assert.deepEqual(culled.map(item => item.id), ["visible"]);
  assert.deepEqual(culled[0]?.children.map(item => item.id), ["child"]);
});

test("子节点跑出父盒子（overflow visible）时父节点仍然保留", () => {
  // 父盒子在视口外，但子节点在视口里：父节点不能被丢，否则子节点跟着消失。
  const parent = node("parent", 5000, 5000, 100, 100, [node("child", 100, 100, 50, 50)]);
  const culled = cullScene([parent], viewport);
  assert.deepEqual(culled.map(item => item.id), ["parent"]);
  assert.deepEqual(culled[0]?.children.map(item => item.id), ["child"]);
});

test("安全边界把阴影与描边算进来", () => {
  // 盒子在视口（含 64px 外扩）之外，但阴影甩进来 100px：不能裁掉。
  const shadowed: SceneNode = {
    ...node("shadowed", 1050, 100, 50, 50),
    shadow: { x: 0, y: 0, blur: 200, color: "#000" },
  };
  assert.deepEqual(cullScene([shadowed], viewport).map(item => item.id), ["shadowed"]);
  // 关掉安全边界就按盒子裁：它被裁掉了。
  assert.deepEqual(cullScene([shadowed], viewport, { safeBounds: false }).map(item => item.id), []);
});

test("旋转节点按旋转后的 AABB 裁剪", () => {
  // 盒子整块在视口（含外扩）之外，转 45° 之后有一角转了进来。
  const rotated: SceneNode = { ...node("rotated", -110, 100, 40, 100), rotation: 45 };
  assert.deepEqual(cullScene([rotated], viewport).map(item => item.id), ["rotated"]);
  // 不转的话整块在外面，会被裁掉。
  assert.deepEqual(cullScene([node("plain", -110, 100, 40, 100)], viewport).map(item => item.id), []);
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
