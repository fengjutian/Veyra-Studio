import type { Rect } from "./selection";
import type { SceneNode } from "./scene";

/**
 * 框选（marquee）。
 *
 * 只选页面顶层节点：与选区相交即选中，与 Figma/Excalidraw 的默认行为一致；嵌套节点
 * 由选中父节点后继续操作。返回顺序保持场景顺序，便于稳定测试。
 */
export function rectFromPoints(from: { x: number; y: number }, to: { x: number; y: number }): Rect {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  return { x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}

export function rectsIntersect(left: Rect, right: Rect): boolean {
  return left.x <= right.x + right.width
    && left.x + left.width >= right.x
    && left.y <= right.y + right.height
    && left.y + left.height >= right.y;
}

/** 与选区相交的顶层节点；空选区返回空数组。 */
export function nodesInRect(scene: SceneNode[], rect: Rect): string[] {
  if (rect.width <= 0 || rect.height <= 0) return [];
  return scene.filter(node => rectsIntersect(node.box, rect)).map(node => node.id);
}
