import { isClosedPath, type PathCommand, type PathPoint } from "@ufira/design-schema";import type { PenAnchor } from "./pen";

/**
 * 路径节点编辑的纯函数层。
 *
 * 和钢笔（`pen.ts`）共用同一套锚点模型：锚点 + 两个绝对控制点。编辑时先把几何
 * 展开成锚点数组，改完再重建命令——比直接在命令数组上按下标抠要稳，也不用为
 * `M/L/C/Q` 每种命令各写一遍增删逻辑。
 *
 * 二次贝塞尔在展开时**精确升阶**成三次：Q 的等价控制点是
 * `P0 + 2/3(Q-P0)` 与 `P2 + 2/3(Q-P2)`，所以用户手改一条 Q 路径不会看到形状跳变。
 */
export type EditableAnchor = PenAnchor;

export type HandleRole = "out" | "in";

export interface PathHandle {
  anchorIndex: number;
  role: HandleRole;
  point: PathPoint;
}

/** 命令 → 锚点数组。 */
export function anchorsFromPath(commands: PathCommand[]): EditableAnchor[] {
  const anchors: EditableAnchor[] = [];
  for (const command of commands) {
    if (command.command === "M" || command.command === "L") {
      anchors.push({ x: command.point.x, y: command.point.y });
      continue;
    }
    if (command.command === "C") {
      const previous = anchors.at(-1);
      if (previous) previous.handleOut = { ...command.control1 };
      anchors.push({ x: command.point.x, y: command.point.y, handleIn: { ...command.control2 } });
      continue;
    }
    if (command.command === "Q") {
      const previous = anchors.at(-1);
      const from = previous ?? { x: command.point.x, y: command.point.y };
      if (previous) {
        previous.handleOut = {
          x: from.x + (2 / 3) * (command.control.x - from.x),
          y: from.y + (2 / 3) * (command.control.y - from.y),
        };
      }
      anchors.push({
        x: command.point.x,
        y: command.point.y,
        handleIn: {
          x: command.point.x + (2 / 3) * (command.control.x - command.point.x),
          y: command.point.y + (2 / 3) * (command.control.y - command.point.y),
        },
      });
    }
  }
  // 闭合路径可能显式写了「最后一点回到起点」那一段：那是一个用来做曲率闭合的辅助点，
  // 不是真锚点。不合并的话，每次进出编辑态都会多出一个重合的锚点。
  if (isClosedPath(commands) && anchors.length > 1) {
    const first = anchors[0]!;
    const last = anchors.at(-1)!;
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) {
      if (last.handleIn) first.handleIn = last.handleIn;
      anchors.pop();
    }
  }
  return anchors;
}

/** 锚点数组 → 命令（与钢笔的构建规则一致）。 */
export function commandsFromAnchors(anchors: readonly EditableAnchor[], closed: boolean): PathCommand[] {
  const commands: PathCommand[] = [];
  if (!anchors.length) return commands;
  const first = anchors[0]!;
  commands.push({ command: "M", point: { x: first.x, y: first.y } });
  for (let index = 1; index < anchors.length; index += 1) commands.push(segment(anchors[index - 1]!, anchors[index]!));
  if (closed && anchors.length >= 2) {
    // 只有闭合边是曲线时才写显式线段；直线闭合交给 Z，否则读回来会多一个重合锚点。
    const last = anchors.at(-1)!;
    if (last.handleOut || first.handleIn) commands.push(segment(last, first));
    commands.push({ command: "Z" });
  }
  return commands;
}

/** 展开所有手柄（用于绘制与命中）。 */
export function handlesOf(anchors: readonly EditableAnchor[]): PathHandle[] {
  const handles: PathHandle[] = [];
  anchors.forEach((anchor, anchorIndex) => {
    if (anchor.handleOut) handles.push({ anchorIndex, role: "out", point: anchor.handleOut });
    if (anchor.handleIn) handles.push({ anchorIndex, role: "in", point: anchor.handleIn });
  });
  return handles;
}

export function hitTestAnchor(anchors: readonly EditableAnchor[], point: PathPoint, tolerance: number): number | undefined {
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    if (distance(anchors[index]!, point) <= tolerance) return index;
  }
  return undefined;
}

