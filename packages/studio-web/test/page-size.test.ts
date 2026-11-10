import assert from "node:assert/strict";
import test from "node:test";
import { PAGE_SIZE_PRESETS, matchingPageSizePreset, pageSize } from "../src/page-size";
import { canStartCanvasPan, centeredCanvasScroll } from "../src/canvas-pan";

test("legacy pages keep the original viewport", () => {
  assert.deepEqual(pageSize(undefined), { width: 960, height: 680 });
  assert.deepEqual(pageSize({}), { width: 960, height: 680 });
});

test("offers grouped desktop, tablet, mobile, presentation and social presets", () => {
  assert.deepEqual(new Set(PAGE_SIZE_PRESETS.map(item => item.group)), new Set(["桌面", "平板", "手机", "演示", "社交媒体"]));
  assert.ok(PAGE_SIZE_PRESETS.length >= 13);
  assert.equal(matchingPageSizePreset(390, 844), "mobile-iphone");
  assert.equal(matchingPageSizePreset(777, 555), "custom");
});

test("workspace drag pans without stealing page editing gestures", () => {
  assert.equal(canStartCanvasPan(0, false, false), true);
  assert.equal(canStartCanvasPan(0, false, true), false);
  assert.equal(canStartCanvasPan(1, false, true), true);
  assert.equal(canStartCanvasPan(0, true, true), true);
});

test("virtual canvas gutters keep room on every side", () => {
  assert.deepEqual(centeredCanvasScroll(2400, 1600, 1200, 800), { scrollLeft: 600, scrollTop: 400 });
  assert.deepEqual(centeredCanvasScroll(800, 600, 1200, 800), { scrollLeft: 0, scrollTop: 0 });
});
