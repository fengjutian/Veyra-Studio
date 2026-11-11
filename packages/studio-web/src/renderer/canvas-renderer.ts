import { absolutePath, canvasCompositeFor, colorAlpha, ellipticalGeometry, gradientLine, radialGeometry, LIST_MARKER_GAP, type CornerRadii, type Paint, type PathCommand, type ShadowSpec } from "@ufira/design-schema";
import { layoutRichText, type RichTextStyle } from "@ufira/design-layout";
import { rotatedBounds, toRadians } from "./rotation";
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
  /** 画布表达不了或降级了的能力在这里提示。 */
  onWarning?(message: string): void;
  /** 离屏画布工厂：分组混合、背景模糊、椭圆渐变都要用。 */
  surface?: SurfaceFactory;
  /** 椭圆渐变的离屏底图（已经画好圆形渐变）；由渲染器按 `surface` 生成。 */
  gradientSurface?(paint: Extract<Paint, { type: "elliptical" }>, size: number): Surface | undefined;
  /** 椭圆渐变离屏画布的边长（px）。 */
  gradientSize?: number;
}

/**
 * 离屏画布。
 *
 * 三件事都要用它：混合模式的**分组合成**（整个图层组先画在离屏上再整体混合）、
 * 背景模糊的**背景快照**、椭圆渐变的**圆形渐变底图**。
 */
export interface Surface {
  /** 贴回主画布的位图。 */
  canvas: CanvasImageSource;
  /** 在这张离屏画布上继续画。 */
  context: CanvasRenderingContext2D;
  /** 离屏画布的像素尺寸。 */
  width: number;
  height: number;
}

