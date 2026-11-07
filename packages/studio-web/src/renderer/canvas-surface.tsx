import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignDocument, AssetMetadata } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { loadAssetUrl } from "../asset-url";
import { buildScene, type SceneBox, type SceneNode } from "./scene";
import { cullScene, type CullViewport } from "./culling";
import { createCanvas2DRenderer, type SceneRenderer } from "./canvas-renderer";

/**
 * Canvas 画布层。
 *
 * 只负责"画"：DOM 里的节点仍然保留，用作命中测试、Moveable/Selecto 的手柄和
 * 文本编辑入口（tldraw 的文本编辑也是 DOM overlay）。这样渲染器替换是渐进的：
 * 画布视觉走 Canvas，交互仍走现有 DOM 层。
 */
export interface CanvasSurfaceProps {
  enabled: boolean;
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
}

export function CanvasSurface({ enabled, repository, projectId, document, pageId, boxes, width, height, zoom, viewport }: CanvasSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);
  const [images, setImages] = useState<Map<string, CanvasImageSource>>(() => new Map());
  const scene = useMemo(
    () => (enabled ? cullScene(buildScene(document, pageId, boxes), viewport) : []),
    [enabled, document, pageId, boxes, viewport],
  );
  const assetIds = useMemo(() => collectAssetIds(scene), [scene]);

  useEffect(() => {
    if (!enabled || assetIds.length === 0) return;
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
  }, [enabled, assetIds, document.assets, projectId, repository]);

  useEffect(() => {
    if (!enabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    rendererRef.current ??= createCanvas2DRenderer(canvas);
    rendererRef.current.paint(scene, {
      width,
      height,
      zoom,
      devicePixelRatio: window.devicePixelRatio || 1,
      images,
    });
  }, [enabled, scene, zoom, images, width, height]);

  if (!enabled) return null;
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
