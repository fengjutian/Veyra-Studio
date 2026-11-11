import { rotatedBounds, toRadians } from "./rotation";
import type { SceneNode } from "./scene";
import type { Rect } from "./selection";

/**
 * 视口裁剪（culling）。
 *
 * 两种策略：
 *
 * - `conservative`：只裁根节点（早期行为）。与视口相交的根节点整棵绘制。
 * - `aggressive`（默认）：递归裁子节点。子节点各自与视口比较，不在视口里的整棵丢掉。
 *
 * 激进策略必须配**安全边界**：阴影、描边、模糊、蒙版羽化都会让绘制范围超出盒子，
 * 旋转还会把盒子转出原来的轴对齐范围。只按盒子裁，这些效果会在边缘凭空消失。
 *
 * 盒子可能在 zoom/滚动变换后跑到负坐标，这里统一用世界坐标（场景坐标）比较。
 */
export interface CullViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 裁剪策略。 */
export type CullMode = "conservative" | "aggressive";

export interface CullOptions {
  /** 视口外扩，避免半像素描边在边缘闪烁。 */
  margin?: number;
  /** 裁剪策略；缺省是激进的（递归裁子节点）。 */
  mode?: CullMode;
  /** 是否按阴影、描边、模糊与旋转外扩安全边界；缺省 true。 */
  safeBounds?: boolean;
}

export function intersects(box: { x: number; y: number; width: number; height: number }, viewport: CullViewport, margin = 0): boolean {
  return box.x + box.width >= viewport.x - margin
    && box.x <= viewport.x + viewport.width + margin
    && box.y + box.height >= viewport.y - margin
    && box.y <= viewport.y + viewport.height + margin;
}

/**
 * 效果带来的额外绘制范围（每个方向）。
 *
 * 描边画在盒子边界上（外扩半个线宽）；投影按偏移挪开再模糊；图层模糊与蒙版羽化
 * 都会把内容糊出盒子。
 */
function effectPadding(node: SceneNode): number {
  let padding = node.strokeWidth / 2;
  if (node.blur) padding += node.blur;
  if (node.maskFeather) padding += node.maskFeather;
  const shadow = node.shadow;
  if (shadow) padding += shadow.blur / 2 + (shadow.spread ?? 0) + Math.max(Math.abs(shadow.x), Math.abs(shadow.y));
  return padding;
}

/**
 * 节点真正会被画到的范围。
 *
 * 旋转过的节点要按旋转后的 AABB 算：轴对齐盒会漏掉转出去的那一角。
 */
export function paintBounds(node: SceneNode, safe = true): Rect {
  const box = node.rotation ? rotatedBounds(node.box, toRadians(node.rotation)) : node.box;
  if (!safe) return box;
  const padding = effectPadding(node);
  if (!padding) return box;
  return { x: box.x - padding, y: box.y - padding, width: box.width + padding * 2, height: box.height + padding * 2 };
}

/**
 * 按视口裁剪场景。
 *
 * 激进策略下，子节点会被递归裁掉——但**不能**因为父节点不在视口就丢掉它的子树：
 * `overflow: visible` 的容器里，子节点可以跑到父盒子外面还看得见。
 */
export function cullScene(nodes: SceneNode[], viewport: CullViewport | undefined, options: CullOptions = {}): SceneNode[] {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) return nodes;
  const margin = options.margin ?? 64;
  const mode = options.mode ?? "aggressive";
  if (mode === "conservative") return nodes.filter(node => intersects(node.box, viewport, margin));
  return cullNodes(nodes, viewport, margin, options.safeBounds ?? true);
}

/** 递归裁剪：节点自身不在视口、又没有可见后代时，整棵丢掉。 */
function cullNodes(nodes: SceneNode[], viewport: CullViewport, margin: number, safe: boolean): SceneNode[] {
  const result: SceneNode[] = [];
  for (const node of nodes) {
    const children = node.children.length ? cullNodes(node.children, viewport, margin, safe) : node.children;
    // 子节点被裁光了、自己也看不见，就整棵丢掉。
    if (!children.length && !intersects(paintBounds(node, safe), viewport, margin)) continue;
    result.push(children === node.children ? node : { ...node, children });
  }
  return result;
}

/** 统计场景里的节点总数（含子节点），用于基准和断言。 */
export function countSceneNodes(nodes: SceneNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countSceneNodes(node.children);
  return total;
}
