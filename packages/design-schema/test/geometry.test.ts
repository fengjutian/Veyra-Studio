import assert from "node:assert/strict";
import test from "node:test";
import {
  absolutePath,
  closedPolygonPath,
  hitTestVectorPath,
  isClosedPath,
  isValidVectorPath,
  parseVectorPath,
  pathDataFromCommands,
  regularPolygonPathData,
  starPathData,
  vectorPathCommands,
} from "../src/geometry";

const BOX = { x: 100, y: 50, width: 200, height: 100 };

test("parses M/L/Z in unit space", () => {
  assert.deepEqual(parseVectorPath("M 0 0 L 1 0 L 1 1 Z"), [
    { command: "M", point: { x: 0, y: 0 } },
    { command: "L", point: { x: 1, y: 0 } },
    { command: "L", point: { x: 1, y: 1 } },
    { command: "Z" },
  ]);
});

test("accepts decimals, commas, exponents and repeated M", () => {
  assert.ok(isValidVectorPath("M0,0 L.5,0.5 Z"));
  assert.ok(isValidVectorPath("M 1e-1 2E-1 L 1 1"));
  assert.ok(isValidVectorPath("M 0 0 L 1 0 M 0 1 L 1 1"));
});

test("rejects every command outside M/L/Z", () => {
  // 曲线与圆弧留给钢笔工具那一轮，现在写进来会让画布和导出各画一半。
  for (const d of ["M 0 0 C 0 1 1 1 1 0", "M 0 0 Q 1 0 1 1", "M 0 0 A 1 1 0 0 0 1 1", "M 0 0 H 1", "M 0 0 V 1", "m 0 0 l 1 0"]) {
    assert.equal(isValidVectorPath(d), false, d);
  }
});

test("rejects malformed paths", () => {
  for (const d of ["", "   ", "M", "M 1", "L 0 0 Z", "M 0 0 L", "M 0 0 X 1 1", "M 0 0 L 2 0", "M -0.5 0 L 1 1", "M 0 0 Z Z"]) {
    assert.equal(isValidVectorPath(d), false, JSON.stringify(d));
  }
});

test("a valid path survives a round trip through the serializer", () => {
  const d = "M 0 0 L 1 0 L 1 1 L 0 1 Z";
  assert.equal(pathDataFromCommands(parseVectorPath(d)!), d);
});

test("maps normalized points into the node box", () => {
  const commands = parseVectorPath("M 0 0 L 1 1")!;
  const absolute = absolutePath(commands, BOX);
  assert.deepEqual(absolute, [
    { command: "M", point: { x: 100, y: 50 } },
    { command: "L", point: { x: 300, y: 150 } },
  ]);
});

test("detects closed paths", () => {
  assert.equal(isClosedPath(parseVectorPath("M 0 0 L 1 0 L 1 1 Z")!), true);
  assert.equal(isClosedPath(parseVectorPath("M 0 0 L 1 1")!), false);
});

test("hits inside a closed polygon", () => {
  const square = parseVectorPath(closedPolygonPath([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]))!;
  assert.equal(hitTestVectorPath(square, BOX, { x: 200, y: 100 }), true);
  assert.equal(hitTestVectorPath(square, BOX, { x: 20, y: 100 }), false);
});

test("an open path is hit near the line, not inside its bounding box", () => {
  // 对角线把包围盒切成两半；点右上角离线段很远，不该选中。
  const diagonal = parseVectorPath("M 0 0 L 1 1")!;
  assert.equal(hitTestVectorPath(diagonal, BOX, { x: 105, y: 55 }), true);
  assert.equal(hitTestVectorPath(diagonal, BOX, { x: 290, y: 60 }), false);
});

test("a horizontal line is still clickable", () => {
  // 高度被撑到 1px 的水平线：容差让它在视觉上仍然是「一条线」。
  const line = parseVectorPath("M 0 0.5 L 1 0.5")!;
  const thin = { x: 100, y: 50, width: 200, height: 1 };
  assert.equal(hitTestVectorPath(line, thin, { x: 200, y: 50.5 }), true);
  // 默认容差 6px：3px 内仍然算点到这条线，再远就不该选中。
  assert.equal(hitTestVectorPath(line, thin, { x: 200, y: 53 }), true);
  assert.equal(hitTestVectorPath(line, thin, { x: 200, y: 60 }), false);
});

test("hit testing rejects degenerate boxes and empty paths", () => {
  const square = parseVectorPath("M 0 0 L 1 0 L 1 1 Z")!;
  assert.equal(hitTestVectorPath(square, { x: 0, y: 0, width: 0, height: 10 }, { x: 0, y: 5 }), false);
  assert.equal(hitTestVectorPath([], BOX, { x: 200, y: 100 }), false);
});

test("builds a regular polygon inside the unit box", () => {
  const hexagon = regularPolygonPathData(6);
  assert.ok(isValidVectorPath(hexagon));
  const points = parseVectorPath(hexagon)!.filter(command => command.command !== "Z");
  assert.equal(points.length, 6);
  // 第一个顶点朝上：x 落在中线上，y 贴着上边。
  assert.deepEqual(points[0], { command: "M", point: { x: 0.5, y: 0 } });
});

test("builds a star with alternating radii", () => {
  const star = starPathData(5);
  assert.ok(isValidVectorPath(star));
  const points = parseVectorPath(star)!.filter(command => command.command !== "Z") as Array<{ point: { x: number; y: number } }>;
  assert.equal(points.length, 10);
  const radii = points.map(point => Math.hypot(point.point.x - 0.5, point.point.y - 0.5));
  // 外顶点 0.5、内顶点 0.5 × 0.382 ≈ 0.191，交替出现；序列化只保留 4 位小数。
  assert.ok(Math.abs(radii[0]! - 0.5) < 1e-3);
  assert.ok(Math.abs(radii[1]! - 0.191) < 1e-3);
});

test("clamps polygon vertices into the unit box", () => {
  const path = closedPolygonPath([{ x: -1, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 2 }]);
  const points = parseVectorPath(path)!.filter(command => command.command !== "Z") as Array<{ point: { x: number; y: number } }>;
  assert.deepEqual(points.map(point => point.point), [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }]);
});

test("caches parsed paths instead of reparsing on every hit test", () => {
  const d = "M 0 0 L 1 0 L 1 1 L 0 1 Z";
  assert.equal(vectorPathCommands(d), vectorPathCommands(d));
});

test("an invalid path degrades to an empty command list", () => {
  // 文档经过 schema 校验不会走到这里；渲染层仍然不能因为坏数据抛异常。
  assert.deepEqual(vectorPathCommands("M 0 0 C 1 1 1 0 0 0"), []);
});
