import assert from "node:assert/strict";
import test from "node:test";
import { compareHits, pointFromEvent } from "../src/renderer/hit-test-compare";

test("compareHits flags disabled or mismatched results", () => {
  assert.deepEqual(compareHits("node:1", "node:1"), { canvasId: "node:1", domId: "node:1", matches: true });
  assert.equal(compareHits("node:1", "node:2").matches, false);
  // 空白处点击：两边都没有命中，算一致。
  assert.equal(compareHits(undefined, undefined).matches, true);
  assert.equal(compareHits("node:1", undefined).matches, false);
  assert.equal(compareHits(undefined, "node:1").matches, false);
});

test("pointFromEvent converts client coordinates through the zoom transform", () => {
  const rect = { left: 100, top: 50 };
  assert.deepEqual(pointFromEvent(rect, 200, 150, 1), { x: 100, y: 100 });
  assert.deepEqual(pointFromEvent(rect, 300, 250, 2), { x: 100, y: 100 });
  // zoom 为 0 或非法时按 1 处理，避免除零。
  assert.deepEqual(pointFromEvent(rect, 120, 70, 0), { x: 20, y: 20 });
});
