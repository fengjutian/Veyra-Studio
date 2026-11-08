import assert from "node:assert/strict";
import test from "node:test";
import { calculateArcBeziers } from "../src/arc-to-bezier";

/**
 * 移植保真度对拍。
 *
 * 上游 `arc_to_bezier.js` 的原始算法抄写在这里（去掉 Closure 包装），
 * 用来证明 TS 移植版与上游**逐字节一致**——
 * 抄写自 penpot/penpot @ 904cdd9
 * `common/src/app/common/svg/path/arc_to_bezier.js`
 * （MIT License，原始实现参考 fontello/svgpath 的 a2c.js）。
 *
 * 这条对拍是「搬运」纪律的兜底：将来若有人改动移植版，
 * 这里会立刻指出偏离了上游，而不是悄悄改变几何结果。
 */
function upstream(
  x1: number, y1: number, x2: number, y2: number,
  fa: number, fs: number, rx: number, ry: number, phi: number,
): number[][] {
  const TAU = Math.PI * 2;

  function unitVectorAngle(ux: number, uy: number, vx: number, vy: number): number {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    let dot = ux * vx + uy * vy;
    if (dot > 1.0) dot = 1.0;
    if (dot < -1.0) dot = -1.0;
    return sign * Math.acos(dot);
  }

  function getArcCenter(
    ax: number, ay: number, bx: number, by: number,
    fa: number, fs: number, rx: number, ry: number, sinPhi: number, cosPhi: number,
  ): [number, number, number, number] {
    const x1p = (cosPhi * (ax - bx)) / 2 + (sinPhi * (ay - by)) / 2;
    const y1p = (-sinPhi * (ax - bx)) / 2 + (cosPhi * (ay - by)) / 2;
    const rxSq = rx * rx;
    const rySq = ry * ry;
    const x1pSq = x1p * x1p;
    const y1pSq = y1p * y1p;
    let radicant = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;
    if (radicant < 0) radicant = 0;
    radicant /= rxSq * y1pSq + rySq * x1pSq;
    radicant = Math.sqrt(radicant) * (fa === fs ? -1 : 1);
    const cxp = ((radicant * rx) / ry) * y1p;
    const cyp = ((radicant * -ry) / rx) * x1p;
    const cx = cosPhi * cxp - sinPhi * cyp + (ax + bx) / 2;
    const cy = sinPhi * cxp + cosPhi * cyp + (ay + by) / 2;
    const v1x = (x1p - cxp) / rx;
    const v1y = (y1p - cyp) / ry;
    const v2x = (-x1p - cxp) / rx;
    const v2y = (-y1p - cyp) / ry;
    const theta1 = unitVectorAngle(1, 0, v1x, v1y);
    let deltaTheta = unitVectorAngle(v1x, v1y, v2x, v2y);
    if (fs === 0 && deltaTheta > 0) deltaTheta -= TAU;
    if (fs === 1 && deltaTheta < 0) deltaTheta += TAU;
    return [cx, cy, theta1, deltaTheta];
  }

  function approximateUnitArc(theta1: number, deltaTheta: number): number[] {
    const alpha = (4 / 3) * Math.tan(deltaTheta / 4);
    const x1 = Math.cos(theta1);
    const y1 = Math.sin(theta1);
    const x2 = Math.cos(theta1 + deltaTheta);
    const y2 = Math.sin(theta1 + deltaTheta);
    return [x1, y1, x1 - y1 * alpha, y1 + x1 * alpha, x2 + y2 * alpha, y2 - x2 * alpha, x2, y2];
  }

  const sinPhi = Math.sin((phi * TAU) / 360);
  const cosPhi = Math.cos((phi * TAU) / 360);
  const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
  const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;
  if (x1p === 0 && y1p === 0) return [];
  if (rx === 0 || ry === 0) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const cc = getArcCenter(x1, y1, x2, y2, fa, fs, rx, ry, sinPhi, cosPhi);
  let theta1 = cc[2];
  let deltaTheta = cc[3];
  const segments = Math.max(Math.ceil(Math.abs(deltaTheta) / (TAU / 4)), 1);
  deltaTheta /= segments;
  const result: number[][] = [];
  for (let i = 0; i < segments; i += 1) {
    result.push(approximateUnitArc(theta1, deltaTheta));
    theta1 += deltaTheta;
  }
  return result.map(curve => {
    for (let i = 0; i < curve.length; i += 2) {
      const x = curve[i]!;
      const y = curve[i + 1]!;
      const scaledX = x * rx;
      const scaledY = y * ry;
      const rotatedX = cosPhi * scaledX - sinPhi * scaledY;
      const rotatedY = sinPhi * scaledX + cosPhi * scaledY;
      curve[i] = rotatedX + cc[0];
      curve[i + 1] = rotatedY + cc[1];
    }
    return curve;
  });
}

