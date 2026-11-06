import assert from "node:assert/strict";
import test from "node:test";
import { clampScroll, panScroll } from "../src/canvas-pan";

test("the canvas follows the hand", () => {
  const next = panScroll({ scrollLeft: 100, scrollTop: 50 }, 30, 20);
  assert.equal(next.scrollLeft, 70);
  assert.equal(next.scrollTop, 30);
});

test("panning left and up grows the scroll offset", () => {
  const next = panScroll({ scrollLeft: 100, scrollTop: 50 }, -30, -20);
  assert.equal(next.scrollLeft, 130);
  assert.equal(next.scrollTop, 70);
});

test("the scroll offset stays inside the scrollable range", () => {
  assert.equal(clampScroll(-40, 200), 0);
  assert.equal(clampScroll(400, 200), 200);
  assert.equal(clampScroll(120, 200), 120);
  assert.equal(clampScroll(Number.NaN, 200), 0);
});
