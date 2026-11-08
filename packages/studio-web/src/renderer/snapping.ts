import type { Rect } from "./selection";
import type { SceneBox } from "./scene";

/**
 * 对齐吸附（snapping）。
 *
 * 拖动时把选区盒子与其它节点的左/中/右、上/中/下对齐线比较，取阈值内最近的一条，
 * 输出吸附后的位移与需要绘制的辅助线。纯几何，不依赖 DOM 或 Canvas。
 */
export interface SnapTarget {
  nodeId: string;
  box: SceneBox;
}

export interface SnapGuide {
  orientation: "vertical" | "horizontal";
  /** 场景坐标：竖线是 x，横线是 y。 */
  position: number;
  targetNodeId: string;
  /**
   * 辅助线的语义（新增字段，旧代码只读前三个字段，不受影响）。
   *
   * - `corner` / `edge` / `center`：锚点对齐；
   * - `spacing`：等间距提示，配套 `spacing` / `segments` / `axis` / `cross`。
   */
  kind?: "corner" | "edge" | "center" | "spacing";
  /** 等间距辅助线上的间距值（px）。 */
  spacing?: number;
  /** 等间距辅助线的两段区间（沿 `axis` 轴）。 */
  segments?: Array<{ from: number; to: number }>;
  /** 等间距发生在哪条轴上。 */
  axis?: "x" | "y";
  /** 绘制等间距标注时垂直于该轴的位置。 */
  cross?: number;
  /** 参与等间距的两个节点。 */
  targetNodeIds?: string[];
}

export interface SnapResult {
  deltaX: number;
  deltaY: number;
  guides: SnapGuide[];
}

export interface SnapOptions {
  /** 吸附阈值（场景单位，调用方按 6px / zoom 传入）。 */
  threshold: number;
  /** 总开关：关掉就完全不吸附。 */
  enabled?: boolean;
}

/** 选区各轴上的候选边：左、中、右（或上、中、下）。 */
function axisValues(box: Rect, axis: "x" | "y"): number[] {
  const start = axis === "x" ? box.x : box.y;
  const size = axis === "x" ? box.width : box.height;
  return [start, start + size / 2, start + size];
}

export function snapBox(box: Rect, targets: SnapTarget[], options: SnapOptions): SnapResult {
  const threshold = Math.max(0, options.threshold);
  let bestX: { delta: number; position: number; nodeId: string } | undefined;
  let bestY: { delta: number; position: number; nodeId: string } | undefined;

  for (const target of targets) {
    for (const moving of axisValues(box, "x")) {
      for (const line of axisValues(target.box, "x")) {
        const delta = line - moving;
        if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
          bestX = { delta, position: line, nodeId: target.nodeId };
        }
      }
    }
    for (const moving of axisValues(box, "y")) {
      for (const line of axisValues(target.box, "y")) {
        const delta = line - moving;
        if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
          bestY = { delta, position: line, nodeId: target.nodeId };
        }
      }
    }
  }

  const guides: SnapGuide[] = [];
  if (bestX) guides.push({ orientation: "vertical", position: bestX.position, targetNodeId: bestX.nodeId });
  if (bestY) guides.push({ orientation: "horizontal", position: bestY.position, targetNodeId: bestY.nodeId });
  return { deltaX: bestX?.delta ?? 0, deltaY: bestY?.delta ?? 0, guides };
}

/** 除被拖动子树外的顶层节点，作为吸附目标。 */
export function snapTargetsFromScene(scene: Array<{ id: string; box: SceneBox; children: Array<{ id: string }> }>, exclude: Iterable<string>): SnapTarget[] {
  const excluded = new Set(exclude);
  const targets: SnapTarget[] = [];
  for (const node of scene) {
    if (excluded.has(node.id)) continue;
    targets.push({ nodeId: node.id, box: node.box });
  }
  return targets;
}