/** 离屏画布工厂：按**设备像素**尺寸建一张空白画布。 */
export type SurfaceFactory = (width: number, height: number) => Surface | undefined;

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
  // 椭圆渐变的离屏底图按色标缓存：同一个渐变不需要每帧重画一遍。
  const gradients = new Map<string, Surface>();

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
        surface: options.surface ?? defaultSurfaceFactory,
        gradientSurface: (paint, size) => {
          const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
          const key = `${size}|${stops.map(stop => `${stop.offset}:${stop.color}`).join(",")}`;
          const cached = gradients.get(key);
          if (cached) return cached;
          const surface = (options.surface ?? defaultSurfaceFactory)(size, size);
          if (!surface) return undefined;
          // Canvas 的径向渐变只能画正圆：先在离屏上画一个正圆，贴回时再非等比缩放成椭圆。
          const half = size / 2;
          const gradient = surface.context.createRadialGradient(half, half, 0, half, half, half);
          for (const stop of stops) gradient.addColorStop(stop.offset, stop.color);
          surface.context.fillStyle = gradient;
          surface.context.fillRect(0, 0, size, size);
          gradients.set(key, surface);
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
 * 两个都没有时返回 undefined——调用方会退化并给出警告，而不是画错。
 */
function defaultSurfaceFactory(width: number, height: number): Surface | undefined {
  const scope = globalThis as unknown as {
    OffscreenCanvas?: new (width: number, height: number) => { width: number; height: number; getContext(type: "2d"): CanvasRenderingContext2D | null };
    document?: { createElement(tag: string): HTMLCanvasElement };
  };
  let canvas: { width: number; height: number; getContext(type: "2d"): CanvasRenderingContext2D | null } | undefined;
  if (typeof scope.OffscreenCanvas === "function") {
    canvas = new scope.OffscreenCanvas(width, height);
  } else if (scope.document?.createElement) {
    const element = scope.document.createElement("canvas");
    element.width = width;
    element.height = height;
    canvas = element;
  }
  if (!canvas) return undefined;
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  return { canvas: canvas as unknown as CanvasImageSource, context, width, height };
}

/** 画布的设备像素缩放：离屏画布的尺寸按它换算。 */
function paintScale(options: PaintOptions): number {
  return Math.max(0.01, options.zoom) * Math.max(1, options.devicePixelRatio);
}

/**
 * 绘制一个节点。
 *
 * 这里只做三件事的**调度**：可见性判断、背景模糊（作用在节点后面的内容上，
 * 必须先做）、以及图层组效果（图层模糊与混合模式都要「整棵子树离屏合成」）。
 * 真正的绘制在 {@link drawNodeContent}。
 */
function drawNode(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions, inheritedOpacity: number): void {
  if (node.box.width <= 0 || node.box.height <= 0) return;
  const opacity = clamp(inheritedOpacity * node.opacity, 0, 1);
  if (opacity <= 0) return;

  // 背景模糊先做：它模糊的是「节点后面的内容」，必须发生在节点自己画上去之前。
  if (node.backgroundBlur) paintBackgroundBlur(context, node, options);

  const composite = canvasCompositeFor(node.blendMode);
  // 图层模糊与混合模式都是**图层组**级别的效果：节点和它的整棵子树作为一个整体
  // 离屏合成，再整体模糊 / 整体与背景混合（与 Figma 一致）。
  if (composite || node.blur) {
    drawLayerGroup(context, node, options, inheritedOpacity, composite, node.blur ?? 0);
    return;
  }
  drawNodeContent(context, node, options, inheritedOpacity);
}

/**
 * 图层组合成：整棵子树先画进离屏，再按需要模糊 / 与背景混合。
 *
 * Canvas 的 `globalCompositeOperation` 与 `filter` 都是**就地**的：没有
 * 「一个图层组整体参与」的概念。Figma 的语义要靠离屏合成才能对上——混合模式与
 * 图层模糊共用这一套机制。
 *
 * 图层模糊模糊的是**整棵子树**（与 SVG 的 `<g filter>`、HTML 的 `filter: blur()`
 * 同一套语义）；之前画布只模糊节点自身，三端对不上。
 */
function drawLayerGroup(
  context: CanvasRenderingContext2D,
  node: SceneNode,
  options: PaintOptions,
  inheritedOpacity: number,
  composite: NonNullable<ReturnType<typeof canvasCompositeFor>> | undefined,
  blur: number,
): void {
  const scale = paintScale(options);
  const bounds = subtreeBounds(node);
  const surface = createSurface(options, Math.max(1, Math.ceil(bounds.width * scale)), Math.max(1, Math.ceil(bounds.height * scale)));
  if (!surface) {
    // 没有离屏画布：只能退回「就地」的近似——父层与子层不再作为整组参与。
    // 这种降级必须说清楚，不能悄悄发生。
    options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：图层效果退化为就地绘制，图层组不再整体参与。`);
    context.save();
    if (composite) context.globalCompositeOperation = composite;
    drawNodeContent(context, node, options, inheritedOpacity);
    context.restore();
    return;
  }
  // 离屏层的坐标系与主画布一致（同样的缩放），只是平移到包围盒的原点。
  surface.context.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
  drawNodeContent(surface.context, node, options, inheritedOpacity);

  let layer = surface;
  if (blur > 0) {
    const blurred = createSurface(options, surface.width, surface.height);
    if (!blurred) {
      options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：图层模糊已跳过。`);
    } else {
      // 滤镜长度按设备像素算，模糊半径才不会随缩放漂移（与背景模糊同一套约定）。
      blurred.context.setTransform(1, 0, 0, 1, 0, 0);
      blurred.context.filter = `blur(${blur * scale}px)`;
      blurred.context.drawImage(surface.canvas, 0, 0);
      blurred.context.filter = "none";
      layer = blurred;
    }
  }

  context.save();
  if (composite) context.globalCompositeOperation = composite;
  context.drawImage(layer.canvas, bounds.x, bounds.y, bounds.width, bounds.height);
  context.restore();
}

