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
