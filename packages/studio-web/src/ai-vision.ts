import { computePageLayout } from "@ufira/design-layout";
import type { DesignDocument, NodeId } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { loadAssetUrl } from "./asset-url";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./canvas-zoom";
import { createCanvas2DRenderer } from "./renderer/canvas-renderer";
import { buildNode, buildScene, type SceneBox, type SceneNode } from "./renderer/scene";

/**
 * 给模型看的页面截图。
 *
 * ## 为什么自己渲染，不用导出 HTML 再截图
 *
 * 工作台的画布已经是 Canvas 2D 渲染的（见 `renderer/canvas-renderer.ts`）。
 * 用**同一套渲染器**离屏画一遍，模型看到的就是用户看到的——包括混合模式、
 * 背景模糊、蒙版这些只有画布才有的效果。走「导出 HTML → 浏览器截图」那条路
 * 会得到另一套渲染结果，模型照着那张图提建议，改出来的却不是它看到的东西。
 *
 * ## 三种范围
 *
 * - **当前页**（`capturePageScreenshot`）：整页画板。
 * - **当前选区**（`captureSelectionScreenshot`）：只画选中的节点，相机对准它们的
 *   包围盒——用户问「这个按钮怎么样」时，整页截图里的按钮可能小到看不清。
 * - **多页拼接**（`capturePagesScreenshot`）：把若干页横向拼成一张图，模型能看出
 *   流程的先后与页面之间的呼应。
 *
 * ## 尺寸
 *
 * 画布是固定尺寸的画板（`CANVAS_WIDTH × CANVAS_HEIGHT`），直接按它渲染。
 * 输出图片按 `maxSize` 缩放：太大既费 token，模型也看不清细节；太小则文字
 * 全糊了。两头都不能走极端。
 *
 * ## 图片资源
 *
 * 图片节点要真的画出来，否则模型看到的是空框——它会以为「这里应该放张图」。
 * 加载不到的图就画占位框（渲染器本来就这么做），不让整张截图失败。
 */

export interface PageScreenshotOptions {
  document: DesignDocument;
  pageId: string;
  repository: ProjectRepository;
  projectId: string;
  /** 输出图片的最长边（像素），默认 1200。 */
  maxSize?: number;
  /** 单张图片资源的加载超时（毫秒），默认 3000。 */
  imageTimeoutMs?: number;
}

export interface PageScreenshot {
  /** 完整的 data URL：`data:image/png;base64,...`。 */
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
}

export const DEFAULT_SCREENSHOT_MAX_SIZE = 1200;

/** 拼页时两页之间的间隔（像素）。 */
const PAGE_GAP = 16;

/** 每页上方留给页名的标题条高度（像素）。 */
const PAGE_LABEL_HEIGHT = 22;

/**
 * 渲染当前页面并截图。
 *
 * 没有 DOM（Node 里的测试）时返回 undefined——调用方据此退回到「不带图」的
 * 模式，而不是报错。
 */
export async function capturePageScreenshot(options: PageScreenshotOptions): Promise<PageScreenshot | undefined> {
  const scope = globalThis as unknown as {
    document?: { createElement(tag: string): HTMLCanvasElement };
    Image?: new () => HTMLImageElement;
  };
  if (!scope.document?.createElement || !scope.Image) return undefined;

  const boxes = computePageLayout(options.document, options.pageId, {
    viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
  }).boxes;
  const scene = buildScene(options.document, options.pageId, boxes);
  if (!scene.length) return undefined;

  const images = await loadSceneImages(scene, options);
  const canvas = scope.document.createElement("canvas");
  const renderer = createCanvas2DRenderer(canvas);
  renderer.paint(scene, {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    zoom: 1,
    devicePixelRatio: 1,
    images,
    background: "#ffffff",
  });

  const output = scaleDown(canvas, options.maxSize ?? DEFAULT_SCREENSHOT_MAX_SIZE);
  const dataUrl = output.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png")) return undefined;
  return {
    dataUrl,
    mimeType: "image/png",
    width: output.width,
    height: output.height,
  };
}

/**
 * 只截选中的节点。
 *
 * 用户问「这个按钮怎么样」时，整页截图里的按钮可能小到看不清——截选区把相机
 * 对准选中的包围盒，细节才看得见。
 *
 * 选区必须在当前页上；不属于当前页的选中节点会被忽略。选区为空（或全在别的页）
 * 时返回 undefined，调用方退回整页截图。
 */
