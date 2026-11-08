import type { Rect } from "./selection";
import type { SnapGuide, SnapOptions, SnapResult, SnapTarget } from "./snapping";

/**
 * 智能锚点吸附。
 *
 * 基础版（`snapping.ts` 的 `snapBox`）只做「左/中/右、上/中/下」的对齐线，
 * 拖动时能对齐，但看不出「为什么吸过去了」。Figma 的智能辅助线还给出：
 *
 * - **锚点**（角点 / 边中点 / 中心）：吸过去时知道是哪个点对上了；
 * - **等间距**：三个对象之间的间距相等时给出提示，并画出两段间距标注；
 * - **延长线**：把一条边对齐到另一个对象时，辅助线贯穿画布。
 *
 * 这里全部是纯几何：不依赖 DOM / Canvas，方便单测。
 */

/** 一个盒子的锚点。 */
export interface Anchor {
  x: number;
  y: number;
  kind: "corner" | "edge" | "center";
  /**
   * 这个锚点参与哪条轴的对齐。
   *
   * - `x`：竖边中点（左边 / 右边）——只影响水平对齐；
   * - `y`：横边中点（上边 / 下边）——只影响竖直对齐；
   * - `both`：角点与中心——两条轴都参与。
   */
  axis: "x" | "y" | "both";
}

/**
 * 盒子的九个锚点：四角 + 四边中点 + 中心。
 *
 * 与 Figma 一致：角点与中心参与两条轴，边中点只参与自己垂直的那条轴
 * （左边中点参与水平对齐，不该把竖直位置也吸过去）。
 */
export function anchorPoints(box: Rect): Anchor[] {
  const { x, y, width, height } = box;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  return [
    { x, y, kind: "corner", axis: "both" },
    { x: x + width, y, kind: "corner", axis: "both" },
    { x, y: y + height, kind: "corner", axis: "both" },
    { x: x + width, y: y + height, kind: "corner", axis: "both" },
    { x: centerX, y, kind: "edge", axis: "y" },
    { x: centerX, y: y + height, kind: "edge", axis: "y" },
    { x, y: centerY, kind: "edge", axis: "x" },
    { x: x + width, y: centerY, kind: "edge", axis: "x" },
    { x: centerX, y: centerY, kind: "center", axis: "both" },
  ];
}

/** 智能吸附的选项（在基础版之上）。 */
export interface SmartSnapOptions extends SnapOptions {
  /** 总开关：关掉就完全不吸附。 */
  enabled?: boolean;
  /** 等间距检测（默认开）。 */
  spacing?: boolean;
}

/** 一个轴上的等间距候选。 */
interface SpacingCandidate {
  axis: "x" | "y";
  /** 需要额外移动多少（场景单位）。 */
  delta: number;
  /** 两段间距的值（px）。 */
  spacing: number;
  /** 移动后两段间距的区间（沿该轴）。 */
  segments: Array<{ from: number; to: number }>;
  /** 参与的两个目标节点。 */
  targetNodeIds: [string, string];
  /** 垂直于该轴的绘制位置（另一轴上的中心）。 */
  cross: number;
}

/** 轴上的起点 / 终点。 */
function span(box: Rect, axis: "x" | "y"): { start: number; end: number } {
  return axis === "x"
    ? { start: box.x, end: box.x + box.width }
    : { start: box.y, end: box.y + box.height };
}

/** 另一轴上的中心（绘制等间距标注时用）。 */
function crossCenter(box: Rect, axis: "x" | "y"): number {
  return axis === "x" ? box.y + box.height / 2 : box.x + box.width / 2;
}

/**
 * 找到「移动对象夹在两个目标中间，两侧间距相等」的候选。
 *
 * 这是 Figma 最常见的等间距提示：拖到差不多居中的位置就吸过去。
 */
function spacingBetween(box: Rect, targets: SnapTarget[], axis: "x" | "y"): SpacingCandidate | undefined {
  const moving = span(box, axis);
  const before = targets
    .map(target => ({ target, span: span(target.box, axis) }))
    .filter(item => item.span.end <= moving.start + 0.5)
    .sort((a, b) => b.span.end - a.span.end);
  const after = targets
    .map(target => ({ target, span: span(target.box, axis) }))
    .filter(item => item.span.start >= moving.end - 0.5)
    .sort((a, b) => a.span.start - b.span.start);
  if (!before.length || !after.length) return undefined;

  const left = before[0]!;
  const right = after[0]!;
  const gapLeft = moving.start - left.span.end;
  const gapRight = right.span.start - moving.end;
  // 两侧间距已经相等：不需要移动，但仍然给提示。
  if (Math.abs(gapLeft - gapRight) > 1) {
    const free = right.span.start - left.span.end;
    const spacing = (free - (moving.end - moving.start)) / 2;
    const delta = axis === "x"
      ? (left.span.start + right.span.end) / 2 - (moving.start + moving.end) / 2
      : (left.span.start + right.span.end) / 2 - (moving.start + moving.end) / 2;
    return {
      axis,
      delta,
      spacing,
      segments: [
        { from: left.span.end, to: left.span.end + spacing },
        { from: right.span.start - spacing, to: right.span.start },
      ],
      targetNodeIds: [left.target.nodeId, right.target.nodeId],
      cross: crossCenter(box, axis),
    };
  }
  return {
    axis,
    delta: 0,
    spacing: gapLeft,
    segments: [
      { from: left.span.end, to: moving.start },
      { from: moving.end, to: right.span.start },
    ],
    targetNodeIds: [left.target.nodeId, right.target.nodeId],
    cross: crossCenter(box, axis),
  };
}

