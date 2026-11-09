import { computePageLayout } from "@ufira/design-layout";
import type { DesignDocument } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { loadAssetUrl } from "./asset-url";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./canvas-zoom";
import { createCanvas2DRenderer } from "./renderer/canvas-renderer";
import { buildScene, type SceneNode } from "./renderer/scene";

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
