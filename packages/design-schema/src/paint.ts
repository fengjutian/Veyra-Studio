/**
 * 填充几何：把 CSS 角度的线性渐变换算成一条渐变线。
 *
 * 三处绘制（Canvas、SVG、HTML 的内联 svg）必须用同一套几何，否则同一个渐变在画布和
 * 导出里方向/长度会不一样。这里只做纯计算，不碰任何绘制 API。
 *
 * 角度约定与 CSS 一致：`0deg` 指向上方，顺时针为正。画布 y 轴向下，所以方向向量是
 * `(sin θ, -cos θ)`。
 */
export interface GradientLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 渐变线：过盒子中心、方向由角度决定，长度取「盒子在方向上的投影长度」。
 *
 * 投影长度按 `|w·sinθ| + |h·cosθ|` 计算——这正是 CSS 渐变线的长度定义，所以
 * 转角时渐变的疏密不会跳。
 */
export function gradientLine(box: { x: number; y: number; width: number; height: number }, angle: number): GradientLine {
  const radians = (angle * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const length = Math.abs(box.width * sin) + Math.abs(box.height * cos);
  const dx = (sin * length) / 2;
  const dy = (-cos * length) / 2;
  return { x1: centerX - dx, y1: centerY - dy, x2: centerX + dx, y2: centerY + dy };
}

/** 径向渐变的绝对几何：中心与半径都在场景坐标里。 */
export interface RadialGeometry {
  cx: number;
  cy: number;
  r: number;
}

/**
 * 径向渐变 → 场景坐标里的圆。
 *
 * 半径取「盒子长边 × r」：这样非等比盒子上也是一个正圆。用短边或对角线做基准都试过，
 * 长边最符合「r = 0.5 时刚好盖住整个盒子」的直觉（正方形上精确成立）。
 */
export function radialGeometry(box: { x: number; y: number; width: number; height: number }, paint: { cx: number; cy: number; r: number }): RadialGeometry {
  return {
    cx: box.x + paint.cx * box.width,
    cy: box.y + paint.cy * box.height,
    r: Math.max(paint.r, 1e-6) * Math.max(box.width, box.height),
  };
}

/** 椭圆渐变的绝对几何：中心与两个半轴都在场景坐标里。 */
export interface EllipticalGeometry {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * 椭圆渐变 → 场景坐标里的椭圆。
 *
 * `rx` / `ry` 分别是半轴占盒子**宽 / 高**的比例：`rx = ry = 0.5` 时椭圆正好内接于盒子。
 * 基准与径向渐变的 `r`（占长边的比例）不同——径向渐变只有一个半径，只能挑一个基准；
 * 椭圆有两个轴，各自对各自的边才说得清。
 */
export function ellipticalGeometry(
  box: { x: number; y: number; width: number; height: number },
  paint: { cx: number; cy: number; rx: number; ry: number },
): EllipticalGeometry {
  return {
    cx: box.x + paint.cx * box.width,
    cy: box.y + paint.cy * box.height,
    rx: Math.max(paint.rx, 1e-6) * box.width,
    ry: Math.max(paint.ry, 1e-6) * box.height,
  };
}

/**
 * 椭圆渐变的 SVG `gradientTransform` 矩阵（`a b c d e f`）。
 *
 * 矩阵是「平移 × 旋转 × 缩放」的复合：
 * `T(cx,cy) · R(angle) · S(rx,ry)`——先按半轴把单位圆拉成椭圆，再绕中心旋转，
 * 最后把中心挪到椭圆的几何中心。
 *
 * 角度为 0 时退化成 `matrix(rx 0 0 ry cx cy)`，与不旋转的写法逐字一致。
 */
export function ellipticalGradientMatrix(geometry: EllipticalGeometry, angle = 0): [number, number, number, number, number, number] {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    cos * geometry.rx,
    sin * geometry.rx,
    -sin * geometry.ry,
    cos * geometry.ry,
    geometry.cx,
    geometry.cy,
  ];
}