/** 手柄优先于锚点：手柄通常离锚点很近，反过来的话手柄永远点不到。 */
export function hitTestHandle(anchors: readonly EditableAnchor[], point: PathPoint, tolerance: number): PathHandle | undefined {
  const handles = handlesOf(anchors);
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    if (distance(handles[index]!.point, point) <= tolerance) return handles[index];
  }
  return undefined;
}

/**
 * 移动锚点：控制点跟着平移。
 *
 * 手柄存的是绝对坐标，如果只改锚点，曲线会在原地被拉变形；Figma 里拖动锚点，
 * 两边的曲率是跟着走的。
 */
export function moveAnchor(anchors: readonly EditableAnchor[], index: number, point: PathPoint): EditableAnchor[] {
  const anchor = anchors[index];
  if (!anchor) return [...anchors];
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const next = [...anchors];
  next[index] = {
    x: point.x,
    y: point.y,
    ...(anchor.handleOut ? { handleOut: { x: anchor.handleOut.x + dx, y: anchor.handleOut.y + dy } } : {}),
    ...(anchor.handleIn ? { handleIn: { x: anchor.handleIn.x + dx, y: anchor.handleIn.y + dy } } : {}),
  };
  return next;
}

/**
 * 移动手柄。
 *
 * `mirror` 为 true 时对侧手柄取镜像点，保持锚点平滑（Figma 的默认行为）；
 * 按住 Alt 时传 false，只动这一侧，让锚点变成尖角。
 */
export function moveHandle(
  anchors: readonly EditableAnchor[],
  handle: { anchorIndex: number; role: HandleRole },
  point: PathPoint,
  mirror: boolean,
): EditableAnchor[] {
  const anchor = anchors[handle.anchorIndex];
  if (!anchor) return [...anchors];
  const next = [...anchors];
  const mirrored = { x: anchor.x * 2 - point.x, y: anchor.y * 2 - point.y };
  if (handle.role === "out") {
    next[handle.anchorIndex] = {
      ...anchor,
      handleOut: { x: point.x, y: point.y },
      ...(mirror && anchor.handleIn ? { handleIn: mirrored } : {}),
    };
  } else {
    next[handle.anchorIndex] = {
      ...anchor,
      handleIn: { x: point.x, y: point.y },
      ...(mirror && anchor.handleOut ? { handleOut: mirrored } : {}),
    };
  }
  return next;
}

/**
 * 删除锚点，相邻两点用直线重连。
 *
 * 三条边以下不再提供删除：开放路径至少 2 个锚点、闭合路径至少 3 个，否则路径退化成
 * 一个点或一条线，用户没有恢复的入口。
 */
export function removeAnchor(anchors: readonly EditableAnchor[], index: number, closed: boolean): EditableAnchor[] | undefined {
  const minimum = closed ? 3 : 2;
  if (anchors.length <= minimum || index < 0 || index >= anchors.length) return undefined;
  return anchors.filter((_, position) => position !== index);
}

/** 这条路径是否闭合（编辑态里决定重建时是否补 Z）。 */
export function pathIsClosed(commands: PathCommand[]): boolean {
  return isClosedPath(commands);
}

function segment(from: EditableAnchor, to: EditableAnchor): PathCommand {
  const start = from.handleOut ?? from;
  const end = to.handleIn ?? to;
  if (from.handleOut || to.handleIn) {
    return { command: "C", control1: { x: start.x, y: start.y }, control2: { x: end.x, y: end.y }, point: { x: to.x, y: to.y } };
  }
  return { command: "L", point: { x: to.x, y: to.y } };
}

