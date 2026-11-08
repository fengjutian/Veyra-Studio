import assert from "node:assert/strict";
import test from "node:test";
import { toggleAnchorType, type EditableAnchor } from "../src/path-edit";

const line: EditableAnchor[] = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }];

test("a corner point becomes a smooth point with collinear handles", () => {
  const next = toggleAnchorType(line, 1, false);
  const anchor = next[1]!;
  assert.ok(anchor.handleIn);
  assert.ok(anchor.handleOut);
  // 三点共线：手柄落在切线上，长度各取到邻居距离的 1/3。
  assert.ok(Math.abs(anchor.handleIn.x - 50 / 3 * 2) < 1e-9);
  assert.ok(Math.abs(anchor.handleIn.y) < 1e-9);
  assert.ok(Math.abs(anchor.handleOut.x - (50 + 50 / 3)) < 1e-9);
  // 邻居本身不被改动。
  assert.deepEqual(next[0], line[0]);
  assert.deepEqual(next[2], line[2]);
});

test("handles point along the tangent of the neighbours", () => {
  const bent: EditableAnchor[] = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }];
  const next = toggleAnchorType(bent, 1, false);
  const anchor = next[1]!;
  // 邻居连线是水平的，所以切线也水平：两个手柄的 y 都等于锚点的 y。
  assert.ok(Math.abs(anchor.handleIn!.y - 50) < 1e-9);
  assert.ok(Math.abs(anchor.handleOut!.y - 50) < 1e-9);
  assert.ok(anchor.handleIn!.x < 50 && anchor.handleOut!.x > 50);
});

test("a smooth point goes back to a corner with no handles", () => {
  const smooth = toggleAnchorType(line, 1, false);
  const back = toggleAnchorType(smooth, 1, false);
  assert.equal(back[1]!.handleIn, undefined);
  assert.equal(back[1]!.handleOut, undefined);
  assert.deepEqual(back, line);
});

test("open path endpoints only get the inner handle", () => {
  const first = toggleAnchorType(line, 0, false)[0]!;
  assert.equal(first.handleIn, undefined);
  assert.ok(first.handleOut);

  const last = toggleAnchorType(line, 2, false)[2]!;
  assert.ok(last.handleIn);
  assert.equal(last.handleOut, undefined);
});

test("closed paths give every anchor both handles", () => {
  const square: EditableAnchor[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const next = toggleAnchorType(square, 0, true);
  assert.ok(next[0]!.handleIn);
  assert.ok(next[0]!.handleOut);
});

test("coincident points are left alone", () => {
  const degenerate: EditableAnchor[] = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
  const next = toggleAnchorType(degenerate, 1, false);
  assert.equal(next[1]!.handleIn, undefined);
  assert.equal(next[1]!.handleOut, undefined);
});

test("an out of range index is a no-op", () => {
  assert.deepEqual(toggleAnchorType(line, 9, false), line);
});
