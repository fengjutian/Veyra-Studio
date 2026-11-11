import type { PathCommand } from "@ufira/design-schema";
import { boxCenter, rotatePoint, rotatedCorners, rotatedHandleCenters, rotationHandlePoint, ROTATE_HANDLE_GAP } from "./rotation";
import { HANDLE_IDS, handleCenters, type Rect } from "./selection";
import type { SnapGuide } from "./snapping";

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
  /** 节点的旋转角（弧度）；非零时轮廓与手柄都跟着转。 */
  rotation?: number;
  /** 是否绘制框外的旋转手柄（单选与多选都有意义）。 */
  showRotateHandle?: boolean;
  /** 旋转角度文案（画在旋转手柄旁边）；省略就不画。 */
  angleLabel?: string;
}

export function paintSelectionOverlay(context: CanvasRenderingContext2D, bounds: Rect, options: SelectionOverlayOptions = {}): void {
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#8b5cf6";
  const screenSize = options.handleSize ?? 8;
  const size = screenSize / zoom;
  const lineWidth = 1.5 / zoom;

  const corners = options.rotation ? rotatedCorners(bounds, options.rotation) : undefined;
  const centers = options.rotation ? rotatedHandleCenters(bounds, options.rotation) : handleCenters(bounds);

  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  if (corners) {
    context.beginPath();
    context.moveTo(corners[0].x, corners[0].y);
    for (const corner of corners.slice(1)) context.lineTo(corner.x, corner.y);
    context.closePath();
    context.stroke();
  } else {
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  if (!options.outlineOnly) {
    context.fillStyle = "#ffffff";
    context.lineWidth = 1.5 / zoom;
    for (const id of HANDLE_IDS) {
      const center = centers[id];
      const x = center.x - size / 2;
      const y = center.y - size / 2;
      context.fillRect(x, y, size, size);
      context.strokeRect(x, y, size, size);
    }
    // 框外旋转手柄：从顶边中点引一条短线，末端画圆。位置随旋转走，所以始终在盒子「正上方」。
    if (options.showRotateHandle) {
      const rotation = options.rotation ?? 0;
      const center = boxCenter(bounds);
      const gap = ROTATE_HANDLE_GAP / zoom;
      const anchor = rotatePoint({ x: center.x, y: bounds.y }, center, rotation);
      const handle = rotationHandlePoint(bounds, rotation, gap);
      context.beginPath();
      context.moveTo(anchor.x, anchor.y);
      context.lineTo(handle.x, handle.y);
      context.stroke();
      context.beginPath();
      context.arc(handle.x, handle.y, 4.5 / zoom, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      // 角度读数：多选旋转时整组一起转，光看图形看不出转了多少度。
      if (options.angleLabel) {
        context.font = `${11 / zoom}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.fillStyle = color;
        context.fillText(options.angleLabel, handle.x, handle.y - 8 / zoom);
      }
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

/**
 * 可以画出来的辅助线。
 *
 * 比 {@link SnapGuide} 宽松：只要有 `orientation` 与 `position` 就能画，
 * 辅助线上的目标节点 id 只有吸附模块自己用得上。
 */
export interface PaintableGuide {
  orientation: "vertical" | "horizontal";
  position: number;
  kind?: SnapGuide["kind"];
  spacing?: number;
  segments?: SnapGuide["segments"];
  axis?: SnapGuide["axis"];
  cross?: number;
}

/**
 * 对齐辅助线：贯穿画布视口的 1px 线（按 zoom 换算保持屏幕宽度）。
 *
 * 等间距提示（`kind: "spacing"`）画成两段带端点的短线，并标上间距值——
 * Figma 的做法：光看一条贯穿全屏的线，用户不知道「吸过去是因为间距相等」。
 */
export function paintSnapGuides(
  context: CanvasRenderingContext2D,
  guides: PaintableGuide[],
  extent: { width: number; height: number },
  options: { color?: string; zoom?: number } = {},
): void {
  if (!guides.length) return;
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  context.save();
  context.strokeStyle = options.color ?? "#f472b6";
  context.lineWidth = 1 / zoom;
  context.beginPath();
  const labels: Array<{ text: string; x: number; y: number }> = [];
  for (const guide of guides) {
    if (guide.kind === "spacing" && guide.segments?.length) {
      const cross = guide.cross ?? 0;
      for (const segment of guide.segments) {
        if (guide.axis === "y") {
          context.moveTo(cross, segment.from);
          context.lineTo(cross, segment.to);
          // 端点刻度。
          context.moveTo(cross - 4 / zoom, segment.from);
          context.lineTo(cross + 4 / zoom, segment.from);
          context.moveTo(cross - 4 / zoom, segment.to);
          context.lineTo(cross + 4 / zoom, segment.to);
        } else {
          context.moveTo(segment.from, cross);
          context.lineTo(segment.to, cross);
          context.moveTo(segment.from, cross - 4 / zoom);
          context.lineTo(segment.from, cross + 4 / zoom);
          context.moveTo(segment.to, cross - 4 / zoom);
          context.lineTo(segment.to, cross + 4 / zoom);
        }
        if (guide.spacing !== undefined) {
          const middle = (segment.from + segment.to) / 2;
          labels.push(guide.axis === "y"
            ? { text: String(Math.round(guide.spacing)), x: cross + 6 / zoom, y: middle }
            : { text: String(Math.round(guide.spacing)), x: middle, y: cross - 6 / zoom });
        }
      }
      continue;
    }
    if (guide.orientation === "vertical") {
      context.moveTo(guide.position, 0);
      context.lineTo(guide.position, extent.height);
    } else {
      context.moveTo(0, guide.position);
      context.lineTo(extent.width, guide.position);
    }
  }
  context.stroke();
  // 文字单独画：fillText 不走 beginPath 的批次。
  if (labels.length) {
    context.font = `${11 / zoom}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = options.color ?? "#f472b6";
    for (const label of labels) context.fillText(label.text, label.x, label.y);
  }
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
  edit: {
    anchors: Array<{ x: number; y: number }>;
    handles: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
    selected: number[];
    anchorTypes?: Array<"corner" | "smooth" | "cusp">;
  },
  options: { color?: string; zoom?: number } = {},
): void {
  const zoom = options.zoom && options.zoom > 0 ? options.zoom : 1;
  const color = options.color ?? "#a78bfa";
  const selected = new Set(edit.selected);
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
    context.fillStyle = selected.has(index) ? color : "#ffffff";
    // 角点是方块、平滑点是圆、尖角是菱形——三种类型一眼能分出来。
    const type = edit.anchorTypes?.[index] ?? "corner";
    context.beginPath();
    if (type === "smooth") {
      context.arc(anchor.x, anchor.y, size / 2, 0, Math.PI * 2);
    } else if (type === "cusp") {
      context.moveTo(anchor.x, y);
      context.lineTo(x + size, anchor.y);
      context.lineTo(anchor.x, y + size);
      context.lineTo(x, anchor.y);
      context.closePath();
    } else {
      context.rect(x, y, size, size);
    }
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 1.5 / zoom;
    context.stroke();
  }
  context.restore();
}