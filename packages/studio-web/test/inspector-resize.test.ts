import assert from "node:assert/strict";
import test from "node:test";
import { MAX_INSPECTOR_WIDTH, MIN_INSPECTOR_WIDTH, clampInspectorWidth, defaultInspectorWidth } from "../src/inspector-resize";

test("inspector width stays within the panel and viewport limits", () => {
  assert.equal(clampInspectorWidth(100, 1600), MIN_INSPECTOR_WIDTH);
  assert.equal(clampInspectorWidth(900, 1600), MAX_INSPECTOR_WIDTH);
  assert.equal(clampInspectorWidth(600, 800), 440);
});

test("default inspector width follows the responsive layout", () => {
  assert.equal(defaultInspectorWidth(1000), 256);
  assert.equal(defaultInspectorWidth(1300), 304);
  assert.equal(defaultInspectorWidth(1600), 320);
});
