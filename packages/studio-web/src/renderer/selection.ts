import type { NodeId } from "@ufira/design-schema";
import type { SceneBox, SceneNode } from "./scene";

/**
 * 选择框与手柄的几何计算（纯函数）。
 *
 * 这一层刻意不碰 DOM，也不负责交互：给定包围盒和命中点，算出应该显示哪些手柄、
 * 拖动手柄后盒子变成什么样。这样 Moveable 的替代可以分步落地——先接绘制，再接拖拽。
 */
export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLE_IDS: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 合并多个节点的盒子；空集合返回 undefined。 */
export function selectionBounds(boxes: Array<SceneBox | undefined>): Rect | undefined {
  const valid = boxes.filter((box): box is SceneBox => Boolean(box));
  if (!valid.length) return undefined;
  const left = Math.min(...valid.map(box => box.x));
  const top = Math.min(...valid.map(box => box.y));
  const right = Math.max(...valid.map(box => box.x + box.width));
  const bottom = Math.max(...valid.map(box => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 盒子的 8 个手柄中心点。手柄按屏幕像素大小定义，所以调用方要传入未缩放的尺寸。 */
export function handleCenters(bounds: Rect): Record<HandleId, { x: number; y: number }> {
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;
  const middleX = bounds.x + bounds.width / 2;
  const middleY = bounds.y + bounds.height / 2;
  return {
    nw: { x: left, y: top },
    n: { x: middleX, y: top },
    ne: { x: right, y: top },
    e: { x: right, y: middleY },
    se: { x: right, y: bottom },
    s: { x: middleX, y: bottom },
    sw: { x: left, y: bottom },
    w: { x: left, y: middleY },
  };
}

/** 命中手柄；`size` 是手柄边长（场景单位，通常由屏幕像素除以 zoom 得到）。 */
export function hitTestHandle(bounds: Rect, point: { x: number; y: number }, size: number): HandleId | undefined {
  const half = size / 2;
  const centers = handleCenters(bounds);
  for (const id of HANDLE_IDS) {
    const center = centers[id];
    if (Math.abs(point.x - center.x) <= half && Math.abs(point.y - center.y) <= half) return id;
  }
  return undefined;
}

const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

export function handleCursor(id: HandleId): string {
  return HANDLE_CURSORS[id];
}

/**
 * 拖动手柄后的新盒子。
 *
 * 只处理四个方向的正向/反向拖动；保持对边不动，`minSize` 防止翻转为负尺寸。
 */
export function resizeRect(bounds: Rect, handle: HandleId, deltaX: number, deltaY: number, minSize = 1): Rect {
  let { x, y, width, height } = bounds;
  const right = x + width;
  const bottom = y + height;

  if (handle.includes("w")) {
    const nextX = Math.min(x + deltaX, right - minSize);
    width = right - nextX;
    x = nextX;
  }
  if (handle.includes("e")) width = Math.max(minSize, width + deltaX);
  if (handle.includes("n")) {
    const nextY = Math.min(y + deltaY, bottom - minSize);
    height = bottom - nextY;
    y = nextY;
  }
  if (handle.includes("s")) height = Math.max(minSize, height + deltaY);

  return { x, y, width, height };
}

/** 场景里选中节点的盒子（找不到的 id 忽略）。 */
export function selectedBoxes(scene: SceneNode[], ids: NodeId[]): SceneBox[] {
  const wanted = new Set(ids);
  const found: SceneBox[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      if (wanted.has(node.id)) found.push(node.box);
      if (node.children.length) walk(node.children);
    }
  };
  walk(scene);
  return found;
}
