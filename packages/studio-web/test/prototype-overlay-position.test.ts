import assert from "node:assert/strict";
import test from "node:test";
import { OVERLAY_MARGIN, overlayOffset } from "../src/prototype/overlay-position";

const viewport = { width: 960, height: 680 };

test("centers the overlay in the viewport", () => {
  const offset = overlayOffset({ positionType: "center", viewport, overlay: { x: 10, y: 10, width: 200, height: 100 } });
  assert.deepEqual(offset, { dx: 370, dy: 280 });
});

test("pins corners with the shared margin", () => {
  const overlay = { x: 0, y: 0, width: 200, height: 100 };
  assert.deepEqual(overlayOffset({ positionType: "top-left", viewport, overlay }), { dx: OVERLAY_MARGIN, dy: OVERLAY_MARGIN });
  assert.deepEqual(overlayOffset({ positionType: "top-right", viewport, overlay }), { dx: 960 - 200 - OVERLAY_MARGIN, dy: OVERLAY_MARGIN });
  assert.deepEqual(overlayOffset({ positionType: "bottom-left", viewport, overlay }), { dx: OVERLAY_MARGIN, dy: 680 - 100 - OVERLAY_MARGIN });
  assert.deepEqual(overlayOffset({ positionType: "bottom-right", viewport, overlay }), { dx: 960 - 200 - OVERLAY_MARGIN, dy: 680 - 100 - OVERLAY_MARGIN });
  assert.deepEqual(overlayOffset({ positionType: "top-center", viewport, overlay }), { dx: (960 - 200) / 2, dy: OVERLAY_MARGIN });
});

test("manual positioning is relative to the trigger and then shifted into place", () => {
  const offset = overlayOffset({
    positionType: "manual",
    viewport,
    overlay: { x: 10, y: 10, width: 120, height: 80 },
    anchor: { x: 100, y: 50, width: 40, height: 20 },
    manual: { x: 8, y: 12 },
  });
  // 目标左上角 = 触发节点左上角 + 偏移；dx/dy 把 overlay 从它自己的位置挪过去。
  assert.deepEqual(offset, { dx: 108 - 10, dy: 62 - 10 });
});

test("manual positioning without an anchor falls back to the viewport origin", () => {
  const offset = overlayOffset({
    positionType: "manual",
    viewport,
    overlay: { x: 0, y: 0, width: 50, height: 50 },
    manual: { x: 8, y: 12 },
  });
  assert.deepEqual(offset, { dx: 8, dy: 12 });
});
