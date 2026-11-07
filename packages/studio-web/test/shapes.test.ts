import assert from "node:assert/strict";
import test from "node:test";
import { parseVectorPath } from "@ufira/design-schema";
import { POLYGON_SIDES, STAR_POINTS, buildVectorShape } from "../src/shapes";

test("a diagonal line maps its endpoints onto the box corners", () => {
  const shape = buildVectorShape("line", { x: 10, y: 20 }, { x: 110, y: 70 });
  assert.deepEqual(shape.box, { x: 10, y: 20, width: 100, height: 50 });
  const commands = parseVectorPath(shape.geometry.d)!;
  assert.deepEqual(commands, [
    { command: "M", point: { x: 0, y: 0 } },
    { command: "L", point: { x: 1, y: 1 } },
  ]);
});

test("a line dragged up-left keeps the drag direction", () => {
  const shape = buildVectorShape("line", { x: 110, y: 70 }, { x: 10, y: 20 });
  const commands = parseVectorPath(shape.geometry.d)!;
  assert.deepEqual(commands, [
    { command: "M", point: { x: 1, y: 1 } },
    { command: "L", point: { x: 0, y: 0 } },
  ]);
});

test("a horizontal line gets a 1px box centered on the stroke", () => {
  const shape = buildVectorShape("line", { x: 100, y: 50 }, { x: 300, y: 50 });
  // 0 高度的盒子无法命中，必须撑到 1px，并且上下各让出半个像素。
  assert.equal(shape.box.height, 1);
  assert.equal(shape.box.y, 49.5);
  assert.equal(shape.box.width, 200);
  const commands = parseVectorPath(shape.geometry.d)!;
  assert.deepEqual(commands, [
    { command: "M", point: { x: 0, y: 0.5 } },
    { command: "L", point: { x: 1, y: 0.5 } },
  ]);
});

test("a polygon fills the dragged box", () => {
  const shape = buildVectorShape("polygon", { x: 40, y: 60 }, { x: 200, y: 220 });
  assert.deepEqual(shape.box, { x: 40, y: 60, width: 160, height: 160 });
  const commands = parseVectorPath(shape.geometry.d)!;
  assert.equal(commands.filter(command => command.command === "L").length, POLYGON_SIDES - 1);
  assert.equal(commands.at(-1)?.command, "Z");
});

test("a star alternates outer and inner vertices", () => {
  const shape = buildVectorShape("star", { x: 0, y: 0 }, { x: 100, y: 100 });
  const points = parseVectorPath(shape.geometry.d)!.filter(command => command.command !== "Z") as Array<{ point: { x: number; y: number } }>;
  assert.equal(points.length, STAR_POINTS * 2);
  const radii = points.map(point => Math.hypot(point.point.x - 0.5, point.point.y - 0.5));
  assert.ok(Math.abs(radii[0]! - 0.5) < 1e-3);
  assert.ok(Math.abs(radii[1]! - 0.191) < 1e-3);
});

test("polygon paths stay inside the unit box when the drag goes up-left", () => {
  const shape = buildVectorShape("polygon", { x: 200, y: 200 }, { x: 100, y: 120 });
  assert.deepEqual(shape.box, { x: 100, y: 120, width: 100, height: 80 });
  const points = parseVectorPath(shape.geometry.d)!.filter(command => command.command !== "Z") as Array<{ point: { x: number; y: number } }>;
  for (const point of points) {
    assert.ok(point.point.x >= 0 && point.point.x <= 1, `x ${point.point.x}`);
    assert.ok(point.point.y >= 0 && point.point.y <= 1, `y ${point.point.y}`);
  }
});
