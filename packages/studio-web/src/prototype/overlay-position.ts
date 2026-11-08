import type { OverlayPositionType } from "@ufira/design-schema";

/** 视口与盒子都用场景坐标（960×680 画布坐标系）。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** overlay 贴角时的外边距，和 Figma/Penpot 的手感一致。 */
export const OVERLAY_MARGIN = 24;

export interface OverlayOffsetInput {
  positionType: OverlayPositionType;
  viewport: { width: number; height: number };
  /** overlay 节点自己的绝对盒子。 */
  overlay: Rect;
  /** manual 定位的相对基准（通常是触发节点）。 */
  anchor?: Rect;
  manual?: { x: number; y: number };
}

/**
 * 计算 overlay 的平移量。
 *
 * 返回的是 **dx/dy 而不是绝对坐标**：渲染层直接把这个位移加到子树所有盒子上，
 * 不必知道节点原来摆在哪里。`manual` 相对触发节点，没有基准时退回视口左上角。
 */
export function overlayOffset({ positionType, viewport, overlay, anchor, manual }: OverlayOffsetInput): { dx: number; dy: number } {
  const width = viewport.width;
  const height = viewport.height;
  let targetX: number;
  let targetY: number;

  switch (positionType) {
    case "center":
      targetX = (width - overlay.width) / 2;
      targetY = (height - overlay.height) / 2;
      break;
    case "top-left":
      targetX = OVERLAY_MARGIN;
      targetY = OVERLAY_MARGIN;
      break;
    case "top-center":
      targetX = (width - overlay.width) / 2;
      targetY = OVERLAY_MARGIN;
      break;
    case "top-right":
      targetX = width - overlay.width - OVERLAY_MARGIN;
      targetY = OVERLAY_MARGIN;
      break;
    case "bottom-left":
      targetX = OVERLAY_MARGIN;
      targetY = height - overlay.height - OVERLAY_MARGIN;
      break;
    case "bottom-center":
      targetX = (width - overlay.width) / 2;
      targetY = height - overlay.height - OVERLAY_MARGIN;
      break;
    case "bottom-right":
      targetX = width - overlay.width - OVERLAY_MARGIN;
      targetY = height - overlay.height - OVERLAY_MARGIN;
      break;
    case "manual":
    default: {
      const offset = manual ?? { x: 0, y: 0 };
      targetX = (anchor?.x ?? 0) + offset.x;
      targetY = (anchor?.y ?? 0) + offset.y;
      break;
    }
  }

  return { dx: targetX - overlay.x, dy: targetY - overlay.y };
}