/**
 * 找到「一串等间距的目标之外，移动对象接上去」的候选。
 *
 * 例如三个卡片已经等距排列，把第四个拖到右边——吸过去让间距保持一致。
 */
function spacingAfterRun(box: Rect, targets: SnapTarget[], axis: "x" | "y"): SpacingCandidate | undefined {
  if (targets.length < 3) return undefined;
  const sorted = targets
    .map(target => ({ target, span: span(target.box, axis) }))
    .sort((a, b) => a.span.start - b.span.start);
  const moving = span(box, axis);
  for (let index = 0; index + 2 < sorted.length; index += 1) {
    const first = sorted[index]!;
    const second = sorted[index + 1]!;
    const third = sorted[index + 2]!;
    const gapA = second.span.start - first.span.end;
    const gapB = third.span.start - second.span.end;
    if (Math.abs(gapA - gapB) > 1) continue;
    const spacing = (gapA + gapB) / 2;
    // 移动对象在整串的右边。
    if (moving.start >= third.span.end - 0.5) {
      const desiredStart = third.span.end + spacing;
      const delta = desiredStart - moving.start;
      return {
        axis,
        delta,
        spacing,
        segments: [{ from: third.span.end, to: desiredStart }],
        targetNodeIds: [second.target.nodeId, third.target.nodeId],
        cross: crossCenter(box, axis),
      };
    }
    // 移动对象在整串的左边。
    if (moving.end <= first.span.start + 0.5) {
      const desiredEnd = first.span.start - spacing;
      const delta = desiredEnd - moving.end;
      return {
        axis,
        delta,
        spacing,
        segments: [{ from: desiredEnd, to: first.span.start }],
        targetNodeIds: [first.target.nodeId, second.target.nodeId],
        cross: crossCenter(box, axis),
      };
    }
  }
  return undefined;
}

/** 一个轴上的最佳吸附（对齐优先，其次等间距）。 */
interface AxisSnap {
  delta: number;
  guide?: SnapGuide;
}

/**
 * 智能吸附：锚点对齐 + 等间距。
 *
 * 每个轴各自选「移动量最小」的候选；对齐线与等间距提示都可能同时出现
 * （一个轴对齐、另一个轴等间距）。
 */
export function snapNode(box: Rect, targets: SnapTarget[], options: SmartSnapOptions): SnapResult {
  if (options.enabled === false) return { deltaX: 0, deltaY: 0, guides: [] };
  const threshold = Math.max(0, options.threshold);

  const x = axisSnap(box, targets, "x", threshold);
  const y = axisSnap(box, targets, "y", threshold);

  const guides: SnapGuide[] = [];
  if (x.guide) guides.push(x.guide);
  if (y.guide) guides.push(y.guide);
  return { deltaX: x.delta, deltaY: y.delta, guides };
}

/** 单轴上的吸附：先看锚点对齐，再看等间距，取移动量更小的那个。 */
function axisSnap(box: Rect, targets: SnapTarget[], axis: "x" | "y", threshold: number): AxisSnap {
  let best: AxisSnap = { delta: 0 };

  // 锚点对齐：移动对象的某个锚点与目标的某个锚点重合。
  const movingAnchors = anchorPoints(box);
  for (const target of targets) {
    for (const targetAnchor of anchorPoints(target.box)) {
      for (const movingAnchor of movingAnchors) {
        const participates = movingAnchor.axis === "both" || targetAnchor.axis === "both" || movingAnchor.axis === axis;
        if (!participates) continue;
        const delta = axis === "x" ? targetAnchor.x - movingAnchor.x : targetAnchor.y - movingAnchor.y;
        if (Math.abs(delta) > threshold) continue;
        if (best.guide && Math.abs(delta) >= Math.abs(best.delta)) continue;
        best = {
          delta,
          guide: {
            orientation: axis === "x" ? "vertical" : "horizontal",
            position: axis === "x" ? targetAnchor.x : targetAnchor.y,
            targetNodeId: target.nodeId,
            kind: movingAnchor.kind === "corner" && targetAnchor.kind === "corner" ? "corner" : movingAnchor.kind === "center" ? "center" : "edge",
          },
        };
      }
    }
  }

  // 等间距：与对齐冲突时取移动量更小的那个。
  if (threshold > 0) {
    const candidates = [spacingBetween(box, targets, axis), spacingAfterRun(box, targets, axis)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (Math.abs(candidate.delta) > threshold) continue;
      if (best.guide && Math.abs(candidate.delta) >= Math.abs(best.delta)) continue;
      best = {
        delta: candidate.delta,
        guide: {
          orientation: axis === "x" ? "horizontal" : "vertical",
          position: axis === "x" ? candidate.segments[0]!.from : candidate.segments[0]!.from,
          targetNodeId: candidate.targetNodeIds[0],
          kind: "spacing",
          spacing: candidate.spacing,
          segments: candidate.segments,
          axis: candidate.axis,
          cross: candidate.cross,
          targetNodeIds: [...candidate.targetNodeIds],
        },
      };
    }
  }
  return best;
}
