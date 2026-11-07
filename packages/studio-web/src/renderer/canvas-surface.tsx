import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignDocument, AssetMetadata, PathCommand } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { loadAssetUrl } from "../asset-url";
import { buildScene, type SceneBox, type SceneNode } from "./scene";
import { cullScene, type CullViewport } from "./culling";
import { paintDrawPreview, paintMarquee, paintPathAnchors, paintPathPreview, paintSelectionOverlay, paintSnapGuides } from "./selection-overlay";
import type { SnapGuide } from "./snapping";
import { selectedBoxes, selectionBounds, type Rect } from "./selection";
import { applyBoxOverrides } from "./selection-drag";
import { createCanvas2DRenderer, type SceneRenderer } from "./canvas-renderer";

/**
 * Canvas 画布层。
 *
 * 只负责"画"：命中、选择、拖拽都由 Canvas 命中测试与指针手势接管，文本编辑是盖在
 * 节点位置上的 DOM overlay（tldraw 同样做法）。画布上不再保留 DOM 节点副本。
 */
export interface CanvasSurfaceProps {
  repository: ProjectRepository;
  projectId: string;
  document: DesignDocument;
  pageId: string;
  boxes: Record<string, SceneBox | undefined>;
  width: number;
  height: number;
  zoom: number;
  /** 画布可视区域（场景坐标）；不传则整页绘制。 */
  viewport?: CullViewport;
  /** 需要绘制选择框的节点 id；不传则不画。 */
  selection?: string[];
  /** 拖拽/缩放过程中的临时盒子（拖动预览）。 */
  previewBoxes?: Record<string, SceneBox>;
  /** 框选矩形（场景坐标）。 */
  marquee?: Rect;
  /** 绘制中的临时矩形（场景坐标）与它的形状。 */
  drawRect?: Rect;
  drawShape?: "rectangle" | "ellipse" | "frame" | "text" | "line" | "polygon" | "star";
  /** 钢笔草稿：绝对场景坐标的路径与已落下的锚点。 */
  penPath?: PathCommand[];
  penAnchors?: Array<{ x: number; y: number }>;
  /** 指针停在起点上，提示「点击会闭合」。 */
  penClosing?: boolean;
  /** 拖动时的对齐辅助线。 */
  guides?: SnapGuide[];
}

export function CanvasSurface({ repository, projectId, document, pageId, boxes, width, height, zoom, viewport, selection, previewBoxes, marquee, drawRect, drawShape, penPath, penAnchors, penClosing, guides }: CanvasSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);
  const [images, setImages] = useState<Map<string, CanvasImageSource>>(() => new Map());
  const scene = useMemo(
    () => cullScene(buildScene(document, pageId, boxes), viewport),
    [document, pageId, boxes, viewport],
  );
  const paintedScene = useMemo(() => applyBoxOverrides(scene, previewBoxes ?? {}), [scene, previewBoxes]);
  const assetIds = useMemo(() => collectAssetIds(scene), [scene]);

  useEffect(() => {
    if (assetIds.length === 0) return;
    let cancelled = false;
    void Promise.all(assetIds.map(async assetId => {
      const asset: AssetMetadata | undefined = document.assets[assetId];
      if (!asset) return undefined;
      const url = await loadAssetUrl(repository, projectId, asset);
      if (!url) return undefined;
      const image = new Image();
      image.src = url;
      await image.decode().catch(() => undefined);
      return image.naturalWidth > 0 ? ([assetId, image] as const) : undefined;
    })).then(entries => {
      if (cancelled) return;
      const loaded = entries.filter((entry): entry is readonly [string, HTMLImageElement] => Boolean(entry));
      if (!loaded.length) return;
      setImages(previous => {
        const next = new Map(previous);
        for (const [assetId, image] of loaded) next.set(assetId, image);
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [assetIds, document.assets, projectId, repository]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current ??= createCanvas2DRenderer(canvas);
    rendererRef.current.paint(paintedScene, {
      width,
      height,
      zoom,
      devicePixelRatio: window.devicePixelRatio || 1,
      images,
      onAfterPaint: context => {
        // 框选与绘制预览跟选区无关：从空白处开始框选时选区本来就是空的，
        // 之前把两者都放在 `selection` 判空之后，导致选框一直画不出来。
        if (marquee) paintMarquee(context, marquee, { zoom });
        if (drawRect) paintDrawPreview(context, drawRect, { zoom, shape: drawShape });
        if (penPath?.length) paintPathPreview(context, penPath, { zoom });
        if (penAnchors?.length) paintPathAnchors(context, penAnchors, { zoom, closing: penClosing });
        if (!selection?.length) return;
        const bounds = selectionBounds(selectedBoxes(paintedScene, selection));
        if (bounds) paintSelectionOverlay(context, bounds, { zoom });
        if (guides?.length) paintSnapGuides(context, guides, { width, height }, { zoom });
      },
    });
  }, [paintedScene, zoom, images, width, height, selection, marquee, drawRect, drawShape, penPath, penAnchors, penClosing, guides]);

  return <canvas ref={canvasRef} className="canvas-surface" aria-hidden="true" />;
}

/** 场景里所有图片节点的 assetId（去重、跳过占位）。 */
export function collectAssetIds(scene: SceneNode[]): string[] {
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