/** 节点 + 子树的包围盒（含阴影与图层模糊的溢出余量）。 */
function subtreeBounds(node: SceneNode): SceneBox {
  // 旋转过的节点要用旋转后的轴对齐包围盒，否则离屏层会把转出去的部分裁掉。
  const own = node.rotation ? rotatedBounds(node.box, toRadians(node.rotation)) : node.box;
  let minX = own.x;
  let minY = own.y;
  let maxX = own.x + own.width;
  let maxY = own.y + own.height;
  for (const child of node.children) {
    // 蒙版自身不绘制，不占包围盒。
    if (child.mask) continue;
    const bounds = subtreeBounds(child);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  const padding = effectPadding(node);
  return { x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 };
}

/** 阴影与图层模糊会溢出盒子，离屏合成时要多留这些像素。 */
function effectPadding(node: SceneNode): number {
  // 扩散半径也会把阴影撑出盒子，合成时同样要留出余量。
  const shadow = node.shadow
    ? node.shadow.blur + Math.abs(node.shadow.spread ?? 0) + Math.max(Math.abs(node.shadow.x), Math.abs(node.shadow.y))
    : 0;
  const blur = node.blur ? node.blur * 3 : 0;
  return shadow + blur;
}

/** 建一张离屏画布；工厂不可用时返回 undefined（调用方负责退化并给出警告）。 */
function createSurface(options: PaintOptions, width: number, height: number): Surface | undefined {
  return options.surface?.(width, height);
}

/**
 * 背景模糊：把「节点后面已经画好的内容」局部模糊后贴回来。
 *
 * Canvas 没有 `backdrop-filter`，但背景模糊本质就是「对已画好的内容做一次
 * 局部模糊」：
 * 1. 按节点区域（外扩模糊半径的余量，模糊会把区域外的像素带进来）从主画布快照；
 * 2. 在离屏画布上用 `filter: blur()` 模糊——离屏的坐标空间就是设备像素，
 *    半径换算成设备像素后不会随缩放漂移；
 * 3. 贴回主画布，并按节点自身形状裁剪：形状之外保持清晰，与 Figma 一致。
 *
 * 裁剪区域在 `clip()` 调用时就固化成设备空间，所以随后的变换不影响它。
 */
function paintBackgroundBlur(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions): void {
  const radius = node.backgroundBlur ?? 0;
  if (radius <= 0) return;
  if (!("filter" in context)) {
    options.onWarning?.(`画布不支持模糊滤镜（节点 ${node.id}）：背景模糊已跳过。`);
    return;
  }
  const source = context.canvas;
  if (!source) return;
  const scale = paintScale(options);
  const padding = radius * 2;
  const box = { x: node.box.x - padding, y: node.box.y - padding, width: node.box.width + padding * 2, height: node.box.height + padding * 2 };
  const width = Math.max(1, Math.ceil(box.width * scale));
  const height = Math.max(1, Math.ceil(box.height * scale));
  const surface = createSurface(options, width, height);
  if (!surface) {
    options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：背景模糊已跳过。`);
    return;
  }
  try {
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.filter = `blur(${radius * scale}px)`;
    surface.context.drawImage(source, box.x * scale, box.y * scale, box.width * scale, box.height * scale, 0, 0, width, height);
    surface.context.filter = "none";
  } catch {
    // 跨域图片会污染画布，读取像素会抛 SecurityError。
    options.onWarning?.(`背景模糊失败（节点 ${node.id}）：画布被跨域资源污染，无法读取像素。`);
    return;
  }
  context.save();
  // 裁剪形状要和节点自身的旋转一致——否则旋转过的节点会裁出一个歪的遮罩。
  if (node.rotation) {
    const centerX = node.box.x + node.box.width / 2;
    const centerY = node.box.y + node.box.height / 2;
    context.translate(centerX, centerY);
    context.rotate(toRadians(node.rotation));
    context.translate(-centerX, -centerY);
  }
  shapePath(context, node);
  context.clip();
  context.drawImage(surface.canvas, box.x, box.y, box.width, box.height);
  context.restore();
}

/** 实际绘制一个节点：自身 + 子树。混合模式、图层模糊与背景模糊由 {@link drawNode} 调度。 */
function drawNodeContent(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions, inheritedOpacity: number): void {
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

  // 阴影分两种画法：Canvas 的 `shadow*` 能直接画的走快速路径，
  // 扩散半径与内阴影画不出来，走离屏合成（语义与 CSS `box-shadow` 对齐）。
  const shadow = node.shadow;
  const manual = shadow && needsManualShadow(shadow) ? shadow : undefined;
  if (shadow && !manual) {
    context.shadowColor = shadow.color;
    context.shadowBlur = shadow.blur;
    context.shadowOffsetX = shadow.x;
    context.shadowOffsetY = shadow.y;
  }

  // 旋转绕节点中心；子树画在同一个上下文里，因此自动继承父级的旋转。
  if (node.rotation) {
    const centerX = node.box.x + node.box.width / 2;
    const centerY = node.box.y + node.box.height / 2;
    context.translate(centerX, centerY);
    context.rotate((node.rotation * Math.PI) / 180);
    context.translate(-centerX, -centerY);
  }

  // 投影画在内容下面。
  if (manual && manual.type !== "inner") paintManualDropShadow(context, node, options, manual);

  // 背景阶段：形状的填充。
  if (!node.text && !node.image) drawShapeFill(context, node, options);

  // 内阴影画在填充之上、内容之下——与 CSS `box-shadow: inset` 的层序一致。
  if (manual && manual.type === "inner") paintManualInnerShadow(context, node, options, manual);

  // 前景阶段：描边、文字、图片。
  if (node.text) {
    drawText(context, node, opacity);
  } else if (node.image) {
    drawImage(context, node, options);
  } else {
    drawShapeStroke(context, node);
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
        // 软蒙版（半透明 / 羽化）要靠离屏合成，`clip()` 做不到。
        if (masks.some(isSoftMask)) {
          drawSoftMaskedChild(context, child, masks, options, opacity);
          continue;
        }
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

/**
 * 这个阴影能不能用 Canvas 的 `shadow*` 直接画。
 *
 * 不能的两种情况：扩散半径（`shadow*` 没有这个概念）与内阴影
 * （`shadow*` 只会把影子投到形状外面）。
 */
function needsManualShadow(shadow: ShadowSpec): boolean {
  return shadow.type === "inner" || Boolean(shadow.spread);
}

/**
 * 带扩散半径的投影：离屏合成。
 *
 * Canvas 的 `shadow*` 没有扩散半径，只能自己拼：形状先沿轮廓向外膨胀
 * （描一条 2×spread 宽的圆角边），再整张模糊，最后按偏移贴回内容下面。
 *
 * 离屏层用**设备像素**坐标：滤镜长度按设备像素算，模糊半径才不会随缩放漂移。
 */
function paintManualDropShadow(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions, shadow: ShadowSpec): void {
  const scale = paintScale(options);
  const spread = shadow.spread ?? 0;
  const padding = Math.abs(spread) + shadow.blur * 3 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y));
  const originX = node.box.x - padding;
  const originY = node.box.y - padding;
  const width = node.box.width + padding * 2;
  const height = node.box.height + padding * 2;
  const surface = createSurface(options, Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
  if (!surface) {
    options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：带扩散半径的投影已跳过。`);
    return;
  }
  const device = deviceNode(node, originX, originY, scale);
  surface.context.setTransform(1, 0, 0, 1, 0, 0);
  surface.context.fillStyle = shadow.color;
  shapePath(surface.context, device);
  surface.context.fill();
  if (spread > 0) {
    // 向外膨胀：沿轮廓描一条 2×spread 宽的边（圆角连接，与 CSS 的膨胀一致）。
    surface.context.strokeStyle = shadow.color;
    surface.context.lineJoin = "round";
    surface.context.lineWidth = spread * 2 * scale;
    surface.context.stroke();
  } else if (spread < 0) {
    // 向内收缩：把多出来的部分擦掉。
    surface.context.globalCompositeOperation = "destination-out";
    surface.context.strokeStyle = "#000000";
    surface.context.lineJoin = "round";
    surface.context.lineWidth = -spread * 2 * scale;
    surface.context.stroke();
    surface.context.globalCompositeOperation = "source-over";
  }
  // 模糊：整张投射物一起模糊——分两次模糊会让重叠处更深。
  const blurred = createSurface(options, surface.width, surface.height);
  if (!blurred) {
    options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：带扩散半径的投影已跳过。`);
    return;
  }
  blurred.context.setTransform(1, 0, 0, 1, 0, 0);
  blurred.context.filter = `blur(${shadow.blur * scale}px)`;
  blurred.context.drawImage(surface.canvas, 0, 0);
  blurred.context.filter = "none";
  // 偏移只挪位置，不改模糊（与 CSS 一样：先模糊再偏移）。
  context.drawImage(blurred.canvas, originX + shadow.x, originY + shadow.y, width, height);
}

/**
 * 内阴影：离屏合成。
 *
 * 语义与 CSS `box-shadow: inset` 一致：形状减去「模糊并偏移后的自己」，
 * 剩下的区域就是内阴影——因此偏移方向与投影相反。
 */
function paintManualInnerShadow(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions, shadow: ShadowSpec): void {
  const scale = paintScale(options);
  const spread = shadow.spread ?? 0;
  const width = node.box.width;
  const height = node.box.height;
  const surface = createSurface(options, Math.max(1, Math.ceil(width * scale)), Math.max(1, Math.ceil(height * scale)));
  if (!surface) {
    options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：内阴影已跳过。`);
    return;
  }
  const device = deviceNode(node, node.box.x, node.box.y, scale);
  surface.context.setTransform(1, 0, 0, 1, 0, 0);
  // 1) 铺满阴影色。
  surface.context.fillStyle = shadow.color;
  shapePath(surface.context, device);
  surface.context.fill();

  // 2) 挖掉「模糊并偏移后的自己」。扩散半径为正时，挖掉的是**收缩**后的形状
  //    （CSS 的内阴影扩散是向内收的）。
  let hole = surface;
  if (spread > 0) {
    const eroded = createSurface(options, surface.width, surface.height);
    if (!eroded) {
      options.onWarning?.(`画布无法为节点 ${node.id} 创建离屏画布：内阴影的扩散半径已忽略。`);
    } else {
      eroded.context.setTransform(1, 0, 0, 1, 0, 0);
      eroded.context.fillStyle = "#000000";
      shapePath(eroded.context, device);
      eroded.context.fill();
      eroded.context.globalCompositeOperation = "destination-out";
      eroded.context.strokeStyle = "#000000";
      eroded.context.lineJoin = "round";
      eroded.context.lineWidth = spread * 2 * scale;
      eroded.context.stroke();
      eroded.context.globalCompositeOperation = "source-over";
      hole = eroded;
    }
  }
  surface.context.globalCompositeOperation = "destination-out";
  surface.context.filter = `blur(${shadow.blur * scale}px)`;
  surface.context.translate(shadow.x * scale, shadow.y * scale);
  if (hole === surface) {
    shapePath(surface.context, device);
    surface.context.fill();
  } else {
    surface.context.drawImage(hole.canvas, 0, 0);
  }
  surface.context.filter = "none";
  surface.context.globalCompositeOperation = "source-over";

  // 3) 贴回：裁到形状内部（内阴影不会跑到形状外面）。
  context.save();
  shapePath(context, node);
  context.clip();
  context.drawImage(surface.canvas, node.box.x, node.box.y, width, height);
  context.restore();
}

