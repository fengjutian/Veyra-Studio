import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AssetMetadata, DesignDocument } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { loadAssetUrl } from "../asset-url";
import { collectAssetIds } from "../renderer/canvas-surface";
import { createCanvas2DRenderer, type SceneRenderer } from "../renderer/canvas-renderer";
import type { SceneNode } from "../renderer/scene";

export interface PreviewLayerProps {
  document: DesignDocument;
  repository: ProjectRepository;
  projectId: string;
  scene: SceneNode;
  width: number;
  height: number;
  /** overlay 层要透明背景，否则会盖住下面的屏幕。 */
  transparent?: boolean;
  /** 动画用的额外 class；画布本身不参与动画计算。 */
  className?: string;
  style?: CSSProperties;
}

/**
 * 预览里的一层（屏幕 / overlay）。
 *
 * 每层一个 canvas：push/slide 这类「两个屏幕同时动」的动画用 DOM 层做 transform，
 * 不必在 canvas 里同时画两屏；图片仍走与编辑器相同的对象 URL 缓存。
 */
export function PreviewLayer({ document, repository, projectId, scene, width, height, transparent, className, style }: PreviewLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);
  const [images, setImages] = useState<Map<string, CanvasImageSource>>(() => new Map());
  const assetIds = useMemo(() => collectAssetIds([scene]), [scene]);

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
    rendererRef.current.paint([scene], {
      width,
      height,
      zoom: 1,
      devicePixelRatio: window.devicePixelRatio || 1,
      images,
      ...(transparent ? { background: "transparent" } : {}),
    });
  }, [scene, images, width, height, transparent]);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}
