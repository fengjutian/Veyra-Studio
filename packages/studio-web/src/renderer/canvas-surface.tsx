import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignDocument, AssetMetadata, PathCommand } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { loadAssetUrl } from "../asset-url";
import { buildScene, type SceneBox, type SceneNode } from "./scene";
import { cullScene, type CullViewport } from "./culling";
import { paintDrawPreview, paintMarquee, paintPathAnchors, paintPathEdit, paintPathPreview, paintSelectionOverlay, paintSnapGuides } from "./selection-overlay";
import type { SnapGuide } from "./snapping";
import { selectedBoxes, selectionBounds, type Rect } from "./selection";
import { applyBoxOverrides } from "./selection-drag";
import { rotatedBounds, toRadians } from "./rotation";
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
  /** 旋转预览：拖动手柄时节点的临时角度（度）。 */
  rotationOverride?: { id: string; rotation: number };
  /** 是否绘制框外的旋转手柄（单选时才有意义）。 */
  showRotateHandle?: boolean;
  /** 路径编辑中的实时几何：覆盖某个节点的路径，不写文档。 */
  pathOverride?: { id: string; commands: PathCommand[] };
  /** 路径编辑的锚点、手柄与当前选中项（绝对场景坐标）。 */
  editAnchors?: Array<{ x: number; y: number }>;
  editHandles?: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }>;
  editSelected?: number | null;
  /** 拖动时的对齐辅助线。 */
  guides?: SnapGuide[];
  /** 画布降级提示（无法合成、被跨域资源污染等）。 */
  onWarning?(message: string): void;
}

export function CanvasSurface({ repository, projectId, document, pageId, boxes, width, height, zoom, viewport, selection, previewBoxes, marquee, drawRect, drawShape, penPath, penAnchors, penClosing, rotationOverride, showRotateHandle, pathOverride, editAnchors, editHandles, editSelected, guides, onWarning }: CanvasSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SceneRenderer | undefined>(undefined);
  const [images, setImages] = useState<Map<string, CanvasImageSource>>(() => new Map());
  const scene = useMemo(
    () => cullScene(buildScene(document, pageId, boxes), viewport),
    [document, pageId, boxes, viewport],
  );
  const paintedScene = useMemo(
    () => applyRotationOverride(applyPathOverride(applyBoxOverrides(scene, previewBoxes ?? {}), pathOverride), rotationOverride),
    [scene, previewBoxes, pathOverride, rotationOverride],
  );
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
      onWarning,
      onAfterPaint: context => {
        // 框选与绘制预览跟选区无关：从空白处开始框选时选区本来就是空的，
        // 之前把两者都放在 `selection` 判空之后，导致选框一直画不出来。
        if (marquee) paintMarquee(context, marquee, { zoom });
        if (drawRect) paintDrawPreview(context, drawRect, { zoom, shape: drawShape });
        if (penPath?.length) paintPathPreview(context, penPath, { zoom });
        if (penAnchors?.length) paintPathAnchors(context, penAnchors, { zoom, closing: penClosing });
        if (selection?.length) {
          // 单选且旋转时，轮廓要按旋转后的形状画；多选时用各节点的旋转 AABB 合并。
          const radians = selectionRotation(paintedScene, selection);
          const bounds = radians
            ? selectionBounds(selectedBoxes(paintedScene, selection))
            : selectionBounds(rotatedAabbBoxes(paintedScene, selection));
          if (bounds) paintSelectionOverlay(context, bounds, { zoom, rotation: radians, showRotateHandle });
        }
        if (editAnchors?.length) paintPathEdit(context, { anchors: editAnchors, handles: editHandles ?? [], selected: editSelected ?? null }, { zoom });
        if (guides?.length) paintSnapGuides(context, guides, { width, height }, { zoom });
      },
    });
  }, [paintedScene, zoom, images, width, height, selection, marquee, drawRect, drawShape, penPath, penAnchors, penClosing, editAnchors, editHandles, editSelected, guides, onWarning]);

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

/** 把一个节点的路径替换成编辑中的实时路径（只改绘制用的副本，不动文档）。 */
function applyPathOverride(nodes: SceneNode[], override?: { id: string; commands: PathCommand[] }): SceneNode[] {
  if (!override) return nodes;
  const walk = (list: SceneNode[]): SceneNode[] => list.map(node => {
    const children = node.children.length ? walk(node.children) : node.children;
    if (node.id !== override.id) return children === node.children ? node : { ...node, children };
    return { ...node, path: override.commands, children };
  });
  return walk(nodes);
}
/** 单选节点的旋转角（弧度）；多选或未旋转返回 0。 */
function selectionRotation(scene: SceneNode[], ids: string[]): number {
  if (ids.length !== 1) return 0;
  const node = findSceneNode(scene, ids[0]!);
  return node?.rotation ? toRadians(node.rotation) : 0;
}

/** 选中节点的旋转 AABB：多选包围盒必须包住转出去的部分。 */
function rotatedAabbBoxes(scene: SceneNode[], ids: string[]): SceneBox[] {
  const wanted = new Set(ids);
  const boxes: SceneBox[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes) {
      if (wanted.has(node.id)) boxes.push(node.rotation ? rotatedBounds(node.box, toRadians(node.rotation)) : node.box);
      if (node.children.length) walk(node.children);
    }
  };
  walk(scene);
  return boxes;
}

function findSceneNode(nodes: SceneNode[], id: string): SceneNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findSceneNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}
/** 旋转预览：只覆盖绘制用的副本，松手提交后才写文档。 */
function applyRotationOverride(nodes: SceneNode[], override?: { id: string; rotation: number }): SceneNode[] {
  if (!override) return nodes;
  const walk = (list: SceneNode[]): SceneNode[] => list.map(node => {
    const children = node.children.length ? walk(node.children) : node.children;
    if (node.id !== override.id) return children === node.children ? node : { ...node, children };
    return { ...node, rotation: override.rotation || undefined, children };
  });
  return walk(nodes);
}