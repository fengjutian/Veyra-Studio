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
