import assert from "node:assert/strict";
import test from "node:test";
import { defaultLayout, type LayoutSpec } from "@ufira/design-schema";
import { clampOpacity, opacityToPercent, percentToOpacity, resolvePadding, switchLayoutMode } from "../src/layout-edit";

test("switching to stack keeps the existing direction", () => {
  const layout: LayoutSpec = { ...defaultLayout(), mode: "stack", direction: "horizontal" };
  const result = switchLayoutMode(layout, "stack");
  assert.equal(result.mode, "stack");
  assert.equal(result.direction, "horizontal");
});

test("switching to stack without a direction falls back to vertical", () => {
  const result = switchLayoutMode(defaultLayout(), "stack");
  assert.equal(result.mode, "stack");
  assert.equal(result.direction, "vertical");
});

test("switching back to absolute clears the direction", () => {
  const layout: LayoutSpec = { ...defaultLayout(), mode: "stack", direction: "horizontal" };
  const result = switchLayoutMode(layout, "absolute");
  assert.equal(result.mode, "absolute");
  assert.equal(result.direction, undefined);
});

test("switching the mode preserves the remaining layout values", () => {
  const layout: LayoutSpec = { ...defaultLayout(), x: 12, y: 34, width: 200, height: 100, widthMode: "fill" };
  const result = switchLayoutMode(layout, "stack");
  assert.equal(result.x, 12);
  assert.equal(result.y, 34);
  assert.equal(result.width, 200);
  assert.equal(result.height, 100);
  assert.equal(result.widthMode, "fill");
});

test("resolves missing padding to zero on every side", () => {
  assert.deepEqual(resolvePadding(defaultLayout()), { top: 0, right: 0, bottom: 0, left: 0 });
});

test("resolves an existing padding unchanged", () => {
  const layout: LayoutSpec = { ...defaultLayout(), padding: { top: 1, right: 2, bottom: 3, left: 4 } };
  assert.deepEqual(resolvePadding(layout), { top: 1, right: 2, bottom: 3, left: 4 });
});

test("clamps opacity into the accepted range", () => {
  assert.equal(clampOpacity(0.5), 0.5);
  assert.equal(clampOpacity(-1), 0);
  assert.equal(clampOpacity(3), 1);
  assert.equal(clampOpacity(Number.NaN), 1);
});

test("converts between opacity ratio and percentage", () => {
  assert.equal(opacityToPercent(0.42), 42);
  assert.equal(percentToOpacity(42), 0.42);
  assert.equal(percentToOpacity(150), 1);
  assert.equal(percentToOpacity(-10), 0);
});
