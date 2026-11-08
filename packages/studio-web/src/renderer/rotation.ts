import { HANDLE_IDS, handleCenters, resizeRect, type HandleId, type Rect } from "./selection";

/**
 * 旋转的几何计算。
 *
 * 旋转改变的是**坐标系**：命中测试、选择框、缩放手柄原本都假定轴对齐。这里把换算
 * 集中成纯函数，交互层只需要「把点逆变换回本地」这一步，其余逻辑（手柄命中、缩放
 * 算法）可以原样复用。
 *
 * 角度约定与 CSS / SVG 一致：角度制、顺时针为正。画布 y 轴向下，所以数学上的旋转
 * 矩阵用 `+rad` 就是顺时针，不需要额外取负。
 */

export interface Point {
  x: number;
  y: number;
}

/** 度数 → 弧度。 */
export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function boxCenter(box: Rect): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 绕 `origin` 旋转一个点。 */
export function rotatePoint(point: Point, origin: Point, radians: number): Point {
  if (!radians) return { ...point };
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/** 把世界坐标的点换算到节点的本地坐标系（逆旋转）。 */
export function toLocalPoint(point: Point, box: Rect, radians: number): Point {
  return rotatePoint(point, boxCenter(box), -radians);
}

/** 四个角：左上、右上、右下、左下（本地顺序，已旋转到世界坐标）。 */
export function rotatedCorners(box: Rect, radians: number): [Point, Point, Point, Point] {
  const origin = boxCenter(box);
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  return corners.map(corner => rotatePoint(corner, origin, radians)) as [Point, Point, Point, Point];
}

/** 旋转后的轴对齐包围盒（多选包围盒、适应内容用）。 */
export function rotatedBounds(box: Rect, radians: number): Rect {
  if (!radians) return box;
  const corners = rotatedCorners(box, radians);
  const xs = corners.map(corner => corner.x);
  const ys = corners.map(corner => corner.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

/** 手柄在世界坐标里的位置（先算本地中心点，再旋转）。 */
export function rotatedHandleCenters(box: Rect, radians: number): Record<HandleId, Point> {
  const origin = boxCenter(box);
  const centers = handleCenters(box);
  const result = {} as Record<HandleId, Point>;
  for (const id of HANDLE_IDS) result[id] = rotatePoint(centers[id], origin, radians);
  return result;
}

/** 命中手柄：把点逆变换回本地，命中判定完全复用未旋转的实现。 */
export function hitTestHandleRotated(box: Rect, radians: number, point: Point, size: number): HandleId | undefined {
  return hitTestHandleLocal(box, toLocalPoint(point, box, radians), size);
}

function hitTestHandleLocal(box: Rect, point: Point, size: number): HandleId | undefined {
  const half = size / 2;
  const centers = handleCenters(box);
  for (const id of HANDLE_IDS) {
    const center = centers[id];
    if (Math.abs(point.x - center.x) <= half && Math.abs(point.y - center.y) <= half) return id;
  }
  return undefined;
}

/**
 * 旋转节点的缩放。
 *
 * `next` 是本地坐标系里 resize 的结果。因为旋转是绕**盒子中心**的，盒子一变中心就跟着
 * 变，视觉上的对角会漂移。这里把对角在旋转前后的世界坐标算出来，再把整个盒子平移回去：
 * 手感上就是「拉一个角，对角钉住」。
 */
export function resizeRotatedBox(previous: Rect, next: Rect, handle: HandleId, radians: number): Rect {
  if (!radians) return next;
  const anchor = OPPOSITE_HANDLE[handle];
  const before = rotatePoint(handleCenters(previous)[anchor], boxCenter(previous), radians);
  const after = rotatePoint(handleCenters(next)[anchor], boxCenter(next), radians);
  const dx = before.x - after.x;
  const dy = before.y - after.y;
  return { ...next, x: next.x + dx, y: next.y + dy };
}

const OPPOSITE_HANDLE: Record<HandleId, HandleId> = {
  nw: "se",
  n: "s",
  ne: "sw",
  e: "w",
  se: "nw",
  s: "n",
  sw: "ne",
  w: "e",
};

/** 旋转手柄离盒子顶边的距离（屏幕像素，调用方除以 zoom 换算成场景单位）。 */
export const ROTATE_HANDLE_GAP = 26;

/** 旋转手柄的命中半径（屏幕像素）。 */
export const ROTATE_HANDLE_RADIUS = 9;

/**
 * 旋转手柄的位置：从盒子「顶边中点」沿盒子本地 -y 方向外移。
 *
 * 用本地坐标再套上旋转，手柄就会一直挂在盒子的正上方——和 Figma 一样，转多少度都跟着走。
 */
export function rotationHandlePoint(box: Rect, radians: number, gap = ROTATE_HANDLE_GAP): Point {
  const topCenter = { x: box.x + box.width / 2, y: box.y - gap };
  return rotatePoint(topCenter, boxCenter(box), radians);
}

/** 指针是否落在旋转手柄上。 */
export function hitTestRotationHandle(box: Rect, radians: number, point: Point, gap = ROTATE_HANDLE_GAP, radius = ROTATE_HANDLE_RADIUS): boolean {
  const handle = rotationHandlePoint(box, radians, gap);
  return Math.hypot(point.x - handle.x, point.y - handle.y) <= radius;
}

/** 两点相对「正右方」的角度（度），用于把指针位置换成旋转角。 */
export function angleDegrees(origin: Point, point: Point): number {
  return (Math.atan2(point.y - origin.y, point.x - origin.x) * 180) / Math.PI;
}

/** 规范到 (-180, 180]，避免文档里出现 720 度这种值。 */
export function normalizeAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/** 按 `step` 度吸附（Shift 时用 15 度）。 */
export function snapAngle(degrees: number, step = 15): number {
  return normalizeAngle(Math.round(degrees / step) * step);
}