import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_BOUNDS, CANVAS_HEIGHT, CANVAS_WIDTH, clampZoom, contentBounds, fitZoom, selectionBounds, zoomPercent, zoomStep } from "../src/canvas-zoom";

test("keeps the canvas bounds in coordinate semantics", () => {
  // Regression guard: `position: "css"` makes Moveable read right/bottom as CSS
  // offsets, which collapses the bounds into a 0x0 box and teleports dragged
  // nodes to -(width, height). The bounds must stay a plain coordinate rectangle.
  assert.deepEqual(CANVAS_BOUNDS, { left: 0, top: 0, right: CANVAS_WIDTH, bottom: CANVAS_HEIGHT });
  assert.equal("position" in CANVAS_BOUNDS, false);
});

test("clamps the zoom factor into the supported range", () => {
  assert.equal(clampZoom(0.01), 0.1);
  assert.equal(clampZoom(99), 4);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(Number.NaN), 1);
});

test("steps the zoom factor by ten percent", () => {
  assert.equal(zoomStep(1, 1), 1.1);
  assert.equal(zoomStep(1, -1), 0.9);
});

test("a step does not leave the supported range", () => {
  assert.equal(zoomStep(4, 1), 4);
  assert.equal(zoomStep(0.1, -1), 0.1);
});

test("shows the zoom factor as a percentage", () => {
  assert.equal(zoomPercent(1), 100);
  assert.equal(zoomPercent(0.25), 25);
});

test("fits the content into the viewport", () => {
  // A 480x340 content in a 480x340 viewport fits exactly.
  assert.equal(fitZoom({ width: 480, height: 340 }, { width: 480, height: 340 }), 1);
  assert.equal(fitZoom({ width: 960, height: 680 }, { width: 480, height: 340 }), 0.5);
});

test("the fit zoom keeps room for the padding", () => {
  assert.equal(fitZoom({ width: 960, height: 680 }, { width: 500, height: 360 }, 20), 0.5);
});

test("the fit zoom never enlarges beyond 100 percent", () => {
  assert.equal(fitZoom({ width: 1, height: 1 }, { width: 100, height: 100 }), 1);
});

test("computes the bounding box of the laid out nodes", () => {
  const bounds = contentBounds({
    a: { x: 10, y: 20, width: 100, height: 50 },
    b: { x: 60, y: 90, width: 40, height: 30 },
  });
  assert.deepEqual(bounds, { x: 10, y: 20, width: 100, height: 100 });
});

test("ignores empty boxes when computing the bounding box", () => {
  const bounds = contentBounds({
    a: { x: 0, y: 0, width: 0, height: 0 },
    b: { x: 5, y: 5, width: 10, height: 10 },
  });
  assert.deepEqual(bounds, { x: 5, y: 5, width: 10, height: 10 });
});

test("reports no bounds for an empty page", () => {
  assert.equal(contentBounds({}), undefined);
});

test("computes the bounding box of a selection", () => {
  const bounds = selectionBounds({
    a: { x: 10, y: 20, width: 100, height: 50 },
    b: { x: 60, y: 90, width: 40, height: 30 },
    c: { x: 300, y: 300, width: 40, height: 30 },
  }, ["a", "b"]);
  assert.deepEqual(bounds, { x: 10, y: 20, width: 100, height: 100 });
});

test("a selection without resolvable boxes has no bounds", () => {
  assert.equal(selectionBounds({}, ["a"]), undefined);
  assert.equal(selectionBounds({ a: { x: 0, y: 0, width: 0, height: 0 } }, ["a"]), undefined);
});
