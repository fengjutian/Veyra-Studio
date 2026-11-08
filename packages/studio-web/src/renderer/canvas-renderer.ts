import { absolutePath, gradientLine, type CornerRadii, type Paint, type PathCommand } from "@ufira/design-schema";
import type { SceneBox, SceneNode } from "./scene";

/**
 * Canvas 2D 渲染器。
 *
 * 借鉴 Excalidraw / tldraw 的做法：形状绘制走 Canvas，文字编辑、选择框、拖拽
 * 手柄继续用 DOM 覆盖层（见画布组件）。这样既拿到了 Canvas 的绘制性能，又不
 * 需要重新实现输入法、文本选择和缩放命中。
 *
 * 渲染分辨率按 `zoom × devicePixelRatio` 设置：缩放时会重新绘制而不是拉伸位图，
 * 所以放大后文字仍然是清晰的。
 */

export interface PaintOptions {
  width: number;
  height: number;
  zoom: number;
  devicePixelRatio: number;
  /** assetId → 已解码的图片。缺图时画占位框。 */
  images: Map<string, CanvasImageSource>;
  background?: string;
  /** 场景绘制完成后的回调，用于选择框等覆盖层；坐标系与场景一致。 */
  onAfterPaint?(context: CanvasRenderingContext2D): void;
}

export interface SceneRenderer {
  paint(scene: SceneNode[], options: PaintOptions): void;
}

export function createCanvas2DRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持 Canvas 2D");

  return {
    paint(scene, options) {
      const scale = Math.max(0.01, options.zoom) * Math.max(1, options.devicePixelRatio);
      canvas.width = Math.max(1, Math.round(options.width * scale));
      canvas.height = Math.max(1, Math.round(options.height * scale));
      // CSS 尺寸保持未缩放：外层容器已经有 `zoom` / transform，再乘一次会双重放大。
      // 位图分辨率仍然是 width × zoom × dpr，所以放大后不会糊。
      canvas.style.width = `${options.width}px`;
      canvas.style.height = `${options.height}px`;

      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, options.width, options.height);
      context.fillStyle = options.background ?? "#ffffff";
      context.fillRect(0, 0, options.width, options.height);

      for (const node of scene) drawNode(context, node, options, 1);
      options.onAfterPaint?.(context);
    },
  };
}

function drawNode(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions, inheritedOpacity: number): void {
  if (node.box.width <= 0 || node.box.height <= 0) return;
  const opacity = clamp(inheritedOpacity * node.opacity, 0, 1);
  if (opacity <= 0) return;

  context.save();
  context.globalAlpha = opacity;
  // 每层都从「无阴影、无滤镜」开始：父节点的效果不继承给子节点（与 Figma 一致）。
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  // `filter` 在新浏览器里才有；缺了就当没有模糊，不要让整页崩掉。
  if ("filter" in context) context.filter = "none";

  if (node.shadow) {
    context.shadowColor = node.shadow.color;
    context.shadowBlur = node.shadow.blur;
    context.shadowOffsetX = node.shadow.x;
    context.shadowOffsetY = node.shadow.y;
  }
  if (node.blur) {
    if ("filter" in context) context.filter = `blur(${node.blur}px)`;
  }

  // 旋转绕节点中心；子树画在同一个上下文里，因此自动继承父级的旋转。
  if (node.rotation) {
    const centerX = node.box.x + node.box.width / 2;
    const centerY = node.box.y + node.box.height / 2;
    context.translate(centerX, centerY);
    context.rotate((node.rotation * Math.PI) / 180);
    context.translate(-centerX, -centerY);
  }

  if (node.text) {
    drawText(context, node, opacity);
  } else if (node.image) {
    drawImage(context, node, options);
  } else {
    drawShape(context, node);
  }

  if (node.children.length) {
    if (node.clip) {
      roundRectPath(context, node.box.x, node.box.y, node.box.width, node.box.height, nodeRadii(node));
      context.clip();
    }
    for (const child of node.children) {
      // 蒙版自身不绘制；它只裁剪同父级里排在它上面的兄弟。
      if (child.mask) continue;
      const masks = child.maskedBy;
      if (masks?.length) {
        // 多层蒙版叠加：每个 save 里依次 clip，画完 restore 掉这一层。
        context.save();
        for (const mask of masks) {
          shapePath(context, mask);
          context.clip();
        }
        drawNode(context, child, options, opacity);
        context.restore();
        continue;
      }
      drawNode(context, child, options, opacity);
    }
  }

  context.restore();
}