export async function captureSelectionScreenshot(
  options: PageScreenshotOptions & { nodeIds: readonly NodeId[] },
): Promise<PageScreenshot | undefined> {
  const scope = globalThis as unknown as {
    document?: { createElement(tag: string): HTMLCanvasElement };
    Image?: new () => HTMLImageElement;
  };
  if (!scope.document?.createElement || !scope.Image) return undefined;

  const boxes = computePageLayout(options.document, options.pageId, {
    viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
  }).boxes;
  // 只取当前页的顶层节点作为选区根：选区本来就是页面上的顶层对象。
  const pageChildIds = new Set(options.document.pages[options.pageId]?.childIds ?? []);
  const roots = options.nodeIds
    .filter(id => pageChildIds.has(id))
    .map(id => buildNode(options.document, options.document.nodes[id], boxes))
    .filter((node): node is SceneNode => Boolean(node));
  if (!roots.length) return undefined;

  const bounds = sceneBounds(roots);
  if (!bounds) return undefined;
  // 把选区平移到原点，相机对准它。
  translateScene(roots, -bounds.x, -bounds.y);

  const images = await loadSceneImages(roots, options);
  const canvas = scope.document.createElement("canvas");
  const renderer = createCanvas2DRenderer(canvas);
  renderer.paint(roots, {
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
    zoom: 1,
    devicePixelRatio: 1,
    images,
    background: "#ffffff",
  });

  const output = scaleDown(canvas, options.maxSize ?? DEFAULT_SCREENSHOT_MAX_SIZE);
  const dataUrl = output.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png")) return undefined;
  return { dataUrl, mimeType: "image/png", width: output.width, height: output.height };
}

/**
 * 把若干页横向拼成一张图。
 *
 * 每页各自按内容包围盒渲染，再按**统一比例**缩放后拼接——比例必须一致，否则
 * 模型会以为「后一页的按钮天生更大」。
 *
 * 每页上方有一条标题带写页名：模型看到的是一张长图，不写页名它分不清哪块是哪页。
 */
export async function capturePagesScreenshot(
  options: PageScreenshotOptions & { pageIds: readonly string[] },
): Promise<PageScreenshot | undefined> {
  const scope = globalThis as unknown as {
    document?: { createElement(tag: string): HTMLCanvasElement };
    Image?: new () => HTMLImageElement;
  };
  if (!scope.document?.createElement || !scope.Image) return undefined;

  const pages = options.pageIds
    .map(pageId => {
      const page = options.document.pages[pageId];
      if (!page) return undefined;
      const boxes = computePageLayout(options.document, pageId, {
        viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      }).boxes;
      const scene = buildScene(options.document, pageId, boxes);
      const bounds = sceneBounds(scene);
      if (!bounds) return undefined;
      translateScene(scene, -bounds.x, -bounds.y);
      return { pageId, name: page.name, scene, bounds };
    })
    .filter((page): page is { pageId: string; name: string; scene: SceneNode[]; bounds: SceneBox } => Boolean(page));
  if (!pages.length) return undefined;

  // 统一比例：先按 1:1 算出总宽，再按 maxSize 缩。
  const contentWidth = pages.reduce((sum, page) => sum + page.bounds.width, 0);
  const totalWidth = contentWidth + PAGE_GAP * (pages.length + 1);
  const maxSize = options.maxSize ?? DEFAULT_SCREENSHOT_MAX_SIZE;
  const scale = totalWidth > maxSize ? maxSize / totalWidth : 1;

  const images = await loadSceneImages(pages.flatMap(page => page.scene), options);
  const canvas = scope.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(totalWidth * scale));
  const contentHeight = Math.max(...pages.map(page => page.bounds.height));
  canvas.height = Math.max(1, Math.round((contentHeight + PAGE_LABEL_HEIGHT) * scale));
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  // 每页单独渲染到离屏画布，再贴到拼接画布上——直接画到拼接画布会串页。
  let cursor = PAGE_GAP;
  for (const page of pages) {
    const tile = scope.document!.createElement("canvas");
    tile.width = Math.max(1, Math.round(page.bounds.width * scale));
    tile.height = Math.max(1, Math.round(page.bounds.height * scale));
    const renderer = createCanvas2DRenderer(tile);
    renderer.paint(page.scene, {
      width: page.bounds.width,
      height: page.bounds.height,
      zoom: scale,
      devicePixelRatio: 1,
      images,
      background: "#ffffff",
    });

    const x = Math.round(cursor * scale);
    const y = Math.round(PAGE_LABEL_HEIGHT * scale);
    // 页名：模型看到的是一张长图，不写页名它分不清哪块是哪页。
    context.fillStyle = "#111111";
    context.font = `${Math.max(9, Math.round(12 * scale))}px sans-serif`;
    context.fillText(page.name, x, Math.max(9, Math.round(14 * scale)));
    context.drawImage(tile, x, y);
    cursor += page.bounds.width + PAGE_GAP;
  }

  const output = scaleDown(canvas, maxSize);
  const dataUrl = output.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png")) return undefined;
  return { dataUrl, mimeType: "image/png", width: output.width, height: output.height };
}

