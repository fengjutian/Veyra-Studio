import assert from "node:assert/strict";
import test from "node:test";
import { flattenPath, parseVectorPath } from "@ufira/design-schema";
import { anchorFromDrag, constrainAngle, isClosingPoint, isDuplicateAnchor, mirrorHandle, penCommands, penGeometry } from "../src/pen";

test("two corner anchors become a straight open segment", () => {
  const commands = penCommands([{ x: 10, y: 10 }, { x: 110, y: 60 }], false);
  assert.deepEqual(commands, [
    { command: "M", point: { x: 10, y: 10 } },
    { command: "L", point: { x: 110, y: 60 } },
  ]);
});

test("an anchor with an out handle produces a cubic segment", () => {
  const commands = penCommands([
    { x: 0, y: 0, handleOut: { x: 20, y: 40 }, handleIn: { x: -20, y: -40 } },
    { x: 100, y: 0 },
  ], false);
  assert.deepEqual(commands[1], {
    command: "C",
    control1: { x: 20, y: 40 },
    // 后一个锚点没有入向手柄时，控制点退化成落点本身。
    control2: { x: 100, y: 0 },
    point: { x: 100, y: 0 },
  });
});

test("closing adds the last segment and Z", () => {
  const commands = penCommands([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], true);
  assert.deepEqual(commands.at(-1), { command: "Z" });
  assert.deepEqual(commands.at(-2), { command: "L", point: { x: 0, y: 0 } });
});

test("the cursor adds a rubber-band segment but no Z", () => {
  const commands = penCommands([{ x: 0, y: 0 }], false, { x: 50, y: 50 });
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[1], { command: "L", point: { x: 50, y: 50 } });
  // 只有一个锚点时即使点了闭合也构不成路径。
  assert.equal(penCommands([{ x: 0, y: 0 }], true).length, 1);
});

test("geometry normalizes into the tight bounding box of the curve", () => {
  const result = penGeometry([
    { x: 100, y: 100, handleOut: { x: 100, y: 200 }, handleIn: { x: 100, y: 0 } },
    { x: 300, y: 100, handleIn: { x: 300, y: 200 } },
  ], false);
  assert.ok(result);
  // 三次曲线在 t=0.5 处最高 y=175，所以盒高 75——不是控制点的 200。
  assert.deepEqual(result.box, { x: 100, y: 100, width: 200, height: 75 });
  const commands = parseVectorPath(result.geometry.d)!;
  assert.deepEqual(commands[0], { command: "M", point: { x: 0, y: 0 } });
  const curve = commands.at(-1);
  assert.equal(curve?.command, "C");
  // 端点回到盒内，控制点被推到盒外（y = 1.3333），这是允许的。
  assert.deepEqual(curve.point, { x: 1, y: 0 });
  assert.ok((curve as { control1: { y: number } }).control1.y > 1);
});

test("a perfectly straight path still gets a 1px-tall box", () => {
  const result = penGeometry([{ x: 10, y: 50 }, { x: 210, y: 50 }], false);
  assert.ok(result);
  assert.equal(result.box.height, 1);
  assert.equal(result.box.y, 49.5);
  // 命中测试要求盒子有面积，所以这里必须撑开而不是留 0。
  assert.ok(flattenPath(parseVectorPath(result.geometry.d)!).length >= 2);
});

test("fewer than two anchors produce no geometry", () => {
  assert.equal(penGeometry([{ x: 0, y: 0 }], false), undefined);
  assert.equal(penGeometry([], true), undefined);
});

test("closing and duplicate detection use screen pixels", () => {
  assert.equal(isClosingPoint({ x: 0, y: 0 }, { x: 5, y: 0 }, 1), true);
  assert.equal(isClosingPoint({ x: 0, y: 0 }, { x: 9, y: 0 }, 1), false);
  // 放大到 200% 时 8 个屏幕像素只相当于 4 个场景单位。
  assert.equal(isClosingPoint({ x: 0, y: 0 }, { x: 5, y: 0 }, 2), false);
  assert.equal(isDuplicateAnchor({ x: 0, y: 0 }, { x: 1, y: 0 }, 1), true);
  assert.equal(isDuplicateAnchor(undefined, { x: 0, y: 0 }, 1), false);
});

test("Shift snaps a handle to 45 degree steps", () => {
  const snapped = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
  assert.ok(Math.abs(snapped.y) < 1e-9);
  assert.equal(Math.round(Math.hypot(snapped.x, snapped.y)), Math.round(Math.hypot(100, 10)));
  const diagonal = constrainAngle({ x: 0, y: 0 }, { x: 100, y: 90 });
  assert.ok(Math.abs(diagonal.x - diagonal.y) < 1e-6);
});

test("mirroring keeps the two handles symmetric around the anchor", () => {
  assert.deepEqual(mirrorHandle({ x: 100, y: 100 }, { x: 120, y: 80 }), { x: 80, y: 120 });
});

test("a click without a drag stays a corner point", () => {
  assert.deepEqual(anchorFromDrag({ x: 10, y: 10 }, undefined, 1), { x: 10, y: 10 });
  assert.deepEqual(anchorFromDrag({ x: 10, y: 10 }, { x: 10.5, y: 10 }, 1), { x: 10, y: 10 });
  const smooth = anchorFromDrag({ x: 10, y: 10 }, { x: 40, y: 10 }, 1);
  assert.deepEqual(smooth.handleOut, { x: 40, y: 10 });
  assert.deepEqual(smooth.handleIn, { x: -20, y: 10 });
});
