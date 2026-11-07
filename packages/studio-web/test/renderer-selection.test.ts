import assert from "node:assert/strict";
import test from "node:test";
import { handleCenters, handleCursor, hitTestHandle, resizeRect, selectedBoxes, selectionBounds } from "../src/renderer/selection";
import { paintSelectionOverlay } from "../src/renderer/selection-overlay";
import type { SceneNode } from "../src/renderer/scene";

function node(id: string, x: number, y: number, width = 100, height = 50, children: SceneNode[] = []): SceneNode {
  return { id, type: "frame", box: { x, y, width, height }, clip: true, opacity: 1, strokeWidth: 0, radius: 0, children };
}

test("selectionBounds unions boxes and ignores missing entries", () => {
  assert.equal(selectionBounds([]), undefined);
  assert.equal(selectionBounds([undefined]), undefined);
  assert.deepEqual(selectionBounds([{ x: 10, y: 20, width: 100, height: 50 }, { x: 60, y: 0, width: 100, height: 200 }]), { x: 10, y: 0, width: 150, height: 200 });
});

test("handleCenters places the eight handles around the box", () => {
  const centers = handleCenters({ x: 0, y: 0, width: 100, height: 50 });
  assert.deepEqual(centers.nw, { x: 0, y: 0 });
  assert.deepEqual(centers.n, { x: 50, y: 0 });
  assert.deepEqual(centers.se, { x: 100, y: 50 });
  assert.deepEqual(centers.w, { x: 0, y: 25 });
});

test("hitTestHandle only matches inside the handle square", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 50 };
  assert.equal(hitTestHandle(bounds, { x: 100, y: 50 }, 8), "se");
  assert.equal(hitTestHandle(bounds, { x: 96, y: 50 }, 8), "se");
  assert.equal(hitTestHandle(bounds, { x: 92, y: 50 }, 8), undefined);
  assert.equal(hitTestHandle(bounds, { x: 50, y: 25 }, 8), undefined);
});

test("resizeRect keeps the opposite edge anchored and clamps to minSize", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 50 };
  assert.deepEqual(resizeRect(bounds, "se", 20, 10), { x: 0, y: 0, width: 120, height: 60 });
  assert.deepEqual(resizeRect(bounds, "nw", 20, 10), { x: 20, y: 10, width: 80, height: 40 });
  assert.deepEqual(resizeRect(bounds, "e", -200, 0, 10), { x: 0, y: 0, width: 10, height: 50 });
  assert.deepEqual(resizeRect(bounds, "n", 0, 100, 5), { x: 0, y: 45, width: 100, height: 5 });
});

test("handleCursor maps every handle to a resize cursor", () => {
  assert.equal(handleCursor("nw"), "nwse-resize");
  assert.equal(handleCursor("e"), "ew-resize");
  assert.equal(handleCursor("n"), "ns-resize");
});

test("selectedBoxes walks nested nodes", () => {
  const inner = node("inner", 10, 10, 20, 20);
  const root = node("root", 0, 0, 100, 100, [inner]);
  assert.deepEqual(selectedBoxes([root], ["inner"]), [{ x: 10, y: 10, width: 20, height: 20 }]);
  assert.deepEqual(selectedBoxes([root], ["missing"]), []);
});

function fakeContext() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  const context = {
    calls,
    save: record("save"),
    restore: record("restore"),
    strokeRect: record("strokeRect"),
    fillRect: record("fillRect"),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { context, calls };
}

test("paintSelectionOverlay draws an outline and eight handles", () => {
  const { context, calls } = fakeContext();
  paintSelectionOverlay(context, { x: 0, y: 0, width: 100, height: 50 });
  assert.equal(calls.filter(call => call.name === "strokeRect").length, 9); // 1 轮廓 + 8 手柄
  assert.equal(calls.filter(call => call.name === "fillRect").length, 8);
});

test("outlineOnly skips handles", () => {
  const { context, calls } = fakeContext();
  paintSelectionOverlay(context, { x: 0, y: 0, width: 100, height: 50 }, { outlineOnly: true });
  assert.equal(calls.filter(call => call.name === "fillRect").length, 0);
  assert.equal(calls.filter(call => call.name === "strokeRect").length, 1);
});

test("handles keep their screen size when zoomed", () => {
  const { context, calls } = fakeContext();
  paintSelectionOverlay(context, { x: 0, y: 0, width: 100, height: 50 }, { zoom: 2, handleSize: 8 });
  const firstHandle = calls.find(call => call.name === "fillRect");
  // 8px 手柄在 zoom=2 下是 4 个场景单位，边长 4。
  assert.equal(firstHandle?.args[2], 4);
});
