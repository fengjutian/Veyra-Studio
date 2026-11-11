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
  moveAnchors,
  moveHandle,
  pathIsClosed,
  removeAnchors,
  snapAnchorPoint,
  toggleAnchorType,
  anchorType,
  type AnchorType,
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
  | { kind: "anchor"; index: number; origin: HitPoint; indices: number[]; base: EditableAnchor[] }
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
  /** 当前选中的锚点下标（可以多个）。 */
  selected: number[];
  /** 每个锚点的类型（角点 / 平滑点 / 尖角），画布上据此区分形状。 */
  anchorTypes: AnchorType[];
  /** 编辑中的整条路径（绝对场景坐标），用于画布预览。 */
  previewCommands: PathCommand[];
  /** 指针是否停在路径线段上（提示可以插点）。 */
  hoverSegment: boolean;
  /** 双击锚点：切换角点 / 平滑点；没有命中锚点时返回 false。 */
  toggleAnchorAt(point: HitPoint): boolean;
} {
  const [anchors, setAnchors] = useState<EditableAnchor[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  /** 选中的镜像：指针事件里拿到的还是上一次渲染的值。 */
  const selectedRef = useRef<number[]>([]);
  selectedRef.current = selected;
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
      setSelected([]);
      return;
    }
    const next = anchorsFromPath(options.target.commands);
    anchorsRef.current = next;
    setAnchors(next);
    setSelected([]);
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
        // 拖手柄只影响它自己那个锚点；多选状态原样保留。
        setSelected(current => (current.includes(handle.anchorIndex) ? current : [handle.anchorIndex]));
        dirtyRef.current = false;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      const anchorIndex = hitTestAnchor(anchorsRef.current, point, tolerance);
      if (anchorIndex !== undefined) {
        // Shift 加选 / 减选；普通点击只选这一个。
        // 点在**已经选中**的锚点上时保留整组——这样可以直接拖动整组。
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        let indices: number[];
        if (additive) {
          const wasSelected = selectedRef.current.includes(anchorIndex);
          indices = wasSelected
            ? selectedRef.current.filter(index => index !== anchorIndex)
            : [...selectedRef.current, anchorIndex].sort((a, b) => a - b);
          setSelected(indices);
          // 减选的那一下只是取消选中，不该顺手把剩下的锚点拖走。
          if (wasSelected) {
            event.stopPropagation();
            return;
          }
        } else if (selectedRef.current.includes(anchorIndex)) {
          indices = selectedRef.current;
        } else {
          indices = [anchorIndex];
        }
        setSelected(indices);
        const anchor = anchorsRef.current[anchorIndex];
        dragRef.current = {
          kind: "anchor",
          index: anchorIndex,
          origin: anchor ? { x: anchor.x, y: anchor.y } : point,
          indices,
          base: anchorsRef.current,
        };
        dirtyRef.current = false;
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      // 点在路径线段上：插入一个锚点，并顺势进入拖动状态（Figma 里点线段也是这个行为）。
      const segment = closestSegment(anchorsRef.current, closed, point, tolerance);
      if (segment) {
        update(insertAnchor(anchorsRef.current, closed, segment.index, segment.t));
        setSelected([segment.index + 1]);
        const inserted = anchorsRef.current[segment.index + 1];
        dragRef.current = {
          kind: "anchor",
          index: segment.index + 1,
          origin: inserted ? { x: inserted.x, y: inserted.y } : point,
          indices: [segment.index + 1],
          base: anchorsRef.current,
        };
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
      // 点在图形本体上：保持编辑态，只取消锚点选中（Figma 同样不会因此退出）。
      if (hitTestVectorPath(options.target.commands, options.target.box, point)) {
        setSelected([]);
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
        // 整组一起走同一个位移：从**拖动开始时**的位置算起，每帧都从基准重算，
        // 否则位移会一轮一轮累加，锚点会越拖越快。
        const delta = { x: point.x - drag.origin.x, y: point.y - drag.origin.y };
        // 吸附：拖着的锚点吸到路径上其它**没被选中**的锚点上。
        const candidates = drag.base
          .filter((_, index) => !drag.indices.includes(index))
          .map(anchor => ({ x: anchor.x, y: anchor.y }));
        const wanted = { x: drag.origin.x + delta.x, y: drag.origin.y + delta.y };
        const snapped = snapAnchorPoint(wanted, candidates, 8 / Math.max(options.zoom, 0.01));
        const adjust = snapped ? { x: snapped.x - wanted.x, y: snapped.y - wanted.y } : { x: 0, y: 0 };
        update(moveAnchors(drag.base, drag.indices, { x: delta.x + adjust.x, y: delta.y + adjust.y }));
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
      if (!selected.length) return;
      const next = removeAnchors(anchorsRef.current, selected, closed);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      anchorsRef.current = next;
      setAnchors(next);
      setSelected([]);
      const result = penGeometry(next, closed);
      if (result) commitRef.current({ id: options.target!.id, geometry: result.geometry, box: result.box });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [targetId, selected, closed]);

  /**
   * 双击锚点切换类型。切换是即时提交（不像拖动那样等 pointerup）：
   * 双击本身没有「抬起时再确认」的语义，晚提交反而会丢改动。
   */
  const toggleAnchorAt = (point: HitPoint): boolean => {
    if (!options.target) return false;
    const tolerance = 8 / Math.max(options.zoom, 0.01);
    const index = hitTestAnchor(anchorsRef.current, point, tolerance);
    if (index === undefined) return false;
    const next = toggleAnchorType(anchorsRef.current, index, closed);
    const result = penGeometry(next, closed);
    if (!result) return false;
    anchorsRef.current = next;
    setAnchors(next);
    setSelected([index]);
    commitRef.current({ id: options.target.id, geometry: result.geometry, box: result.box });
    return true;
  };

  const handles = useMemo(() => handlesOf(anchors).map(handle => ({
    anchorIndex: handle.anchorIndex,
    role: handle.role,
    to: handle.point,
    from: { x: anchors[handle.anchorIndex]?.x ?? 0, y: anchors[handle.anchorIndex]?.y ?? 0 },
  })), [anchors]);

  const previewCommands = useMemo(() => commandsFromAnchors(anchors, closed), [anchors, closed]);

  const anchorTypes = useMemo(() => anchors.map(anchor => anchorType(anchor)), [anchors]);

  return {
    /** 指针是否停在路径线段上（用于提示可以插点）。 */
    hoverSegment,
    toggleAnchorAt,
    handlers,
    anchors,
    handles,
    selected,
    anchorTypes,
    previewCommands,
  };
}
