import assert from "node:assert/strict";
import test from "node:test";
import {
  angleDegrees,
  boxCenter,
  hitTestHandleRotated,
  hitTestRotationHandle,
  resizeRotatedBox,
  normalizeAngle,
  rotatePoint,
  rotationHandlePoint,
  rotatedBounds,
  rotatedCorners,
  rotatedHandleCenters,
  snapAngle,
  toLocalPoint,
  toRadians,
} from "../src/renderer/rotation";
import { handleCenters, type Rect } from "../src/renderer/selection";

const box: Rect = { x: 0, y: 0, width: 100, height: 50 };
const QUARTER = toRadians(90);

test("rotates a point around an origin", () => {
  const rotated = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, toRadians(90));
  assert.ok(Math.abs(rotated.x) < 1e-9);
  assert.ok(Math.abs(rotated.y - 10) < 1e-9);
});

test("local and world coordinates round trip", () => {
  const world = { x: 80, y: 12 };
  const local = toLocalPoint(world, box, toRadians(37));
  const back = rotatePoint(local, boxCenter(box), toRadians(37));
  assert.ok(Math.abs(back.x - world.x) < 1e-9);
  assert.ok(Math.abs(back.y - world.y) < 1e-9);
});

test("a 90 degree rotation swaps the bounding box", () => {
  assert.deepEqual(rotatedBounds(box, QUARTER), { x: 25, y: -25, width: 50, height: 100 });
});

test("corners follow the rotation", () => {
  const corners = rotatedCorners(box, QUARTER);
  // 左上角 (0,0) 绕中心转 90° 后到右上。
  assert.ok(Math.abs(corners[0].x - 75) < 1e-9);
  assert.ok(Math.abs(corners[0].y + 25) < 1e-9);
});

test("handle hit testing follows the rotated handle positions", () => {
  const rotated = rotatedHandleCenters(box, QUARTER);
  // 旋转后原来左上角的手柄跑到右上，用它的真实位置应当命中。
  assert.equal(hitTestHandleRotated(box, QUARTER, rotated.nw, 8), "nw");
  // 用未旋转时的位置则不该命中。
  assert.equal(hitTestHandleRotated(box, QUARTER, handleCenters(box).nw, 8) === "nw", false);
});

test("resizing a rotated box keeps the opposite corner fixed", () => {
  const radians = toRadians(30);
  const resized: Rect = { x: 0, y: 0, width: 140, height: 50 };
  const corrected = resizeRotatedBox(box, resized, "se", radians);
  // 对角（nw）在旋转后的世界坐标必须保持不变。
  const before = rotatedHandleCenters(box, radians).nw;
  const after = rotatedHandleCenters(corrected, radians).nw;
  assert.ok(Math.abs(before.x - after.x) < 1e-9, `${before.x} vs ${after.x}`);
  assert.ok(Math.abs(before.y - after.y) < 1e-9, `${before.y} vs ${after.y}`);
});

test("an unrotated box is returned unchanged", () => {
  assert.deepEqual(rotatedBounds(box, 0), box);
  const resized: Rect = { x: 0, y: 0, width: 140, height: 50 };
  assert.deepEqual(resizeRotatedBox(box, resized, "se", 0), resized);
});

test("the rotate handle sits above the box and follows the rotation", () => {
  const box: Rect = { x: 0, y: 0, width: 100, height: 50 };
  // 未旋转：正上方，水平居中。
  const up = rotationHandlePoint(box, 0, 26);
  assert.equal(up.x, 50);
  assert.equal(up.y, -26);
  // 旋转 90°：跑到右侧。
  const right = rotationHandlePoint(box, QUARTER, 26);
  assert.ok(Math.abs(right.x - 101) < 1e-9, String(right.x));
  assert.ok(Math.abs(right.y - 25) < 1e-9, String(right.y));
});

test("hit testing the rotate handle", () => {
  const box: Rect = { x: 0, y: 0, width: 100, height: 50 };
  const handle = rotationHandlePoint(box, 0, 26);
  assert.equal(hitTestRotationHandle(box, 0, handle, 26, 9), true);
  assert.equal(hitTestRotationHandle(box, 0, { x: handle.x, y: handle.y + 30 }, 26, 9), false);
});

test("angles normalise into (-180, 180] and snap to 15 degrees", () => {
  assert.equal(normalizeAngle(370), 10);
  assert.equal(normalizeAngle(-190), 170);
  assert.equal(normalizeAngle(180), 180);
  assert.equal(normalizeAngle(-180), 180);
  assert.equal(snapAngle(7), 0);
  assert.equal(snapAngle(8), 15);
  assert.equal(snapAngle(-7), 0);
  assert.equal(snapAngle(-8), -15);
});

test("angle from a centre follows screen coordinates", () => {
  // y 轴向下：正下方是 +90 度。
  assert.equal(angleDegrees({ x: 0, y: 0 }, { x: 0, y: 10 }), 90);
  assert.equal(angleDegrees({ x: 0, y: 0 }, { x: 10, y: 0 }), 0);
  assert.equal(angleDegrees({ x: 0, y: 0 }, { x: -10, y: 0 }), 180);
});