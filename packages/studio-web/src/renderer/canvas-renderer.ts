import { absolutePath, canvasCompositeFor, ellipticalGeometry, gradientLine, radialGeometry, type CornerRadii, type Paint, type PathCommand } from "@ufira/design-schema";
import { layoutRichText, type RichTextStyle } from "@ufira/design-layout";
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
  /** 画布表达不了的能力（不支持的混合模式、背景模糊）在这里提示。 */
  onWarning?(message: string): void;
  /** 椭圆渐变的离屏画布工厂；缺省用 OffscreenCanvas / document.createElement。 */
  gradientSurface?: GradientSurfaceFactory;
  /** 椭圆渐变离屏画布的边长（px）。 */
  gradientSize?: number;
}

/**
 * 椭圆渐变用的离屏画布。
 *
 * Canvas 2D 的 `createRadialGradient` 只能画正圆，画不出椭圆。
 * 变通办法：先在离屏画布上画一个正圆渐变，再把它按椭圆的外接矩形贴回去——
 * 圆形被非等比缩放后就是椭圆，而被填充的形状本身一点没变形。
 */
export interface GradientSurface {
  /** 贴回主画布的位图。 */
  image: CanvasImageSource;
}

/**
 * 离屏画布工厂：返回一个**已经画好这条渐变**的画布。
 *
 * 契约是「给我一张画好渐变的图」，而不是「给我一张空图」——
 * 这样缓存键（色标）由调用方决定，工厂只管把图画好。
 */
export type GradientSurfaceFactory = (paint: Extract<Paint, { type: "elliptical" }>, size: number) => GradientSurface | undefined;

export interface SceneRenderer {
  paint(scene: SceneNode[], options: PaintOptions): void;
}

/** 椭圆渐变离屏画布的默认边长：512 足够让 256 半径的圆形渐变看不出锯齿。 */
const DEFAULT_GRADIENT_SIZE = 512;

export function createCanvas2DRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持 Canvas 2D");
  // 同一条提示只报一次：画布每帧都会重绘，不去重的话控制台会被刷屏。
  const warned = new Set<string>();
  // 离屏画布按色标缓存：同一个渐变不需要每帧重画一遍。
  const surfaces = new Map<string, GradientSurface>();

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

      const effective: PaintOptions = {
        ...options,
        onWarning: message => {
          if (warned.has(message)) return;
          warned.add(message);
          if (options.onWarning) options.onWarning(message);
          else console.warn(message);
        },
        gradientSurface: (paint, size) => {
          const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
          const key = `${size}|${stops.map(stop => `${stop.offset}:${stop.color}`).join(",")}`;
          const cached = surfaces.get(key);
          if (cached) return cached;
          const factory = options.gradientSurface ?? defaultGradientSurfaceFactory;
          const surface = factory(paint, size);
          if (surface) surfaces.set(key, surface);
          return surface;
        },
      };
      for (const node of scene) drawNode(context, node, effective, 1);
      options.onAfterPaint?.(context);
    },
  };
}

/**
 * 默认的离屏画布工厂：优先用 `OffscreenCanvas`，没有就用 `document.createElement`。
 *
 * 两个都没有时返回 undefined——调用方会退化成圆形渐变并给出警告，而不是画错。
 */