function distance(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 线段命中结果：`index` 是线段起点锚点的下标，`t` 是参数（0–1）。 */
export interface SegmentHit {
  index: number;
  t: number;
  point: PathPoint;
  distance: number;
}

/** 线段数量：开放路径 n-1 段，闭合路径 n 段（最后一段回到第一个锚点）。 */
export function segmentCount(anchors: readonly EditableAnchor[], closed: boolean): number {
  if (anchors.length < 2) return 0;
  return closed ? anchors.length : anchors.length - 1;
}

/**
 * 找到离目标点最近的线段。
 *
 * 直线段直接投影；曲线段先粗采样再在相邻区间做三分搜索——纯解三次方程当然更漂亮，
 * 但「插点」只需精确到亚像素，三分搜索 24 轮足够，而且没有求根公式的数值边界。
 */
export function closestSegment(anchors: readonly EditableAnchor[], closed: boolean, target: PathPoint, tolerance: number): SegmentHit | undefined {
  let best: SegmentHit | undefined;
  const count = segmentCount(anchors, closed);
  for (let index = 0; index < count; index += 1) {
    const hit = closestOnSegment(anchors, index, target);
    if (!hit || hit.distance > tolerance) continue;
    if (!best || hit.distance < best.distance) best = hit;
  }
  return best;
}

/**
 * 在线段上插入锚点，保持曲线形状不变。
 *
 * 用 de Casteljau 在 t 处把三次曲线切成两段：新锚点拿中点，两侧锚点各自收下切分后的
 * 控制点。直线段不生成控制点——否则一条直线会被「插」成曲线。
 */
export function insertAnchor(anchors: readonly EditableAnchor[], closed: boolean, segmentIndex: number, t: number): EditableAnchor[] {
  const count = segmentCount(anchors, closed);
  if (segmentIndex < 0 || segmentIndex >= count) return [...anchors];
  const next = anchors.map(anchor => ({ ...anchor }));
  const start = next[segmentIndex]!;
  const end = next[(segmentIndex + 1) % next.length]!;
  const ratio = Math.min(1, Math.max(0, t));
  // 闭合边插在数组末尾：`commandsFromAnchors` 的闭合段总是从最后一个锚点回到第一个。
  const at = segmentIndex + 1;

  if (!start.handleOut && !end.handleIn) {
    const point = lerp(start, end, ratio);
    next.splice(at, 0, { x: point.x, y: point.y });
    return next;
  }

  const control1 = start.handleOut ?? { x: start.x, y: start.y };
  const control2 = end.handleIn ?? { x: end.x, y: end.y };
  const first = lerp(start, control1, ratio);
  const middle = lerp(control1, control2, ratio);
  const last = lerp(control2, end, ratio);
  const left = lerp(first, middle, ratio);
  const right = lerp(middle, last, ratio);
  const point = lerp(left, right, ratio);
  start.handleOut = first;
  end.handleIn = last;
  next.splice(at, 0, { x: point.x, y: point.y, handleIn: left, handleOut: right });
  return next;
}

function closestOnSegment(anchors: readonly EditableAnchor[], index: number, target: PathPoint): SegmentHit | undefined {
  const start = anchors[index];
  const end = anchors[(index + 1) % anchors.length];
  if (!start || !end) return undefined;
  if (!start.handleOut && !end.handleIn) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const raw = lengthSquared === 0 ? 0 : ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared;
    const t = Math.min(1, Math.max(0, raw));
    const point = lerp(start, end, t);
    return { index, t, point, distance: distance(point, target) };
  }
  const control1 = start.handleOut ?? { x: start.x, y: start.y };
  const control2 = end.handleIn ?? { x: end.x, y: end.y };
  const at = (value: number) => cubicPoint(start, control1, control2, end, value);
  const STEPS = 32;
  let bestT = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= STEPS; step += 1) {
    const value = step / STEPS;
    const current = distance(at(value), target);
    if (current < bestDistance) {
      bestDistance = current;
      bestT = value;
    }
  }
  let low = Math.max(0, bestT - 1 / STEPS);
  let high = Math.min(1, bestT + 1 / STEPS);
  for (let step = 0; step < 24; step += 1) {
    const first = low + (high - low) / 3;
    const second = high - (high - low) / 3;
    if (distance(at(first), target) < distance(at(second), target)) high = second;
    else low = first;
  }
  const t = (low + high) / 2;
  const point = at(t);
  return { index, t, point, distance: distance(point, target) };
}

function cubicPoint(p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint, t: number): PathPoint {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

function lerp(start: PathPoint, end: PathPoint, t: number): PathPoint {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}