function drawShape(context: CanvasRenderingContext2D, node: SceneNode): void {
  const paint = node.paints?.[0];
  if (node.fill || paint) {
    shapePath(context, node);
    context.fillStyle = paint ? canvasPaint(context, node, paint) : node.fill!;
    context.fill();
  }
  if (node.stroke && node.strokeWidth > 0) {
    shapePath(context, node);
    context.strokeStyle = node.stroke;
    context.lineWidth = node.strokeWidth;
    context.stroke();
  }
}

/** 椭圆节点画椭圆；有几何的矢量画路径；其余形状按圆角矩形处理。 */
function shapePath(context: CanvasRenderingContext2D, node: SceneNode): void {
  const { x, y, width, height } = node.box;
  if (node.path) {
    tracePath(context, node.path, node.box);
    return;
  }
  if (node.type === "ellipse") {
    context.beginPath();
    context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    return;
  }
  roundRectPath(context, x, y, width, height, nodeRadii(node));
}

/**
 * 把归一化路径描到画布上。
 *
 * 坐标在发出 `moveTo`/`lineTo`/`bezierCurveTo` 之前就换算成绝对坐标，而不是用
 * `ctx.scale()`：缩放上下文会把描边也拉粗，非等比缩放时竖线比横线粗，看起来像渲染 bug。
 */
function tracePath(context: CanvasRenderingContext2D, commands: PathCommand[], box: SceneBox): void {
  context.beginPath();
  for (const command of absolutePath(commands, box)) {
    if (command.command === "Z") context.closePath();
    else if (command.command === "M") context.moveTo(command.point.x, command.point.y);
    else if (command.command === "L") context.lineTo(command.point.x, command.point.y);
    else if (command.command === "Q") context.quadraticCurveTo(command.control.x, command.control.y, command.point.x, command.point.y);
    else if (command.command === "C") context.bezierCurveTo(command.control1.x, command.control1.y, command.control2.x, command.control2.y, command.point.x, command.point.y);
  }
}