function defaultGradientSurfaceFactory(paint: Extract<Paint, { type: "elliptical" }>, size: number): GradientSurface | undefined {
  const scope = globalThis as unknown as {
    OffscreenCanvas?: new (width: number, height: number) => { width: number; height: number; getContext(type: "2d"): CanvasRenderingContext2D | null };
    document?: { createElement(tag: string): HTMLCanvasElement };
  };
  let canvas: { width: number; height: number; getContext(type: "2d"): CanvasRenderingContext2D | null } | undefined;
  if (typeof scope.OffscreenCanvas === "function") {
    canvas = new scope.OffscreenCanvas(size, size);
  } else if (scope.document?.createElement) {
    const element = scope.document.createElement("canvas");
    element.width = size;
    element.height = size;
    canvas = element;
  }
  if (!canvas) return undefined;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  const half = size / 2;
  const gradient = context.createRadialGradient(half, half, 0, half, half, half);
  for (const stop of [...paint.stops].sort((a, b) => a.offset - b.offset)) gradient.addColorStop(stop.offset, stop.color);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return { image: canvas as unknown as CanvasImageSource };
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
  // 混合模式：Canvas 的 globalCompositeOperation 与 CSS 的 mix-blend-mode 不是同一套语义
  // （前者是 Porter-Duff 合成，后者是可分离混合模式）。能对上的直接用；
  // 对不上的（hue / saturation / color / luminosity）退回 normal 并给出警告——
  // 画一个「看起来差不多但其实错」的结果，比说清楚「这里不支持」糟糕得多。
  if (node.blendMode) {
    const composite = canvasCompositeFor(node.blendMode);
    if (composite) context.globalCompositeOperation = composite;
    else options.onWarning?.(`画布不支持混合模式 ${node.blendMode}（节点 ${node.id}），已退回 normal；导出到 HTML/SVG 才是准确的。`);
  }
  // 背景模糊：Canvas 2D 没有 backdrop-filter 的等价物，要做需要离屏合成。
  // 本轮画布侧只提示，不画一个假的模糊。
  if (node.backgroundBlur) {
    options.onWarning?.(`画布暂不支持背景模糊（节点 ${node.id}）：需要离屏合成。导出到 HTML/SVG 才是准确的。`);
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
    drawShape(context, node, options);
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

function drawShape(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions): void {
  const paints = node.paints?.length ? node.paints : node.fill ? [{ type: "solid" as const, color: node.fill }] : [];
  if (paints.length) {
    shapePath(context, node);
    // 从下往上逐层覆盖：数组顺序就是 Figma 的填充层顺序（第 0 层在最底下）。
    paints.forEach((paint, index) => {
      if (paint.type === "elliptical") {
        // 椭圆渐变不能靠 fillStyle 表达（Canvas 只有圆形径向渐变），走离屏贴图。
        paintEllipticalGradient(context, node, paint, options);
      } else {
        context.fillStyle = canvasPaint(context, node, paint);
        context.fill();
      }
      // 阴影只需要投一次：多层填充各投一次会让影子叠得更黑。
      if (index === 0) {
        context.shadowColor = "transparent";
        context.shadowBlur = 0;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
      }
    });
  }
  if (node.stroke && node.strokeWidth > 0) {
    shapePath(context, node);
    context.strokeStyle = node.stroke;
    context.lineWidth = node.strokeWidth;
    context.stroke();
  }
}

/**
 * 椭圆渐变：离屏画一张圆形渐变，按椭圆的外接矩形贴回主画布。
 *
 * 三步：
 * 1. 先用末位色铺满形状——椭圆之外的区域在真实的椭圆渐变里也是末位色，
 *    而且这一次填充顺带把投影投出去；
 * 2. 把形状裁剪起来，避免渐变糊到形状外面；
 * 3. 把离屏的圆形渐变按外接矩形贴回去，非等比缩放后正好是椭圆。
 */
function paintEllipticalGradient(
  context: CanvasRenderingContext2D,
  node: SceneNode,
  paint: Extract<Paint, { type: "elliptical" }>,
  options: PaintOptions,
): void {
  const geometry = ellipticalGeometry(node.box, paint);
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
  const lastColor = stops[stops.length - 1]?.color ?? "#000000";
  shapePath(context, node);
  context.fillStyle = lastColor;
  context.fill();
  // 投影由上面那次填充投出；接下来的贴图不再重复投影。
  context.shadowColor = "transparent";
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;

  const surface = options.gradientSurface?.(paint, options.gradientSize ?? DEFAULT_GRADIENT_SIZE);
  if (!surface) {
    // 没有离屏画布就画不出椭圆：退化成圆形渐变，并明确告知，而不是画一个错的椭圆。
    options.onWarning?.(`画布无法绘制椭圆渐变（节点 ${node.id}）：缺少离屏画布，已退化成圆形渐变。导出到 HTML/SVG 才是准确的。`);
    context.fillStyle = canvasPaint(context, node, { type: "radial", cx: paint.cx, cy: paint.cy, r: 1, stops: paint.stops });
    context.fill();
    return;
  }

  context.save();
  shapePath(context, node);
  context.clip();
  context.drawImage(surface.image, geometry.cx - geometry.rx, geometry.cy - geometry.ry, geometry.rx * 2, geometry.ry * 2);
  context.restore();
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
  context.textAlign = "left";
  const maxLines = Math.max(1, Math.floor(height / Math.max(1, text.lineHeight)));

  if (text.runs?.length) {
    // 富文本：换行与导出共用 design-layout 的布局结果，画布只负责按段上色、按 x 落笔。
    setLetterSpacing(context, 0);
    const lines = layoutRichText({
      text: text.value,
      runs: text.runs,
      fontWeight: text.fontWeight,
      fontStyle: text.fontStyle,
      fontSize: text.fontSize,
      lineHeight: text.lineHeight,
      letterSpacing: text.letterSpacing,
      availableWidth: width,
      measure: (value, style) => {
        context.font = richFont(text, style);
        return context.measureText(value).width;
      },
    });
    // 逐行累加高度：段内大字号会把这一行撑高，不能按固定行高排。
    let lineY = y;
    for (const line of lines) {
      if (lineY >= y + height) break;
      const offset = text.align === "center" ? (width - line.width) / 2 : text.align === "right" ? width - line.width : 0;
      for (const segment of line.segments) {
        context.font = richFont(text, segment.style);
        context.fillStyle = segment.style.color ?? text.color;
        const lineX = x + offset + segment.x;
        if (!text.letterSpacing) {
          context.fillText(segment.text, lineX, lineY);
          continue;
        }
        // 有字距时逐字落笔：x 偏移已经按「字符宽度 + 字距」累加过，整段绘制会重复加一次。
        let cursor = lineX;
        for (const character of Array.from(segment.text)) {
          context.fillText(character, cursor, lineY);
          cursor += context.measureText(character).width + text.letterSpacing;
        }
      }
      lineY += line.height;
    }
    return;
  }

  context.textAlign = text.align === "center" ? "center" : text.align === "right" ? "right" : "left";
  context.font = `${text.fontStyle} ${text.fontWeight} ${text.fontSize}px ${quoteFamily(text.fontFamily)}`;
  setLetterSpacing(context, text.letterSpacing);

  const originX = text.align === "center" ? x + width / 2 : text.align === "right" ? x + width : x;
  const lines = wrapText(context, text.value, width);
  for (let index = 0; index < Math.min(lines.length, maxLines); index += 1) {
    context.fillText(lines[index]!, originX, y + index * text.lineHeight);
  }
  setLetterSpacing(context, 0);
}

/** 段内样式的 CSS font 简写（字号来自段内覆盖）；字体族仍走同一套回退栈。 */
function richFont(text: NonNullable<SceneNode["text"]>, style: RichTextStyle): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}px ${quoteFamily(text.fontFamily)}`;
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
  if (paint.type === "linear") {
    const line = gradientLine(node.box, paint.angle);
    const gradient = context.createLinearGradient(line.x1, line.y1, line.x2, line.y2);
    for (const stop of [...paint.stops].sort((a, b) => a.offset - b.offset)) gradient.addColorStop(stop.offset, stop.color);
    return gradient;
  }
  if (paint.type === "radial") {
    const radial = radialGeometry(node.box, paint);
    // 内外圆同心、内半径 0：色标从中心一圈圈扩散出去。
    const gradient = context.createRadialGradient(radial.cx, radial.cy, 0, radial.cx, radial.cy, radial.r);
    for (const stop of [...paint.stops].sort((a, b) => a.offset - b.offset)) gradient.addColorStop(stop.offset, stop.color);
    return gradient;
  }
  // 椭圆渐变走不到这里：它需要离屏合成，由 paintEllipticalGradient 处理。
  // 真走到了就退回末位色——画错一个形状比少一个效果更容易被忽略。
  return [...paint.stops].sort((a, b) => a.offset - b.offset).at(-1)?.color ?? "#000000";
}