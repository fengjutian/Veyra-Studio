import type { PathCommand } from "@ufira/design-schema";
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

/**
 * 绘制预览：正在拉出来的图形轮廓。
 *
 * 用虚线与框选的实线区分开——框选是在「选已有对象」，绘制是在「造新对象」，
 * 两者的视觉语言不该一样。线宽与虚线段长都按 zoom 换算，保持屏幕像素恒定。
 */
export function paintDrawPreview(
  context: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  options: { color?: string; zoom?: number; shape?: "rectangle" | "ellipse" | "frame" | "text" | "line" | "polygon" | "star" } = {},
): void {
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#8b5cf6";
  const width = Math.max(rect.width, 0);
  const height = Math.max(rect.height, 0);
  context.save();
  context.fillStyle = "rgba(139, 92, 246, 0.08)";
  context.strokeStyle = color;
  context.lineWidth = 1.5 / zoom;
  context.setLineDash([4 / zoom, 3 / zoom]);
  context.beginPath();
  if (options.shape === "ellipse") {
    context.ellipse(rect.x + width / 2, rect.y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    context.rect(rect.x, rect.y, width, height);
  }
  context.fill();
  context.stroke();
  context.restore();
}

/** 对齐辅助线：贯穿画布视口的 1px 线（按 zoom 换算保持屏幕宽度）。 */
export function paintSnapGuides(
  context: CanvasRenderingContext2D,
  guides: Array<{ orientation: "vertical" | "horizontal"; position: number }>,
  extent: { width: number; height: number },
  options: { color?: string; zoom?: number } = {},
): void {
  if (!guides.length) return;
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  context.save();
  context.strokeStyle = options.color ?? "#f472b6";
  context.lineWidth = 1 / zoom;
  context.beginPath();
  for (const guide of guides) {
    if (guide.orientation === "vertical") {
      context.moveTo(guide.position, 0);
      context.lineTo(guide.position, extent.height);
    } else {
      context.moveTo(0, guide.position);
      context.lineTo(extent.width, guide.position);
    }
  }
  context.stroke();
  context.restore();
}
/**
 * 钢笔草稿路径。
 *
 * 只描边不填充：草稿既可能是开放曲线也可能是闭合形状，提前填充会误导用户以为已经成形。
 * 线宽与虚线按 zoom 换算，保持屏幕像素恒定。
 */
export function paintPathPreview(
  context: CanvasRenderingContext2D,
  commands: PathCommand[],
  options: { color?: string; zoom?: number } = {},
): void {
  if (!commands.length) return;
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  context.save();
  context.strokeStyle = options.color ?? "#a78bfa";
  context.lineWidth = 1.5 / zoom;
  context.setLineDash([5 / zoom, 4 / zoom]);
  context.beginPath();
  for (const command of commands) {
    if (command.command === "Z") context.closePath();
    else if (command.command === "M") context.moveTo(command.point.x, command.point.y);
    else if (command.command === "L") context.lineTo(command.point.x, command.point.y);
    else if (command.command === "Q") context.quadraticCurveTo(command.control.x, command.control.y, command.point.x, command.point.y);
    else if (command.command === "C") context.bezierCurveTo(command.control1.x, command.control1.y, command.control2.x, command.control2.y, command.point.x, command.point.y);
  }
  context.stroke();
  context.restore();
}

/**
 * 钢笔锚点。
 *
 * 起点在「可以闭合」时画成空心圆环：Figma 同样用圆形光标提示「点这里会闭合」。
 */
export function paintPathAnchors(
  context: CanvasRenderingContext2D,
  anchors: Array<{ x: number; y: number }>,
  options: { color?: string; zoom?: number; closing?: boolean } = {},
): void {
  if (!anchors.length) return;
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#a78bfa";
  const size = 6 / zoom;
  context.save();
  for (const [index, anchor] of anchors.entries()) {
    if (index === 0 && options.closing) {
      context.beginPath();
      context.arc(anchor.x, anchor.y, 9 / zoom, 0, Math.PI * 2);
      context.fillStyle = "rgba(167, 139, 250, 0.18)";
      context.fill();
      context.strokeStyle = color;
      context.lineWidth = 1.5 / zoom;
      context.stroke();
      continue;
    }
    context.fillStyle = "#ffffff";
    context.strokeStyle = color;
    context.lineWidth = 1.5 / zoom;
    context.fillRect(anchor.x - size / 2, anchor.y - size / 2, size, size);
    context.strokeRect(anchor.x - size / 2, anchor.y - size / 2, size, size);
  }
  context.restore();
}
/**
 * 路径编辑的锚点与手柄。
 *
 * 画在场景坐标里，但尺寸按 zoom 换算，所以放大画布时锚点不会跟着变大。
 * 手柄先画线、再画端点，锚点最后画——保证锚点永远在最上层，不会被手柄盖住。
 */
export function paintPathEdit(
  context: CanvasRenderingContext2D,
  edit: { anchors: Array<{ x: number; y: number }>; handles: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>; selected: number | null },
  options: { color?: string; zoom?: number } = {},
): void {
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#a78bfa";
  context.save();

  context.strokeStyle = color;
  context.lineWidth = 1 / zoom;
  for (const handle of edit.handles) {
    context.beginPath();
    context.moveTo(handle.from.x, handle.from.y);
    context.lineTo(handle.to.x, handle.to.y);
    context.stroke();
  }

  context.fillStyle = color;
  for (const handle of edit.handles) {
    context.beginPath();
    context.arc(handle.to.x, handle.to.y, 3.5 / zoom, 0, Math.PI * 2);
    context.fill();
  }

  const size = 7 / zoom;
  for (const [index, anchor] of edit.anchors.entries()) {
    const x = anchor.x - size / 2;
    const y = anchor.y - size / 2;
    context.fillStyle = index === edit.selected ? color : "#ffffff";
    context.fillRect(x, y, size, size);
    context.strokeStyle = color;
    context.lineWidth = 1.5 / zoom;
    context.strokeRect(x, y, size, size);
  }
  context.restore();
}