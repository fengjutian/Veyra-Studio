import type { SceneNode } from "./scene";

/**
 * 视口裁剪（culling）。
 *
 * 只裁根节点：与视口相交的根节点整棵绘制。保守策略是刻意的——如果按子节点裁，
 * 一个跨出容器边界的阴影、描边或半截文本就会突然消失，比多画几个节点更糟。
 *
 * 盒子可能在 zoom/滚动变换后跑到负坐标，这里统一用世界坐标（场景坐标）比较。
 */
export interface CullViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CullOptions {
  /** 视口外扩，避免半像素描边在边缘闪烁。 */
  margin?: number;
}

export function intersects(box: { x: number; y: number; width: number; height: number }, viewport: CullViewport, margin = 0): boolean {
  return box.x + box.width >= viewport.x - margin
    && box.x <= viewport.x + viewport.width + margin
    && box.y + box.height >= viewport.y - margin
    && box.y <= viewport.y + viewport.height + margin;
}

/** 过滤掉完全在视口外的根节点；视口为空时原样返回。 */
export function cullScene(nodes: SceneNode[], viewport: CullViewport | undefined, options: CullOptions = {}): SceneNode[] {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return nodes;
  const margin = options.margin ?? 64;
  return nodes.filter(node => intersects(node.box, viewport, margin));
}

/** 统计场景里的节点总数（含子节点），用于基准和断言。 */
export function countSceneNodes(nodes: SceneNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countSceneNodes(node.children);
  return total;
}
