/**
 * SVG 椭圆弧（`A` 命令）→ 三次贝塞尔近似。
 *
 * 语义对齐自 Penpot 的 `common/src/app/common/svg/path/arc_to_bezier.js`，
 * 该文件以 **MIT License** 发布（原始实现参考 fontello/svgpath 的 a2c.js）。
 * 原样搬运，仅移除 Closure Compiler 的 `goog.provide` / `goog.scope` 包装并改为 TS 导出。
 * 详见 `docs/penpot-porting.md`。
 *
 * 算法是**端到端参数化**的，不是数值拟合：先把 SVG 规范的「端点参数化」
 * 转成「圆心参数化」，再按每段不超过 90° 拆成若干段三次贝塞尔近似。
 * 因此同一组参数总是得到同一组控制点——可重复、可缓存。
 */

/** 圆弧近似成贝塞尔时的最大弧度（90°）。超过就再拆一段。 */
const MAX_ARC_SEGMENT = Math.PI / 2;

/**
 * 计算两个单位向量之间的夹角。
 *
 * 圆弧的半径方向夹角不需要做长度归一化，因此省掉了两次 `Math.sqrt`。
 */
function unitVectorAngle(ux: number, uy: number, vx: number, vy: number): number {
  const sign = ux * vy - uy * vx < 0 ? -1 : 1;
  let dot = ux * vx + uy * vy;

  // 浮点误差可能让 dot 略微超出 [-1, 1]（例如 -1.0000000000000002），
  // 直接进 acos 会得到 NaN。
  if (dot > 1) dot = 1;
  if (dot < -1) dot = -1;

  return sign * Math.acos(dot);
}

/**
 * 端点参数化 → 圆心参数化。
 *
 * 参考 SVG 1.1 实现说明第 F.6.5 节：
 * http://www.w3.org/TR/SVG11/implnote.html#ArcImplementationNotes
 *
 * 返回 `[cx, cy, theta1, deltaTheta]`。
 */
function getArcCenter(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fa: number,
  fs: number,
  rx: number,
  ry: number,
  sinPhi: number,
  cosPhi: number,
): [number, number, number, number] {
  // Step 1：把椭圆平移到两端点中点，再旋转到与坐标轴对齐。
  const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
  const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;

  // Step 2：求新坐标系下的圆心 (cxp, cyp)。
  let radicant = rxSq * rySq - rxSq * y1pSq - rySq * x1pSq;

  // 浮点误差可能让 radicant 变成 -1.38e-17 这种负数。
  if (radicant < 0) radicant = 0;

  radicant /= rxSq * y1pSq + rySq * x1pSq;
  radicant = Math.sqrt(radicant) * (fa === fs ? -1 : 1);

  const cxp = ((radicant * rx) / ry) * y1p;
  const cyp = ((radicant * -ry) / rx) * x1p;

  // Step 3：变换回原坐标系，得到圆心 (cx, cy)。
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step 4：求起始角 theta1 与弧度 deltaTheta。
  const v1x = (x1p - cxp) / rx;
  const v1y = (y1p - cyp) / ry;
  const v2x = (-x1p - cxp) / rx;
  const v2y = (-y1p - cyp) / ry;

  const theta1 = unitVectorAngle(1, 0, v1x, v1y);
  let deltaTheta = unitVectorAngle(v1x, v1y, v2x, v2y);

  // SVG 规范：fs=0 时弧按负方向，fs=1 时按正方向。
  if (fs === 0 && deltaTheta > 0) deltaTheta -= Math.PI * 2;
  if (fs === 1 && deltaTheta < 0) deltaTheta += Math.PI * 2;

  return [cx, cy, theta1, deltaTheta];
}

/**
 * 一段单位圆弧的三次贝塞尔近似。
 *
 * 标准公式：`alpha = 4/3 * tan(deltaTheta / 4)`。
 */
function approximateUnitArc(theta1: number, deltaTheta: number): number[] {
  const alpha = (4 / 3) * Math.tan(deltaTheta / 4);

  const x1 = Math.cos(theta1);
  const y1 = Math.sin(theta1);
  const x2 = Math.cos(theta1 + deltaTheta);
  const y2 = Math.sin(theta1 + deltaTheta);

  return [
    x1,
    y1,
    x1 - y1 * alpha,
    y1 + x1 * alpha,
    x2 + y2 * alpha,
    y2 - x2 * alpha,
    x2,
    y2,
  ];
}

/**
 * SVG 弧参数 → 若干段三次贝塞尔控制点。
 *
 * @param x1 起点 x
 * @param y1 起点 y
 * @param x2 终点 x
 * @param y2 终点 y
 * @param fa large-arc-flag（0/1）
 * @param fs sweep-flag（0/1）
 * @param rx 椭圆 x 半径
 * @param ry 椭圆 y 半径
 * @param phi x 轴旋转角（度）
 * @returns 每段 8 个数：`[c1x, c1y, c2x, c2y, x, y, ...]` 的扁平数组，
 *          实际返回 `number[][]`，每段一项。
 */
export function calculateArcBeziers(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  fa: number,
  fs: number,
  rx: number,
  ry: number,
  phi: number,
): number[][] {
  const sinPhi = Math.sin((phi * Math.PI * 2) / 360);
  const cosPhi = Math.cos((phi * Math.PI * 2) / 360);

  // Step 1：平移 + 旋转。
  const x1p = (cosPhi * (x1 - x2)) / 2 + (sinPhi * (y1 - y2)) / 2;
  const y1p = (-sinPhi * (x1 - x2)) / 2 + (cosPhi * (y1 - y2)) / 2;

  // 起点终点重合：没有弧可画。
  if (x1p === 0 && y1p === 0) return [];

  // 半径为 0：SVG 规范规定此时当作直线处理，交给调用方。
  if (rx === 0 || ry === 0) return [];

  // 半径取绝对值。
  rx = Math.abs(rx);
  ry = Math.abs(ry);

  // 半径过小时按规范放大——否则端点根本不在椭圆上。
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }

  const [cx, cy, theta1, deltaTheta] = getArcCenter(x1, y1, x2, y2, fa, fs, rx, ry, sinPhi, cosPhi);

  // 拆段：每段不超过 90°，否则单段三次贝塞尔的误差会肉眼可见。
  const segments = Math.max(Math.ceil(Math.abs(deltaTheta) / MAX_ARC_SEGMENT), 1);
  const segmentAngle = deltaTheta / segments;

  const result: number[][] = [];
  let currentTheta = theta1;
  for (let index = 0; index < segments; index += 1) {
    result.push(approximateUnitArc(currentTheta, segmentAngle));
    currentTheta += segmentAngle;
  }

  // 单位圆的贝塞尔近似 → 变换回目标椭圆（缩放 → 旋转 → 平移）。
  return result.map(curve => {
    for (let index = 0; index < curve.length; index += 2) {
      const x = curve[index]!;
      const y = curve[index + 1]!;

      const scaledX = x * rx;
      const scaledY = y * ry;

      const rotatedX = cosPhi * scaledX - sinPhi * scaledY;
      const rotatedY = sinPhi * scaledX + cosPhi * scaledY;

      curve[index] = rotatedX + cx;
      curve[index + 1] = rotatedY + cy;
    }
    return curve;
  });
}
