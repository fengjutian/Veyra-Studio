import { normalizePath, pathBounds, pathDataFromCommands, type PathCommand, type VectorGeometry } from "@ufira/design-schema";
import type { HitPoint } from "./renderer/hit-test";
import type { Rect } from "./renderer/selection";

/**
 * 钢笔草稿。
 *
 * 一次钢笔路径要跨越多次点击，而画布其余手势都是「按下—拖动—松手」的原子操作，
 * 所以草稿单独放在这里：它是纯数据 + 纯函数，不进文档、不涨 revision。
 * 只有 commit 时才换算成 `vector` 节点的 `geometry`，因此**一次路径 = 一次撤销**。
 */
export interface PenAnchor {
  x: number;
  y: number;
  /** 出向控制点（绝对场景坐标）；有它就说明这一段是曲线。 */
  handleOut?: HitPoint;
  /** 入向控制点；对称手柄时等于 point - (handleOut - point)。 */
  handleIn?: HitPoint;
}

/** 点回起点判定半径（屏幕像素，实际用 8 / zoom 换算成场景坐标）。 */
export const CLOSE_HIT_RADIUS = 8;

/** 少于两个锚点构不成路径。 */
export const MIN_PEN_ANCHORS = 2;

/** 落点去重半径：双击结束时第二次点击不该多加一个锚点。 */
export const DUPLICATE_ANCHOR_RADIUS = 3;

/**
 * 把锚点串成路径命令（绝对场景坐标）。
 *
 * `cursor` 是「橡皮筋」预览：把光标当成一个临时终点，让用户看到下一段会怎么连。
 * 只有在已有锚点时才生效。
 */
export function penCommands(anchors: readonly PenAnchor[], closed: boolean, cursor?: HitPoint): PathCommand[] {
  const commands: PathCommand[] = [];
  if (!anchors.length) return commands;
  const first = anchors[0]!;
  commands.push({ command: "M", point: { x: first.x, y: first.y } });
  for (let index = 1; index < anchors.length; index += 1) {
    commands.push(segment(anchors[index - 1]!, anchors[index]!));
  }
  if (cursor) commands.push(segment(anchors[anchors.length - 1]!, { x: cursor.x, y: cursor.y }));
  if (closed && anchors.length >= MIN_PEN_ANCHORS) {
    commands.push(segment(anchors[anchors.length - 1]!, first));
    commands.push({ command: "Z" });
  }
  return commands;
}

/**
 * 草稿 → 节点几何。
 *
 * 两点决定：
 * 1. 盒子取**离散化后的紧包围盒**，所以向外鼓的曲线也在盒内，选择框不会切掉弧顶；
 * 2. 退化路径（一条水平直线）盒子高度为 0，命中测试会直接判空，因此撑到至少 1px
 *    并以原路径为中心——和直线工具的处理一致。
 */
export function penGeometry(anchors: readonly PenAnchor[], closed: boolean): { box: Rect; geometry: VectorGeometry } | undefined {
  if (anchors.length < MIN_PEN_ANCHORS) return undefined;
  const commands = penCommands(anchors, closed);
  const bounds = pathBounds(commands);
  if (!bounds) return undefined;
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const box: Rect = {
    x: bounds.x - (width - bounds.width) / 2,
    y: bounds.y - (height - bounds.height) / 2,
    width,
    height,
  };
  return { box, geometry: { kind: "path", d: pathDataFromCommands(normalizePath(commands, box)) } };
}

/** 指针是否点回了起点（用于闭合路径）。 */
export function isClosingPoint(anchor: PenAnchor, point: HitPoint, zoom: number): boolean {
  return distance(anchor, point) <= CLOSE_HIT_RADIUS / Math.max(zoom, 0.01);
}

/** 与上一个锚点太近就不重复落点：双击结束路径时第二次点击会落在这里。 */
export function isDuplicateAnchor(anchor: PenAnchor | undefined, point: HitPoint, zoom: number): boolean {
  return anchor !== undefined && distance(anchor, point) <= DUPLICATE_ANCHOR_RADIUS / Math.max(zoom, 0.01);
}

/**
 * `Shift` 约束：把拖动方向吸附到 45° 的整数倍，长度不变。
 *
 * 以按下点为中心计算，因此拖出来的两个手柄仍然严格对称。
 */
export function constrainAngle(origin: HitPoint, point: HitPoint): HitPoint {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  if (dx === 0 && dy === 0) return point;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const length = Math.hypot(dx, dy);
  return { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
}

/** 对称手柄：入向点 = 锚点关于出向点的对称点。 */
export function mirrorHandle(anchor: HitPoint, handleOut: HitPoint): HitPoint {
  return { x: anchor.x * 2 - handleOut.x, y: anchor.y * 2 - handleOut.y };
}

/** 新落下的锚点：拖动超过 2px 才当作平滑点，否则是角点。 */
export function anchorFromDrag(point: HitPoint, drag: HitPoint | undefined, zoom: number): PenAnchor {
  if (!drag || distance(point, drag) < 2 / Math.max(zoom, 0.01)) return { x: point.x, y: point.y };
  return { x: point.x, y: point.y, handleOut: drag, handleIn: mirrorHandle(point, drag) };
}

function segment(from: PenAnchor, to: PenAnchor): PathCommand {
  const start = from.handleOut ?? from;
  const end = to.handleIn ?? to;
  if (from.handleOut || to.handleIn) {
    return { command: "C", control1: { x: start.x, y: start.y }, control2: { x: end.x, y: end.y }, point: { x: to.x, y: to.y } };
  }
  return { command: "L", point: { x: to.x, y: to.y } };
}

function distance(a: HitPoint, b: HitPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
