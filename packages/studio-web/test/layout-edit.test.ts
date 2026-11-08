import assert from "node:assert/strict";
import test from "node:test";
import { defaultLayout, type LayoutSpec } from "@ufira/design-schema";
import { addGridTrack, clampOpacity, defaultGridSpec, opacityToPercent, percentToOpacity, removeGridTrack, resolvePadding, switchLayoutMode } from "../src/layout-edit";

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

test("switching to grid supplies a default track configuration", () => {
  const result = switchLayoutMode(defaultLayout(), "grid");
  assert.equal(result.mode, "grid");
  assert.ok(result.grid);
  assert.equal(result.grid.columns.length, 2);
  assert.equal(result.grid.rows.length, 1);
  // grid 与 stack 是平级的两种模式，方向不适用。
  assert.equal(result.direction, undefined);
});

test("switching away from grid clears the track configuration", () => {
  // 留着 grid 配置会让「这个容器到底怎么排版」变得含糊，schema 也会拒绝。
  const grid = switchLayoutMode(defaultLayout(), "grid");
  const back = switchLayoutMode(grid, "absolute");
  assert.equal(back.grid, undefined);
  assert.equal(back.mode, "absolute");
});

test("switching to grid keeps an existing track configuration", () => {
  const grid = switchLayoutMode(defaultLayout(), "grid");
  const again = switchLayoutMode(grid, "grid");
  assert.deepEqual(again.grid, grid.grid);
});

test("addGridTrack gives each track type its own default parameters", () => {
  assert.deepEqual(addGridTrack([], "fixed"), [{ type: "fixed", size: 100 }]);
  assert.deepEqual(addGridTrack([], "fraction"), [{ type: "fraction", weight: 1 }]);
  assert.deepEqual(addGridTrack([], "auto"), [{ type: "auto" }]);
  assert.deepEqual(addGridTrack([], "min-content"), [{ type: "min-content" }]);
  assert.deepEqual(addGridTrack([], "max-content"), [{ type: "max-content" }]);
});

test("removeGridTrack keeps at least one track", () => {
  // 没有轨道的 grid 容器无法排版。
  const tracks = [{ type: "auto" as const }];
  assert.deepEqual(removeGridTrack(tracks, 0), tracks);
  const two = [{ type: "auto" as const }, { type: "fixed" as const, size: 10 }];
  assert.deepEqual(removeGridTrack(two, 0), [two[1]]);
});

test("defaultGridSpec is a usable starting point", () => {
  const spec = defaultGridSpec();
  assert.equal(spec.columns.length, 2);
  assert.equal(spec.rowGap, 0);
  assert.equal(spec.columnGap, 0);
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
