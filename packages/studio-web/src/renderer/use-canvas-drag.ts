import { useRef, useState } from "react";
import type { DesignNode } from "@ufira/design-schema";
import { hitTest, type HitPoint } from "./hit-test";
import { hitTestHandle, selectedBoxes, selectionBounds, type HandleId } from "./selection";
import { offsetSubtreeBoxes, resizeBox } from "./selection-drag";
import { nodesInRect, rectFromPoints } from "./marquee";
import { snapBox, snapTargetsFromScene, type SnapGuide } from "./snapping";
import type { Rect } from "./selection";
import type { SceneBox, SceneNode } from "./scene";

/**
 * 画布拖拽/缩放（Moveable 的替代）。
 *
 * 只接管两件事：拖动已选中的节点、拖动选择框手柄缩放单个节点。空白处框选仍交给
 * Selecto，文本编辑仍走 DOM。指针事件在捕获阶段处理，命中时 `stopPropagation`，
 * 这样 Moveable 不会被同时触发。
 */
export interface CanvasDragOptions {
  enabled: boolean;
  busy: boolean;
  zoom: number;
  scene: SceneNode[];
  selectedIds: string[];
  /** 指针事件 → 场景坐标（由调用方提供 canvas 的 rect）。 */
  pointOf(event: { clientX: number; clientY: number }): HitPoint;
  layoutOf(id: string): DesignNode["layout"] | undefined;
  onCommit(changes: Array<{ id: string; layout: DesignNode["layout"] }>): void;
  /** 框选结束；空数组表示清空选择。 */
  onMarquee?(ids: string[]): void;
}

type Gesture =
  | { kind: "move"; ids: string[]; start: HitPoint }
  | { kind: "resize"; id: string; handle: HandleId; start: HitPoint; box: SceneBox }
  | { kind: "marquee"; start: HitPoint };

export interface CanvasDragHandlers {
  onPointerDownCapture(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: React.PointerEvent<HTMLDivElement>): void;
}

export function useCanvasDrag(options: CanvasDragOptions): {
  previewBoxes: Record<string, SceneBox>;
  /** 框选中的矩形（场景坐标）。 */
  marquee: Rect | undefined;
  /** 对齐辅助线。 */
  guides: SnapGuide[];
  handlers: CanvasDragHandlers;
  /** 刚刚完成过拖拽时置 true，用于抑制随后的 click 清除选择。 */
  consumedClick(): boolean;
} {
  const [previewBoxes, setPreviewBoxes] = useState<Record<string, SceneBox>>({});
  const [marquee, setMarquee] = useState<Rect | undefined>(undefined);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  const marqueeRef = useRef<Rect | undefined>(undefined);
  const previewRef = useRef<Record<string, SceneBox>>({});
  const gestureRef = useRef<Gesture | null>(null);
  const movedRef = useRef(false);
  const consumedRef = useRef(false);

  const updatePreview = (boxes: Record<string, SceneBox>) => {
    previewRef.current = boxes;
    setPreviewBoxes(boxes);
  };

  const onPointerDownCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!options.enabled || options.busy || event.button !== 0) return;
    // 文本编辑覆盖层自己处理输入，不要触发拖动。
    if ((event.target as HTMLElement | null)?.closest?.(".canvas-text-edit")) return;
    // 每次按下都重置「刚拖过」标记：它只用来抑制拖拽结束后浏览器补发的那一次 click，
    // 不能把下一次正常点击一起吞掉（否则拖完再点别的节点会没反应）。
    movedRef.current = false;
    consumedRef.current = false;
    const point = options.pointOf(event);
    const bounds = selectionBounds(selectedBoxes(options.scene, options.selectedIds));
    const handle = bounds && options.selectedIds.length === 1
      ? hitTestHandle(bounds, point, 8 / Math.max(options.zoom, 0.01))
      : undefined;

    if (handle && bounds) {
      gestureRef.current = { kind: "resize", id: options.selectedIds[0]!, handle, start: point, box: bounds };
    } else {
      const hit = hitTest(options.scene, point);
      if (hit && options.selectedIds.includes(hit)) {
        gestureRef.current = { kind: "move", ids: [...options.selectedIds], start: point };
      } else if (!hit) {
        // 空白处按下：开始框选。DOM 点击仍负责选中未选中的节点。
        gestureRef.current = { kind: "marquee", start: point };
        marqueeRef.current = undefined;
        setMarquee(undefined);
      }
    }

    if (!gestureRef.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = options.pointOf(event);
    const deltaX = point.x - gesture.start.x;
    const deltaY = point.y - gesture.start.y;
    if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) movedRef.current = true;
    if (gesture.kind === "move") {
      const bounds = selectionBounds(selectedBoxes(options.scene, gesture.ids));
      const targets = snapTargetsFromScene(options.scene, gesture.ids);
      const snap = bounds
        ? snapBox({ ...bounds, x: bounds.x + deltaX, y: bounds.y + deltaY }, targets, { threshold: 6 / Math.max(options.zoom, 0.01) })
        : { deltaX: 0, deltaY: 0, guides: [] };
      setGuides(snap.guides);
      updatePreview(offsetSubtreeBoxes(options.scene, gesture.ids, deltaX + snap.deltaX, deltaY + snap.deltaY));
    }
    else if (gesture.kind === "resize") updatePreview({ [gesture.id]: resizeBox(gesture.box, gesture.handle, deltaX, deltaY) });
    else {
      const rect = rectFromPoints(gesture.start, point);
      marqueeRef.current = rect;
      setMarquee(rect);
    }
    event.stopPropagation();
  };

  const finish = (commit: boolean) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    const finalBoxes = previewRef.current;
    const shouldCommit = commit && movedRef.current;
    consumedRef.current = movedRef.current;
    if (shouldCommit && gesture.kind === "marquee") {
      options.onMarquee?.(nodesInRect(options.scene, marqueeRef.current ?? { x: 0, y: 0, width: 0, height: 0 }));
    } else if (shouldCommit) {
      const changes: Array<{ id: string; layout: DesignNode["layout"] }> = [];
      for (const id of Object.keys(finalBoxes)) {
        const box = finalBoxes[id]!;
        const layout = options.layoutOf(id);
        if (!layout) continue;
        // 只提交选中根节点的布局；预览里还有后代，它们由布局引擎按相对坐标重算。
        if (gesture.kind === "move" && !gesture.ids.includes(id)) continue;
        changes.push({ id, layout: { ...layout, x: box.x, y: box.y, width: box.width, height: box.height } });
      }
      if (changes.length) options.onCommit(changes);
    }
    updatePreview({});
    setGuides([]);
    marqueeRef.current = undefined;
    setMarquee(undefined);
  };

  return {
    previewBoxes,
    marquee,
    guides,
    consumedClick: () => consumedRef.current,
    handlers: {
      onPointerDownCapture,
      onPointerMove,
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(false),
    },
  };
}
