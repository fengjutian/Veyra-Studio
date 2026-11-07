import assert from "node:assert/strict";
import test from "node:test";
import { snapBox, snapTargetsFromScene } from "../src/renderer/snapping";
import { paintSnapGuides } from "../src/renderer/selection-overlay";

const target = (nodeId: string, x: number, y: number, width = 100, height = 50) => ({ nodeId, box: { x, y, width, height } });

test("snaps a near left edge and reports a vertical guide", () => {
  const result = snapBox({ x: 98, y: 200, width: 50, height: 50 }, [target("t", 100, 0)], { threshold: 6 });
  assert.equal(result.deltaX, 2);
  assert.equal(result.deltaY, 0);
  assert.deepEqual(result.guides, [{ orientation: "vertical", position: 100, targetNodeId: "t" }]);
});

test("snaps centres on both axes", () => {
  const result = snapBox({ x: 0, y: 0, width: 100, height: 100 }, [target("t", 0, 0, 200, 200)], { threshold: 6 });
  // 左边与上边正好对齐，两轴都产生辅助线。
  assert.equal(result.deltaX, 0);
  assert.equal(result.deltaY, 0);
  assert.equal(result.guides.length, 2);

  const near = snapBox({ x: 96, y: 0, width: 8, height: 200 }, [target("t", 0, 0, 200, 200)], { threshold: 6 });
  // 左边 96 距 100 有 4；中心 100 正好对齐 100。
  assert.equal(near.deltaX, 0);
  assert.equal(near.guides[0]?.orientation, "vertical");
});

test("ignores targets outside the threshold", () => {
  const result = snapBox({ x: 0, y: 0, width: 10, height: 10 }, [target("t", 100, 100)], { threshold: 5 });
  assert.deepEqual(result, { deltaX: 0, deltaY: 0, guides: [] });
});

test("picks the nearest of several candidates", () => {
  const result = snapBox({ x: 104, y: 0, width: 10, height: 10 }, [target("far", 106, 0), target("near", 105, 0)], { threshold: 6 });
  assert.equal(result.deltaX, 1);
  assert.equal(result.guides[0]?.targetNodeId, "near");
});

test("snaps both axes independently", () => {
  const result = snapBox({ x: 98, y: 47, width: 10, height: 10 }, [target("t", 100, 50, 10, 10)], { threshold: 6 });
  // Y 轴最近的候选是「移动后的中心 52」对齐目标中心 50，所以位移是 -2。
  assert.equal(result.deltaX, 2);
  assert.equal(result.deltaY, -2);
  assert.equal(result.guides.length, 2);
});

test("snapTargetsFromScene excludes the dragged selection", () => {
  const scene = [
    { id: "a", box: { x: 0, y: 0, width: 10, height: 10 }, children: [{ id: "child" }] },
    { id: "b", box: { x: 20, y: 0, width: 10, height: 10 }, children: [] },
  ];
  assert.deepEqual(snapTargetsFromScene(scene, ["a"]).map(item => item.nodeId), ["b"]);
});

test("paintSnapGuides draws one line per guide with zoom-aware width", () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  const context = {
    save: record("save"),
    restore: record("restore"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    strokeStyle: "",
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;

  paintSnapGuides(context, [{ orientation: "vertical", position: 100 }, { orientation: "horizontal", position: 200 }], { width: 960, height: 680 }, { zoom: 2 });
  assert.equal(calls.filter(call => call.name === "moveTo").length, 2);
  assert.equal(calls.filter(call => call.name === "lineTo").length, 2);
  assert.deepEqual(calls.find(call => call.name === "moveTo" && call.args[0] === 100)?.args, [100, 0]);
  assert.deepEqual(calls.find(call => call.name === "moveTo" && call.args[0] === 0)?.args, [0, 200]);
  assert.equal((context as unknown as { lineWidth: number }).lineWidth, 0.5);
});