/**
 * 场景里所有节点的包围盒。
 *
 * 只算根节点：子节点被父节点裁剪（`clip`），算进去会让包围盒比实际看到的还大。
 */
function sceneBounds(scene: SceneNode[]): SceneBox | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of scene) {
    minX = Math.min(minX, node.box.x);
    minY = Math.min(minY, node.box.y);
    maxX = Math.max(maxX, node.box.x + node.box.width);
    maxY = Math.max(maxY, node.box.y + node.box.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * 整体平移场景。
 *
 * 渲染器把场景坐标直接当画布坐标画，所以「相机对准某块区域」就是「把那块区域
 * 平移到原点」。不改渲染器、不加偏移参数——那样会牵动画布、导出、命中测试每一处。
 */
function translateScene(scene: SceneNode[], dx: number, dy: number): void {
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      node.box = { ...node.box, x: node.box.x + dx, y: node.box.y + dy };
      walk(node.children);
    }
  };
  walk(scene);
}

/**
 * 超过上限就等比缩小。
 *
 * 画布本身是固定的 960×680，一般不会超限；但用户可以把 `maxSize` 调到更小来省
 * token。缩放用离屏 canvas 重绘而不是改 CSS 尺寸——截图是从位图取的，改 CSS
 * 尺寸不会真的把像素变少。
 */
function scaleDown(canvas: HTMLCanvasElement, maxSize: number): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height);
  if (maxSize <= 0 || longest <= maxSize) return canvas;
  const scope = globalThis as unknown as { document?: { createElement(tag: string): HTMLCanvasElement } };
  if (!scope.document?.createElement) return canvas;
  const scale = maxSize / longest;
  const scaled = scope.document.createElement("canvas");
  scaled.width = Math.max(1, Math.round(canvas.width * scale));
  scaled.height = Math.max(1, Math.round(canvas.height * scale));
  const context = scaled.getContext("2d");
  if (!context) return canvas;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled;
}

/** 把场景里用到的图片资源加载成可绘制对象；加载不到的跳过。 */
async function loadSceneImages(scene: SceneNode[], options: PageScreenshotOptions): Promise<Map<string, CanvasImageSource>> {
  const images = new Map<string, CanvasImageSource>();
  const assetIds = collectAssetIds(scene);
  if (!assetIds.length) return images;

  const scope = globalThis as unknown as { Image?: new () => HTMLImageElement };
  const timeoutMs = options.imageTimeoutMs ?? 3000;
  await Promise.all(assetIds.map(async assetId => {
    const asset = options.document.assets[assetId];
    if (!asset) return;
    try {
      const url = await withTimeout(loadAssetUrl(options.repository, options.projectId, asset), timeoutMs);
      if (!url) return;
      const image = new scope.Image!();
      image.src = url;
      await withTimeout(image.decode(), timeoutMs);
      if (image.naturalWidth > 0) images.set(assetId, image);
    } catch {
      // 加载不到就画占位框——整张截图不该因为一张图失败。
    }
  }));
  return images;
}

/** 场景里所有图片节点的 assetId（去重）。 */
function collectAssetIds(scene: SceneNode[]): string[] {
  const ids = new Set<string>();
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      if (node.image) ids.add(node.image.assetId);
      walk(node.children);
    }
  };
  walk(scene);
  return [...ids];
}

/** 给 promise 加超时；超时按「没有结果」处理。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
