/**
 * 惯性滚动。
 *
 * 滚轮松手之后内容不该立刻停住——桌面上「滑一下还能滑一段」的手感来自这里。
 * 实现是**速度衰减**：每帧把速度乘一个固定比例，低于阈值就停。
 *
 * 纯函数，不碰 DOM、不碰 React：帧循环在 `preview.tsx` 里，判定规则在这里，
 * 于是「什么时候停」这条规则可以单独测。
 */

/** 每帧的速度衰减系数。越小停得越快。 */
export const INERTIA_DECAY = 0.92;

/** 低于这个速度（px/帧）就停。 */
export const INERTIA_MIN_SPEED = 0.4;

/** 一帧最多补滚多少像素——不然一次快速甩动会跳出去一大截。 */
export const INERTIA_MAX_STEP = 60;

export interface Velocity {
  x: number;
  y: number;
}

/** 一帧之后的速度。 */
export function decayVelocity(velocity: Velocity, factor: number = INERTIA_DECAY): Velocity {
  return { x: velocity.x * factor, y: velocity.y * factor };
}

/** 这一帧要补滚多少像素（带单帧上限）。 */
export function inertiaStep(velocity: Velocity): Velocity {
  return { x: clampStep(velocity.x), y: clampStep(velocity.y) };
}

/** 速度已经小到可以停了。 */
export function inertiaFinished(velocity: Velocity): boolean {
  return Math.abs(velocity.x) < INERTIA_MIN_SPEED && Math.abs(velocity.y) < INERTIA_MIN_SPEED;
}

function clampStep(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-INERTIA_MAX_STEP, Math.min(INERTIA_MAX_STEP, value));
}