const CASES: [number, number, number, number, number, number, number, number, number][] = [
  [0, 0, 10, 10, 0, 1, 10, 10, 0],
  [0, 0, 20, 0, 0, 1, 10, 10, 0],
  [0, 0, 20, 0, 1, 1, 10, 10, 0],
  [0, 0, 20, 0, 1, 0, 10, 10, 0],
  [0, 0, 20, 0, 0, 0, 10, 10, 0],
  [10, 10, 20, 20, 0, 0, 15, 15, 30],
  [0, 0, 100, 50, 1, 0, 50, 25, 0],
  [5, 5, 5, 5, 0, 1, 10, 10, 0],
  [0, 0, 10, 0, 0, 1, 0, 0, 0],
  [0, 0, 10, 0, 0, 1, 3, 7, 45],
];

test("arc: 移植版与上游逐字节一致", () => {
  for (const testCase of CASES) {
    const mine = JSON.stringify(calculateArcBeziers(...testCase));
    const theirs = JSON.stringify(upstream(...testCase));
    assert.equal(mine, theirs, `arc case ${testCase.join(",")}`);
  }
});

test("arc: 90度弧的控制点与切线方向正确", () => {
  // 从 (0,0) 到 (10,10)、半径 10、sweep=1：圆心在 (0,10)。
  // 起点切线水平向右，终点切线竖直向下——
  // 控制点必须落在各自的切线上，否则弧会鼓错方向。
  const curves = calculateArcBeziers(0, 0, 10, 10, 0, 1, 10, 10, 0);
  assert.equal(curves.length, 1);
  const [startX, startY, c1x, c1y, c2x, c2y, endX, endY] = curves[0]!;

  assert.ok(Math.abs(startX) < 1e-9 && Math.abs(startY) < 1e-9);
  assert.ok(Math.abs(endX - 10) < 1e-9 && Math.abs(endY - 10) < 1e-9);

  // 起点切线水平 → 第一个控制点的 y 与起点相同，x 更大。
  assert.ok(Math.abs(c1y - startY) < 1e-9, `c1y ${c1y}`);
  assert.ok(c1x > startX, `c1x ${c1x}`);

  // 终点切线竖直 → 第二个控制点的 x 与终点相同，y 更小。
  assert.ok(Math.abs(c2x - endX) < 1e-9, `c2x ${c2x}`);
  assert.ok(c2y < endY, `c2y ${c2y}`);
});

test("arc: 超过90度的弧被拆成多段", () => {
  const curves = calculateArcBeziers(0, 0, 0, 20, 0, 1, 10, 10, 0);
  assert.ok(curves.length >= 2, `segments ${curves.length}`);
});

test("arc: 半径为0或起终点重合时不产生曲线", () => {
  assert.deepEqual(calculateArcBeziers(0, 0, 10, 0, 0, 1, 0, 0, 0), []);
  assert.deepEqual(calculateArcBeziers(5, 5, 5, 5, 0, 1, 10, 10, 0), []);
});
