import assert from "node:assert/strict";
import test from "node:test";
import { nodesInRect, rectFromPoints, rectsIntersect } from "../src/renderer/marquee";
import { paintMarquee } from "../src/renderer/selection-overlay";
import type { SceneNode } from "../src/renderer/scene";

function node(id: string, x: number, y: number, width = 100, height = 50, children: SceneNode[] = []): SceneNode {
  return { id, type: "frame", box: { x, y, width, height }, clip: true, opacity: 1, strokeWidth: 0, radius: 0, children };
}

test("rectFromPoints normalises drag direction", () => {
  assert.deepEqual(rectFromPoints({ x: 10, y: 20 }, { x: 30, y: 5 }), { x: 10, y: 5, width: 20, height: 15 });
  assert.deepEqual(rectFromPoints({ x: 30, y: 5 }, { x: 10, y: 20 }), { x: 10, y: 5, width: 20, height: 15 });
});

test("rectsIntersect handles overlap, touching edges and separation", () => {
  const base = { x: 0, y: 0, width: 100, height: 50 };
  assert.equal(rectsIntersect(base, { x: 50, y: 25, width: 100, height: 100 }), true);
  assert.equal(rectsIntersect(base, { x: 100, y: 0, width: 10, height: 10 }), true); // 贴边
  assert.equal(rectsIntersect(base, { x: 101, y: 0, width: 10, height: 10 }), false);
  assert.equal(rectsIntersect(base, { x: 0, y: 51, width: 10, height: 10 }), false);
});

test("marquee selects intersecting top-level nodes and skips children", () => {
  const child = node("child", 20, 20, 10, 10);
  const card = node("card", 0, 0, 100, 100, [child]);
  const far = node("far", 400, 400, 50, 50);
  const selected = nodesInRect([card, far], { x: 50, y: 50, width: 100, height: 100 });
  assert.deepEqual(selected, ["card"]);
});

test("empty marquee selects nothing", () => {
  assert.deepEqual(nodesInRect([node("a", 0, 0)], { x: 10, y: 10, width: 0, height: 0 }), []);
});

test("paintMarquee fills and strokes the rect with zoom-aware line width", () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  const context = {
    save: record("save"),
    restore: record("restore"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;

  paintMarquee(context, { x: 10, y: 20, width: 100, height: 50 }, { zoom: 2 });
  assert.equal(calls.filter(call => call.name === "fillRect").length, 1);
  assert.equal(calls.filter(call => call.name === "strokeRect").length, 1);
  // zoom=2 时线宽是 0.5 场景单位。
  assert.equal((context as unknown as { lineWidth: number }).lineWidth, 0.5);
});
