import { useEffect, useMemo, useRef, useState } from "react";
import type { PathCommand, VectorGeometry } from "@ufira/design-schema";
import { hitTestVectorPath } from "@ufira/design-schema";
import {
  anchorsFromPath,
  closestSegment,
  commandsFromAnchors,
  handlesOf,
  hitTestAnchor,
  hitTestHandle,
  insertAnchor,
  moveAnchor,
  moveHandle,
  pathIsClosed,
  removeAnchor,
  type EditableAnchor,
  type HandleRole,
} from "../path-edit";
import { constrainAngle, penGeometry } from "../pen";
import type { HitPoint } from "./hit-test";
import type { Rect } from "./selection";

/**
 * 矢量路径的节点编辑（P3.3）。
 *
 * 进入编辑态后接管画布指针：手柄 > 锚点 > 空白（退出）。拖拽过程中只改本地锚点副本，
 * 松手才提交一条 `vector.patch`——和拖动节点一样，一次拖动一次撤销。
 */
export interface PathEditTarget {
  id: string;
  /** 绝对场景坐标的路径命令。 */
  commands: PathCommand[];
  box: Rect;
}

export interface PathEditOptions {
  target: PathEditTarget | undefined;
  zoom: number;
  busy: boolean;
  pointOf(event: { clientX: number; clientY: number }): HitPoint;
  onCommit(change: { id: string; geometry: VectorGeometry; box: Rect }): void;
  onExit(): void;
}

type Drag =
  | { kind: "anchor"; index: number }
  | { kind: "handle"; anchorIndex: number; role: HandleRole };

