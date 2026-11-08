import assert from "node:assert/strict";
import test from "node:test";
import { closestSegment, commandsFromAnchors, insertAnchor, anchorsFromPath, segmentCount, type EditableAnchor } from "../src/path-edit";

const line: EditableAnchor[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

/** 一条从 (0,0) 到 (100,100) 的三次曲线。 */
const curve: EditableAnchor[] = [
  { x: 0, y: 0, handleOut: { x: 0, y: 60 } },
  { x: 100, y: 100, handleIn: { x: 100, y: 40 } },
];

test("counts segments for open and closed paths", () => {
  assert.equal(segmentCount(line, false), 1);
  assert.equal(segmentCount([...line, { x: 50, y: 50 }], false), 2);
  assert.equal(segmentCount([...line, { x: 50, y: 50 }], true), 3);
  assert.equal(segmentCount([{ x: 0, y: 0 }], true), 0);
});

test("finds the closest point on a straight segment", () => {
  const hit = closestSegment(line, false, { x: 40, y: 6 }, 10);
  assert.ok(hit);
  assert.equal(hit.index, 0);
  assert.ok(Math.abs(hit.t - 0.4) < 1e-9);
  assert.deepEqual(hit.point, { x: 40, y: 0 });
  assert.equal(hit.distance, 6);
});

test("ignores segments beyond the tolerance", () => {
  assert.equal(closestSegment(line, false, { x: 40, y: 40 }, 10), undefined);
});

test("finds the closest point on a cubic segment", () => {
  // 三次曲线在 t = 0.5 处的点是 (50, 50)。
  const hit = closestSegment(curve, false, { x: 50, y: 50 }, 4);
  assert.ok(hit);
  assert.ok(Math.abs(hit.t - 0.5) < 0.02, String(hit.t));
  assert.ok(hit.distance < 0.5);
});

test("inserting on a straight segment keeps it straight", () => {
  const next = insertAnchor(line, false, 0, 0.5);
  assert.equal(next.length, 3);
  assert.deepEqual(next[1], { x: 50, y: 0 });
  // 直线段不该被插出控制点。
  assert.equal(next[0]?.handleOut, undefined);
  assert.equal(next[2]?.handleIn, undefined);
});

test("splitting a cubic preserves the curve exactly", () => {
  const next = insertAnchor(curve, false, 0, 0.5);
  assert.equal(next.length, 3);
  const [start, middle, end] = next;
  // de Casteljau：t = 0.5 时每个控制点都是两端的中点。
  assert.deepEqual(start!.handleOut, { x: 0, y: 30 });
  assert.deepEqual(middle!.handleIn, { x: 25, y: 40 });
  assert.deepEqual(middle!.handleOut, { x: 75, y: 60 });
  assert.deepEqual(end!.handleIn, { x: 100, y: 70 });
  assert.deepEqual({ x: middle!.x, y: middle!.y }, { x: 50, y: 50 });
});

test("the split segments rebuild into the same three anchors", () => {
  const next = insertAnchor(curve, false, 0, 0.5);
  const commands = commandsFromAnchors(next, false);
  const roundTrip = anchorsFromPath(commands);
  assert.equal(roundTrip.length, 3);
  assert.ok(Math.abs(roundTrip[1]!.x - 50) < 1e-6);
  assert.ok(Math.abs(roundTrip[1]!.y - 50) < 1e-6);
});

test("inserting on the closing segment appends the anchor", () => {
  const square: EditableAnchor[] = [
    { x: 0, y: 0, handleIn: { x: 0, y: -10 } },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  const hit = closestSegment(square, true, { x: 50, y: 50 }, 4);
  assert.ok(hit);
  assert.equal(hit.index, 2);
  const next = insertAnchor(square, true, 2, 0.5);
  assert.equal(next.length, 4);
  // 闭合边从最后一个锚点 (100,100) 弯回第一个锚点 (0,0)：中点在两点的 de Casteljau 中点。
  assert.ok(Math.abs(next[3]!.x - 50) < 1e-6, String(next[3]!.x));
  assert.ok(Math.abs(next[3]!.y - 46.25) < 1e-6, String(next[3]!.y));
});

test("ignores out of range segment indices", () => {
  assert.deepEqual(insertAnchor(line, false, 5, 0.5), line);
});
