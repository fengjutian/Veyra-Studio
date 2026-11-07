import { HANDLE_IDS, handleCenters, type Rect } from "./selection";

/**
 * 选择框与手柄的绘制。
 *
 * 用 Canvas 画而不是 DOM 覆盖层：不增加 DOM 节点，缩放时随场景一起重绘。
 * 手柄尺寸按屏幕像素换算（除以 zoom），所以放大画布时手柄不会跟着变大。
 */
export interface SelectionOverlayOptions {
  color?: string;
  /** 手柄边长（屏幕像素）。 */
  handleSize?: number;
  /** 当前缩放，用于让描边与手柄保持屏幕尺寸。 */
  zoom?: number;
  /** 只画轮廓（拖拽中隐藏手柄）。 */
  outlineOnly?: boolean;
}

export function paintSelectionOverlay(context: CanvasRenderingContext2D, bounds: Rect, options: SelectionOverlayOptions = {}): void {
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#8b5cf6";
  const screenSize = options.handleSize ?? 8;
  const size = screenSize / zoom;
  const lineWidth = 1.5 / zoom;

  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);

  if (!options.outlineOnly) {
    const centers = handleCenters(bounds);
    context.fillStyle = "#ffffff";
    context.lineWidth = 1.5 / zoom;
    for (const id of HANDLE_IDS) {
      const center = centers[id];
      const x = center.x - size / 2;
      const y = center.y - size / 2;
      context.fillRect(x, y, size, size);
      context.strokeRect(x, y, size, size);
    }
  }
  context.restore();
}

/** 框选矩形：半透明填充 + 描边，线宽按 zoom 保持屏幕 1px。 */
export function paintMarquee(context: CanvasRenderingContext2D, rect: { x: number; y: number; width: number; height: number }, options: { color?: string; zoom?: number } = {}): void {
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#8b5cf6";
  context.save();
  context.fillStyle = "rgba(139, 92, 246, 0.12)";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = color;
  context.lineWidth = 1 / zoom;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.restore();
}