/**
 * 蒙版的不透明度：节点自身透明度 × 第一层实色填充的 alpha。
 *
 * 蒙版的**填充色**不影响裁剪形状（形状由节点类型决定），只有透明度参与裁剪。
 */
function maskAlpha(mask: SceneNode): number {
  const paint = mask.paints?.[0];
  const color = paint?.type === "solid" ? paint.color : mask.fill;
  return mask.opacity * (color ? colorAlpha(color) : 1);
}

/**
 * 软蒙版：半透明或带羽化。
 *
 * 硬蒙版走 `clip()`（与升级前逐字一致）；软蒙版要靠离屏合成才能做出来。
 */
function isSoftMask(mask: SceneNode): boolean {
  return maskAlpha(mask) < 1 || (mask.maskFeather ?? 0) > 0;
}

/**
 * 软蒙版：离屏合成。
 *
 * `clip()` 只能按形状硬裁剪，做不到「半透明裁剪」与「边缘渐隐」——
 * 那需要把被裁剪的内容先画进离屏，再用蒙版的 alpha 做一次 `destination-in`。
 *
 * 多层蒙版是**交集**：后面的蒙版用 `destination-in` 裁掉前面之外的部分。
 */
function drawSoftMaskedChild(
  context: CanvasRenderingContext2D,
  child: SceneNode,
  masks: SceneNode[],
  options: PaintOptions,
  inheritedOpacity: number,
): void {
  const scale = paintScale(options);
  const bounds = subtreeBounds(child);
  const content = createSurface(options, Math.max(1, Math.ceil(bounds.width * scale)), Math.max(1, Math.ceil(bounds.height * scale)));
  if (!content) {
    options.onWarning?.(`画布无法为节点 ${child.id} 创建离屏画布：软蒙版退化为硬裁剪。`);
    drawClippedChild(context, child, masks, options, inheritedOpacity);
    return;
  }
  content.context.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
  drawNode(content.context, child, options, inheritedOpacity);

  const maskLayer = createSurface(options, content.width, content.height);
  if (!maskLayer) {
    options.onWarning?.(`画布无法为节点 ${child.id} 创建离屏画布：软蒙版退化为硬裁剪。`);
    context.drawImage(content.canvas, bounds.x, bounds.y, bounds.width, bounds.height);
    return;
  }
  maskLayer.context.setTransform(scale, 0, 0, scale, -bounds.x * scale, -bounds.y * scale);
  masks.forEach((mask, index) => {
    maskLayer.context.globalCompositeOperation = index === 0 ? "source-over" : "destination-in";
    const alpha = maskAlpha(mask);
    const feather = mask.maskFeather ?? 0;
    // 羽化：蒙版轮廓被模糊，边缘因此渐隐。
    if (feather > 0) maskLayer.context.filter = `blur(${feather * scale}px)`;
    maskLayer.context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    shapePath(maskLayer.context, mask);
    maskLayer.context.fill();
    if (feather > 0) maskLayer.context.filter = "none";
  });
  maskLayer.context.globalCompositeOperation = "source-over";

  // 内容只在蒙版不透明的地方留下。
  content.context.setTransform(1, 0, 0, 1, 0, 0);
  content.context.globalCompositeOperation = "destination-in";
  content.context.drawImage(maskLayer.canvas, 0, 0);
  content.context.globalCompositeOperation = "source-over";
  context.drawImage(content.canvas, bounds.x, bounds.y, bounds.width, bounds.height);
}

