import { useEffect, useMemo, useRef, useState } from "react";
import type { PathCommand, VectorGeometry } from "@ufira/design-schema";
import { anchorFromDrag, constrainAngle, isClosingPoint, isDuplicateAnchor, penCommands, penGeometry, type PenAnchor } from "../pen";
import type { HitPoint } from "./hit-test";
import type { Rect } from "./selection";

/**
 * 钢笔工具。
 *
 * 与其它图元工具的区别：它们一次手势创建一个节点，钢笔一次路径要跨越多次点击。
 * 所以在拖拽 hook 之外单独放一个实现——草稿锚点存在这里，松手不提交，
 * 直到「闭合 / Enter / Esc / 双击」才发出唯一一条 `node.create`。
 */
export interface PenCommit {
  box: Rect;
  geometry: VectorGeometry;
  closed: boolean;
}

export interface PenToolOptions {
  /** 当前工具是不是钢笔；切走时草稿丢弃。 */
  active: boolean;
  busy: boolean;
  zoom: number;
  pointOf(event: { clientX: number; clientY: number }): HitPoint;
  onCommit(result: PenCommit): void;
}

export interface PenHandlers {
  onPointerDownCapture(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: React.PointerEvent<HTMLDivElement>): void;
}

export function usePenTool(options: PenToolOptions): {
  handlers: PenHandlers;
  /** 草稿路径（绝对场景坐标），供画布预览。 */
  previewPath: PathCommand[];
  /** 已落下的锚点。 */
  previewAnchors: HitPoint[];
  /** 指针是否停在起点上（闭合提示）。 */
  previewClosing: boolean;
  /** 结束当前路径（开放）。 */
  finish(): void;
} {
  const [anchors, setAnchors] = useState<PenAnchor[]>([]);
  const [cursor, setCursor] = useState<HitPoint | undefined>(undefined);
  const [previewClosing, setPreviewClosing] = useState(false);
  const anchorsRef = useRef<PenAnchor[]>([]);
  const dragRef = useRef<number | null>(null);
  const commitRef = useRef(options.onCommit);
  commitRef.current = options.onCommit;

  const reset = () => {
    anchorsRef.current = [];
    dragRef.current = null;
    setAnchors([]);
    setCursor(undefined);
    setPreviewClosing(false);
  };

  const finish = (closed: boolean) => {
    const list = anchorsRef.current;
    const result = penGeometry(list, closed);
    reset();
    if (result) commitRef.current({ ...result, closed });
  };

  // 切走工具或指针离开钢笔模式：草稿作废，不留下悬挂状态。
  useEffect(() => {
    if (!options.active) reset();
  }, [options.active]);

  // Enter / Esc 结束路径。Esc 同时会被全局工具快捷键切回选择工具，这正好是 Figma 的行为。
  useEffect(() => {
    if (!options.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      if (!anchorsRef.current.length) return;
      event.preventDefault();
      finish(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [options.active]);

  const handlers: PenHandlers = {
    onPointerDownCapture: event => {
      if (!options.active || options.busy || event.button !== 0) return;
      const point = options.pointOf(event);
      const list = anchorsRef.current;
      // 点回起点：闭合路径。半径按屏幕像素换算，缩放后手感一致。
      if (list.length >= 2 && isClosingPoint(list[0]!, point, options.zoom)) {
        event.stopPropagation();
        event.preventDefault();
        finish(true);
        return;
      }
      // 双击结束时第二次点击会落在同一点，不该多出一个重复锚点。
      if (isDuplicateAnchor(list.at(-1), point, options.zoom)) return;
      const next = [...list, { x: point.x, y: point.y }];
      anchorsRef.current = next;
      dragRef.current = next.length - 1;
      setAnchors(next);
      setCursor(point);
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: event => {
      if (!options.active) return;
      const point = options.pointOf(event);
      const dragIndex = dragRef.current;
      if (dragIndex !== null) {
        const anchor = anchorsRef.current[dragIndex]!;
        const handle = event.shiftKey ? constrainAngle(anchor, point) : point;
        const updated = [...anchorsRef.current];
        updated[dragIndex] = anchorFromDrag(anchor, handle, options.zoom);
        anchorsRef.current = updated;
        setAnchors(updated);
        setCursor(point);
        event.stopPropagation();
        return;
      }
      if (!anchorsRef.current.length) return;
      setCursor(point);
      setPreviewClosing(anchorsRef.current.length >= 2 && isClosingPoint(anchorsRef.current[0]!, point, options.zoom));
    },
    onPointerUp: () => { dragRef.current = null; },
    onPointerCancel: () => { dragRef.current = null; },
  };

  const previewPath = useMemo(() => penCommands(anchors, false, cursor), [anchors, cursor]);
  const previewAnchors = useMemo(() => anchors.map(anchor => ({ x: anchor.x, y: anchor.y })), [anchors]);

  return { handlers, previewPath, previewAnchors, previewClosing, finish: () => finish(false) };
}