function drawImage(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions): void {
  const image = node.image ? options.images.get(node.image.assetId) : undefined;
  const { x, y, width, height } = node.box;
  if (!image) {
    // 缺图占位：让用户知道这里有一张图，而不是"空白"。
    context.fillStyle = "rgba(148, 163, 184, 0.25)";
    roundRectPath(context, x, y, width, height, nodeRadii(node));
    context.fill();
    return;
  }

  const sourceWidth = imageWidth(image);
  const sourceHeight = imageHeight(image);
  if (!sourceWidth || !sourceHeight) return;
  const fit = node.image?.fit ?? "cover";

  if (fit === "fill") {
    context.drawImage(image, x, y, width, height);
    return;
  }
  const scale = fit === "cover" ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  context.save();
  roundRectPath(context, x, y, width, height, nodeRadii(node));
  context.clip();
  context.drawImage(image, x + (width - drawnWidth) / 2, y + (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  context.restore();
}

function drawText(context: CanvasRenderingContext2D, node: SceneNode, opacity: number): void {
  const text = node.text!;
  const { x, y, width, height } = node.box;
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.fillStyle = text.color;
  context.globalAlpha = opacity;
  context.textBaseline = "top";
  context.textAlign = text.align === "center" ? "center" : text.align === "right" ? "right" : "left";
  context.font = `${text.fontStyle} ${text.fontWeight} ${text.fontSize}px ${quoteFamily(text.fontFamily)}`;
  setLetterSpacing(context, text.letterSpacing);

  const originX = text.align === "center" ? x + width / 2 : text.align === "right" ? x + width : x;
  const lines = wrapText(context, text.value, width);
  const maxLines = Math.max(1, Math.floor(height / Math.max(1, text.lineHeight)));
  for (let index = 0; index < Math.min(lines.length, maxLines); index += 1) {
    context.fillText(lines[index]!, originX, y + index * text.lineHeight);
  }
  setLetterSpacing(context, 0);
}

/** 简单换行：先按显式换行切段，再逐字符累加（对中英混排都够用）。 */
export function wrapText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let current = "";
    for (const char of Array.from(paragraph)) {
      const candidate = current + char;
      if (current && context.measureText(candidate).width > maxWidth) {
        lines.push(current);
        current = char === " " ? "" : char;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

function roundRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radii: number | CornerRadii): void {
  const [topLeft, topRight, bottomRight, bottomLeft] = normalizeRadii(radii, width, height);
  context.beginPath();
  if (!topLeft && !topRight && !bottomRight && !bottomLeft) {
    context.rect(x, y, width, height);
    return;
  }
  // 用 arcTo 每角一次：半径为 0 的角退化成直线，四角不同的矩形因此仍是同一条路径。
  context.moveTo(x + topLeft, y);
  context.arcTo(x + width, y, x + width, y + height, topRight);
  context.arcTo(x + width, y + height, x, y + height, bottomRight);
  context.arcTo(x, y + height, x, y, bottomLeft);
  context.arcTo(x, y, x + width, y, topLeft);
  context.closePath();
}

/** 单个半径按四角相同展开；每个角都钳到不超过短边的一半，避免弧线互相穿透。 */
function normalizeRadii(radii: number | CornerRadii, width: number, height: number): CornerRadii {
  const values: CornerRadii = typeof radii === "number" ? [radii, radii, radii, radii] : radii;
  const limit = Math.max(0, Math.min(width, height) / 2);
  return [clampValue(values[0], limit), clampValue(values[1], limit), clampValue(values[2], limit), clampValue(values[3], limit)];
}

function clampValue(value: number, limit: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), limit) : 0;
}

/** 节点的四角圆角；没有四角独立值时退回单值。 */
function nodeRadii(node: SceneNode): number | CornerRadii {
  return node.radii ?? node.radius;
}

function quoteFamily(family: string): string {
  const trimmed = family.trim() || "sans-serif";
  return /[,"]/.test(trimmed) ? trimmed : `"${trimmed}", sans-serif`;
}

function setLetterSpacing(context: CanvasRenderingContext2D, spacing: number): void {
  // letterSpacing 是比较新的属性；旧浏览器忽略即可。
  const withSpacing = context as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in withSpacing) withSpacing.letterSpacing = `${spacing}px`;
}

function imageWidth(image: CanvasImageSource): number {
  const value = image as { width?: number; videoWidth?: number; naturalWidth?: number };
  return value.naturalWidth ?? value.videoWidth ?? value.width ?? 0;
}

function imageHeight(image: CanvasImageSource): number {
  const value = image as { height?: number; videoHeight?: number; naturalHeight?: number };
  return value.naturalHeight ?? value.videoHeight ?? value.height ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 填充 → Canvas 的 fillStyle。
 *
 * 渐变的几何来自 `gradientLine`，和 SVG/HTML 导出共用同一套角度定义；色标先按 offset
 * 排序，因为 Canvas 要求 addColorStop 单调递增。
 */
function canvasPaint(context: CanvasRenderingContext2D, node: SceneNode, paint: Paint): string | CanvasGradient {
  if (paint.type === "solid") return paint.color;
  const line = gradientLine(node.box, paint.angle);
  const gradient = context.createLinearGradient(line.x1, line.y1, line.x2, line.y2);
  for (const stop of [...paint.stops].sort((a, b) => a.offset - b.offset)) gradient.addColorStop(stop.offset, stop.color);
  return gradient;
}