/** 硬蒙版：依次 clip（多层叠加即交集）。 */
function drawClippedChild(
  context: CanvasRenderingContext2D,
  child: SceneNode,
  masks: SceneNode[],
  options: PaintOptions,
  inheritedOpacity: number,
): void {
  context.save();
  for (const mask of masks) {
    shapePath(context, mask);
    context.clip();
  }
  drawNode(context, child, options, inheritedOpacity);
  context.restore();
}

/** 设备像素坐标下的节点副本（滤镜与线宽都按设备像素算）。 */
function deviceNode(node: SceneNode, originX: number, originY: number, scale: number): SceneNode {
  return {
    ...node,
    box: {
      x: (node.box.x - originX) * scale,
      y: (node.box.y - originY) * scale,
      width: node.box.width * scale,
      height: node.box.height * scale,
    },
    radius: node.radius * scale,
    ...(node.radii ? { radii: node.radii.map(radius => radius * scale) as CornerRadii } : {}),
  };
}

/** 形状的填充阶段：多层填充从下往上逐层覆盖。 */
function drawShapeFill(context: CanvasRenderingContext2D, node: SceneNode, options: PaintOptions): void {
  const paints = node.paints?.length ? node.paints : node.fill ? [{ type: "solid" as const, color: node.fill }] : [];
  if (!paints.length) return;
  shapePath(context, node);
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

/** 形状的描边阶段。 */
function drawShapeStroke(context: CanvasRenderingContext2D, node: SceneNode): void {
  if (!node.stroke || node.strokeWidth <= 0) return;
  shapePath(context, node);
  context.strokeStyle = node.stroke;
  context.lineWidth = node.strokeWidth;
  context.stroke();
}

/**
 * 椭圆渐变：离屏画一张圆形渐变，贴回时非等比缩放成椭圆（可再旋转）。
 *
 * 三步：
 * 1. 先用末位色铺满形状——椭圆之外的区域在真实的椭圆渐变里也是末位色，
 *    而且这一次填充顺带把投影投出去；
 * 2. 把形状裁剪起来，避免渐变糊到形状外面（裁剪区域此时就固化成设备空间，
 *    随后的旋转与缩放不会影响它）；
 * 3. 把离屏的圆形渐变按外接矩形贴回去，非等比缩放后正好是椭圆；
 *    有旋转角时先绕中心旋转。
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

  const half = surface.width / 2;
  context.save();
  shapePath(context, node);
  context.clip();
  context.translate(geometry.cx, geometry.cy);
  if (paint.angle) context.rotate((paint.angle * Math.PI) / 180);
  // 圆形渐变按椭圆的两个半轴非等比缩放；离屏是正方形，所以要同时除以半径。
  context.scale(geometry.rx / half, geometry.ry / half);
  context.drawImage(surface.canvas, -half, -half, half * 2, half * 2);
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
  context.fillStyle = text.color;
  context.globalAlpha = opacity;
  context.textBaseline = "top";
  context.textAlign = "left";
  const maxLines = Math.max(1, Math.floor(height / Math.max(1, text.lineHeight)));

  if (text.runs?.length || text.paragraphStyles?.length) {
    // 富文本：换行与导出共用 design-layout 的布局结果，画布只负责按段上色、按 x 落笔。
    setLetterSpacing(context, 0);
    const lines = layoutRichText({
      text: text.value,
      runs: text.runs,
      paragraphStyles: text.paragraphStyles,
      fontWeight: text.fontWeight,
      fontStyle: text.fontStyle,
      fontSize: text.fontSize,
      lineHeight: text.lineHeight,
      letterSpacing: text.letterSpacing,
      align: text.align,
      availableWidth: width,
      measure: (value, style) => {
        context.font = richFont(text, style);
        return context.measureText(value).width;
      },
    });
    // 悬挂列表的标记画在文本框**外**：裁剪区必须往左让出标记的宽度，
    // 否则标记会被裁掉（文本本身仍然从框的左边缘开始，不会溢出）。
    let hangingOutside = 0;
    context.font = richFont(text, { fontWeight: text.fontWeight, fontStyle: text.fontStyle, fontSize: text.fontSize });
    for (const line of lines) {
      if (line.hanging && line.marker) {
        hangingOutside = Math.max(hangingOutside, context.measureText(line.marker).width + LIST_MARKER_GAP);
      }
    }
    context.beginPath();
    context.rect(x - hangingOutside, y, width + hangingOutside, height);
    context.clip();
    // 逐行累加高度：段内大字号会把这一行撑高，不能按固定行高排。
    let lineY = y;
    for (const line of lines) {
      if (lineY >= y + height) break;
      // 缩进后的可用宽度：居中/右对齐在剩余空间里算，缩进不参与对齐。
      const contentWidth = Math.max(0, width - line.left);
      const offset = text.align === "center" ? (contentWidth - line.width) / 2 : text.align === "right" ? contentWidth - line.width : 0;
      // 列表标记画在标记区里，右边缘停在正文左侧一个间隙处——
      // 编号位数不同（1. / 10. / iv.）时右对齐才不会参差不齐。
      if (line.marker) {
        context.font = richFont(text, { fontWeight: text.fontWeight, fontStyle: text.fontStyle, fontSize: text.fontSize });
        context.fillStyle = text.color;
        context.textAlign = "right";
        // 悬挂列表：标记悬在框外（框的左边界之外）；普通列表：标记在正文左侧的标记区里。
        const markerX = line.hanging ? x - LIST_MARKER_GAP : x + line.left - LIST_MARKER_GAP;
        context.fillText(line.marker, markerX, lineY);
        context.textAlign = "left";
      }
      for (const segment of line.segments) {
        context.font = richFont(text, segment.style);
        context.fillStyle = segment.style.color ?? text.color;
        const lineX = x + line.left + offset + segment.x;
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

  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
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