export interface PathEditHandlers {
  onPointerDownCapture(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerMove(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerUp(event: React.PointerEvent<HTMLDivElement>): void;
  onPointerCancel(event: React.PointerEvent<HTMLDivElement>): void;
}

export function usePathEdit(options: PathEditOptions): {
  handlers: PathEditHandlers;
  /** 编辑中的锚点（绝对场景坐标）。 */
  anchors: EditableAnchor[];
  /** 手柄连线：从锚点指向控制点。 */
  handles: Array<{ from: HitPoint; to: HitPoint; anchorIndex: number; role: HandleRole }>;
  /** 当前选中的锚点下标。 */
  selected: number | null;
  /** 编辑中的整条路径（绝对场景坐标），用于画布预览。 */
  previewCommands: PathCommand[];
  /** 指针是否停在路径线段上（提示可以插点）。 */
  hoverSegment: boolean;
} {
  const [anchors, setAnchors] = useState<EditableAnchor[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [hoverSegment, setHoverSegment] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const dirtyRef = useRef(false);
  const anchorsRef = useRef<EditableAnchor[]>([]);
  const commitRef = useRef(options.onCommit);
  commitRef.current = options.onCommit;
  const exitRef = useRef(options.onExit);
  exitRef.current = options.onExit;

  const targetId = options.target?.id;
  const targetCommands = options.target?.commands;

  // 目标节点或它的几何变化（含提交之后的新文档）时重建工作副本。
  useEffect(() => {
    if (!options.target) {
      anchorsRef.current = [];
      setAnchors([]);
      setSelected(null);
      return;
    }
    const next = anchorsFromPath(options.target.commands);
    anchorsRef.current = next;
    setAnchors(next);
    setSelected(null);
  }, [targetId, targetCommands]);

  const closed = options.target ? pathIsClosed(options.target.commands) : false;

  const update = (next: EditableAnchor[]) => {
    anchorsRef.current = next;
    setAnchors(next);
    dirtyRef.current = true;
  };

  const handlers: PathEditHandlers = {
    onPointerDownCapture: event => {
      if (!options.target || options.busy || event.button !== 0) return;
      const point = options.pointOf(event);
      const tolerance = 8 / Math.max(options.zoom, 0.01);
      const handle = hitTestHandle(anchorsRef.current, point, tolerance);
      if (handle) {
        dragRef.current = { kind: "handle", anchorIndex: handle.anchorIndex, role: handle.role };
        setSelected(handle.anchorIndex);
        dirtyRef.current = false;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      const anchorIndex = hitTestAnchor(anchorsRef.current, point, tolerance);
      if (anchorIndex !== undefined) {
        dragRef.current = { kind: "anchor", index: anchorIndex };
        setSelected(anchorIndex);
        dirtyRef.current = false;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      // 点在路径线段上：插入一个锚点，并顺势进入拖动状态（Figma 里点线段也是这个行为）。
      const segment = closestSegment(anchorsRef.current, closed, point, tolerance);
      if (segment) {
        update(insertAnchor(anchorsRef.current, closed, segment.index, segment.t));
        setSelected(segment.index + 1);
        dragRef.current = { kind: "anchor", index: segment.index + 1 };
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      // 点在图形本体上：保持编辑态，只取消锚点选中（Figma 同样不会因此退出）。
      if (hitTestVectorPath(options.target.commands, options.target.box, point)) {
        setSelected(null);
        return;
      }
      // 点到路径之外：退出编辑态（Figma 同样会退出并清空选中）。
      exitRef.current();
    },
    onPointerMove: event => {
      const drag = dragRef.current;
      if (!options.target) return;
      if (!drag) {
        // 没有拖动时跟踪指针：悬停在路径线段上就提示「可以插点」。
        const tolerance = 8 / Math.max(options.zoom, 0.01);
        const over = Boolean(closestSegment(anchorsRef.current, closed, options.pointOf(event), tolerance));
        setHoverSegment(current => current === over ? current : over);
        return;
      }
      const point = options.pointOf(event);
      if (drag.kind === "anchor") {
        update(moveAnchor(anchorsRef.current, drag.index, point));
      } else {
        const anchor = anchorsRef.current[drag.anchorIndex];
        if (!anchor) return;
        // Shift 约束手柄方向到 45°；Alt 断开展开对称，只动这一侧。
        const handle = event.shiftKey ? constrainAngle(anchor, point) : point;
        update(moveHandle(anchorsRef.current, { anchorIndex: drag.anchorIndex, role: drag.role }, handle, !event.altKey));
      }
      event.stopPropagation();
    },
    onPointerUp: () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag || !options.target) return;
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      // 提交时重算紧包围盒并整体归一化：锚点因此可以拖到旧盒子之外。
      const result = penGeometry(anchorsRef.current, closed);
      if (result) commitRef.current({ id: options.target.id, geometry: result.geometry, box: result.box });
    },
    onPointerCancel: () => {
      dragRef.current = null;
      dirtyRef.current = false;
      if (!options.target) return;
      const restored = anchorsFromPath(options.target.commands);
      anchorsRef.current = restored;
      setAnchors(restored);
    },
  };

  // Delete 删除当前锚点。
  useEffect(() => {
    if (!options.target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.matches("input, textarea, select, [contenteditable=true]")) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (selected === null) return;
      const next = removeAnchor(anchorsRef.current, selected, closed);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      anchorsRef.current = next;
      setAnchors(next);
      setSelected(null);
      const result = penGeometry(next, closed);
      if (result) commitRef.current({ id: options.target!.id, geometry: result.geometry, box: result.box });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [targetId, selected, closed]);

  const handles = useMemo(() => handlesOf(anchors).map(handle => ({
    anchorIndex: handle.anchorIndex,
    role: handle.role,
    to: handle.point,
    from: { x: anchors[handle.anchorIndex]?.x ?? 0, y: anchors[handle.anchorIndex]?.y ?? 0 },
  })), [anchors]);

  const previewCommands = useMemo(() => commandsFromAnchors(anchors, closed), [anchors, closed]);

  return {
    /** 指针是否停在路径线段上（用于提示可以插点）。 */
    hoverSegment,
    handlers,
    anchors,
    handles,
    selected,
    previewCommands,
  };
}
