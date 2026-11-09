import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { computePageLayout } from "@ufira/design-layout";
import { DEFAULT_INTERACTION_DELAY, type DesignDocument, type NodeId, type PrototypeAnimation } from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../canvas-zoom";
import { createBrowserTextMeasurer } from "../browser-text-measurer";
import { hitTestStack } from "../renderer/hit-test";
import type { SceneNode } from "../renderer/scene";
import { PreviewLayer } from "./preview-layer";
import { applyScrollToScene, buildTranslatedScene, computeScrollMax, scrollHostsInSubtree, type ScrollOffset } from "./scene-build";
import { overlayOffset } from "./overlay-position";
import {
  clampScroll,
  dispatchPrototype,
  findPageId,
  interactionsOf,
  scheduledInteractions,
  startPrototype,
  type PrototypeEvent,
  type PrototypeState,
} from "./state";

export interface PrototypePreviewProps {
  document: DesignDocument;
  repository: ProjectRepository;
  projectId: string;
  /** 从哪一屏开始；通常是选中的 frame，没选中时用页面第一个根节点。 */
  startScreenId: NodeId;
  onExit(): void;
}

/**
 * 原型预览。
 *
 * 分成两层：`state.ts` 是纯状态机（Node 里可测），这里是 React 外壳——
 * 布局、画布、点击命中、after-delay 计时器和 CSS 动画。
 */
export function PrototypePreview({ document, repository, projectId, startScreenId, onExit }: PrototypePreviewProps) {
  const [state, setState] = useState<PrototypeState>(() => startPrototype(document, startScreenId));
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 舞台元素：滚轮要用非被动监听器接，得拿到真实 DOM 节点。 */
  const stageRef = useRef<HTMLDivElement>(null);

  const dispatch = useCallback((event: PrototypeEvent) => {
    const result = dispatchPrototype(stateRef.current, document, event);
    if (result.openUrl) window.open(result.openUrl, "_blank", "noopener,noreferrer");
    stateRef.current = result.state;
    setState(result.state);
  }, [document]);

  const measurer = useMemo(() => createBrowserTextMeasurer(), []);
  const pages = useMemo(() => {
    const set = new Set<string>();
    for (const nodeId of [state.previousScreenId, state.screenId, ...state.overlays.map(overlay => overlay.nodeId)]) {
      if (!nodeId) continue;
      const pageId = findPageId(document, nodeId);
      if (pageId) set.add(pageId);
    }
    return [...set].sort();
  }, [document, state]);

  const boxesByPage = useMemo(() => {
    const result: Record<string, Record<string, { x: number; y: number; width: number; height: number } | undefined>> = {};
    for (const pageId of pages) {
      try {
        result[pageId] = computePageLayout(document, pageId, { viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }, textMeasurer: measurer }).boxes;
      } catch {
        // 文档坏掉时预览也不该白屏：退回节点自带的 layout 值。
        result[pageId] = {};
      }
    }
    return result;
  }, [document, pages, measurer]);

  /** 节点自己的绝对盒子；没有布局结果时退回文档里的 layout。 */
  const boxOf = useCallback((nodeId: NodeId) => {
    const pageId = findPageId(document, nodeId);
    const boxes = pageId ? boxesByPage[pageId] ?? {} : {};
    return boxes[nodeId] ?? document.nodes[nodeId]?.layout;
  }, [document, boxesByPage]);

  /** 某个节点所在页面的布局盒子。 */
  const boxesFor = useCallback((nodeId: NodeId) => {
    const pageId = findPageId(document, nodeId);
    return pageId ? boxesByPage[pageId] ?? {} : {};
  }, [document, boxesByPage]);

  /**
   * 夹紧后的滚动偏移。
   *
   * 记忆里的旧位置可能已经越界（这一轮内容变短了），
   * 套到场景上之前先按当前的最大可滚动距离收一收。
   */
  const scrollOffsets = useMemo(() => {
    const result: Record<string, ScrollOffset> = {};
    for (const [hostId, offset] of Object.entries(state.scroll)) {
      const max = computeScrollMax(document, boxesFor(hostId), hostId);
      result[hostId] = { x: clampScroll(offset.x, max.x), y: clampScroll(offset.y, max.y) };
    }
    return result;
  }, [state.scroll, document, boxesFor]);

  /** 把某一屏摆到视口原点。 */
  const screenScene = useCallback((nodeId: NodeId | undefined) => {
    if (!nodeId) return undefined;
    const box = boxOf(nodeId);
    if (!box) return undefined;
    const pageId = findPageId(document, nodeId);
    const boxes = pageId ? boxesByPage[pageId] ?? {} : {};
    const scene = buildTranslatedScene(document, nodeId, boxes, -box.x, -box.y);
    return scene ? applyScrollToScene(scene, scrollOffsets) : undefined;
  }, [document, boxOf, boxesByPage, scrollOffsets]);

  const previous = useMemo(() => screenScene(state.previousScreenId), [screenScene, state.previousScreenId]);
  const screen = useMemo(() => screenScene(state.screenId), [screenScene, state.screenId]);

  const screenOrigin = useMemo(() => {
    const box = boxOf(state.screenId);
    return { x: box?.x ?? 0, y: box?.y ?? 0 };
  }, [boxOf, state.screenId]);

  const overlays = useMemo(() => state.overlays.map(overlay => {
    const node = document.nodes[overlay.nodeId];
    const box = boxOf(overlay.nodeId);
    if (!node || !box) return undefined;
    const pageId = findPageId(document, overlay.nodeId);
    const boxes = pageId ? boxesByPage[pageId] ?? {} : {};
    const anchorBox = boxOf(overlay.triggerNodeId);
    const anchor = anchorBox
      ? { ...anchorBox, x: anchorBox.x - screenOrigin.x, y: anchorBox.y - screenOrigin.y }
      : undefined;
    const { dx, dy } = overlayOffset({
      positionType: overlay.interaction.overlayPositionType ?? "center",
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      overlay: box,
      anchor,
      manual: overlay.interaction.overlayPosition,
    });
    const scene = buildTranslatedScene(document, overlay.nodeId, boxes, dx, dy);
    return {
      id: overlay.nodeId,
      scene: scene ? applyScrollToScene(scene, scrollOffsets) : undefined,
      dim: overlay.interaction.backgroundOverlay !== false,
    };
  }).filter((overlay): overlay is { id: string; scene: NonNullable<ReturnType<typeof buildTranslatedScene>>; dim: boolean } => Boolean(overlay?.scene)), [state.overlays, document, boxOf, boxesByPage, screenOrigin, scrollOffsets]);

  /** 滚轮命中的滚动宿主：命中路径里最深、且内容真能滚的那个。 */
  const scrollHostAt = useCallback((clientX: number, clientY: number): NodeId | undefined => {
    const rect = stageRef.current?.getBoundingClientRect();
    const point = { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
    const layers: Array<{ scene: SceneNode; root: NodeId }> = [
      // overlay 在屏幕上面，先看 overlay。
      ...overlays.map(overlay => ({ scene: overlay.scene, root: overlay.id })).reverse(),
      ...(screen ? [{ scene: screen, root: state.screenId }] : []),
    ];
    for (const layer of layers) {
      const hosts = new Set(scrollHostsInSubtree(document, layer.root));
      // hitTestStack 从最深到最外层：先撞上的就是最内层的宿主。
      for (const nodeId of hitTestStack([layer.scene], point)) {
        if (!hosts.has(nodeId)) continue;
        const max = computeScrollMax(document, boxesFor(nodeId), nodeId);
        if (max.x > 0 || max.y > 0) return nodeId;
      }
    }
    return undefined;
  }, [document, overlays, screen, state.screenId, boxesFor]);

  /**
   * 滚轮：落到哪个滚动宿主上就滚哪个。
   *
   * 用**非被动**监听器接：React 的 `onWheel` 在根容器上是被动监听，
   * `preventDefault()` 不生效，浏览器会把外层预览区一起滚走。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      const host = scrollHostAt(event.clientX, event.clientY);
      if (!host) return;
      const max = computeScrollMax(document, boxesFor(host), host);
      if (max.x <= 0 && max.y <= 0) return;
      event.preventDefault();
      dispatch({ kind: "scroll", hostId: host, deltaX: event.deltaX, deltaY: event.deltaY, maxX: max.x, maxY: max.y });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [dispatch, document, boxesFor, scrollHostAt]);

  // after-delay：进入一屏后按节点上的延迟排计时器，切屏时整批清掉。
  useEffect(() => {
    const timers = scheduledInteractions(document, state.screenId).map(({ nodeId, interaction }) =>
      window.setTimeout(() => dispatch({ kind: "after-delay", nodeId }), interaction.delay ?? DEFAULT_INTERACTION_DELAY));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [document, state.screenId, dispatch]);

  // 动画结束：清掉退出中的上一屏，避免它一直叠在下面。
  useEffect(() => {
    const transition = state.transition;
    if (!transition) return;
    const duration = transition.animation?.duration ?? 0;
    const timer = window.setTimeout(() => dispatch({ kind: "animation-end", transitionId: transition.id }), Math.max(0, duration));
    return () => window.clearTimeout(timer);
  }, [state.transition, dispatch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  const pointFor = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** 命中：overlay 优先且不穿透；返回应当派发事件的节点。 */
  const hitNode = (point: { x: number; y: number }): NodeId | undefined => {
    for (let index = overlays.length - 1; index >= 0; index -= 1) {
      const stack = hitTestStack([overlays[index]!.scene], point);
      if (!stack.length) continue;
      const interactive = stack.find(id => hasAnyInteraction(document, id));
      return interactive;
    }
    const stack = screen ? hitTestStack([screen], point) : [];
    return stack[0];
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const nodeId = hitNode(pointFor(event));
    if (nodeId) dispatch({ kind: "press", nodeId });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const nodeId = hitNode(pointFor(event));
    if (nodeId) {
      dispatch({ kind: "click", nodeId });
      return;
    }
    dispatch({ kind: "click-outside" });
  };

  const hoverRef = useRef<NodeId | undefined>(undefined);
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const hovered = hitNode(pointFor(event));
    if (hovered === hoverRef.current) return;
    if (hoverRef.current) dispatch({ kind: "hover-out", nodeId: hoverRef.current });
    hoverRef.current = hovered;
    if (hovered) dispatch({ kind: "hover-in", nodeId: hovered });
  };
  const clearHover = () => {
    if (hoverRef.current) dispatch({ kind: "hover-out", nodeId: hoverRef.current });
    hoverRef.current = undefined;
  };

  const animation = state.transition?.animation;
  const currentClass = animation ? `proto-anim ${currentAnimationClass(animation)}` : undefined;
  const previousClass = animation ? `proto-anim ${previousAnimationClass(animation)}` : undefined;
  const animationStyle = animation ? { animationDuration: `${animation.duration}ms`, animationTimingFunction: animation.easing } : undefined;

  return (
    <div className="prototype-preview" role="dialog" aria-modal="true" aria-label="原型预览">
      <div className="prototype-toolbar">
        <strong>预览</strong>
        <span className="prototype-screen-name">{document.nodes[state.screenId]?.name ?? state.screenId}</span>
        <span className="prototype-spacer" />
        <button type="button" disabled={!state.history.length} onClick={() => dispatch({ kind: "back" })}>返回</button>
        <button type="button" onClick={onExit}>退出预览（Esc）</button>
      </div>
      <div className="prototype-viewport">
        <div
          ref={stageRef}
          className="prototype-stage"
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerMove={handlePointerMove}
          onPointerLeave={clearHover}
        >
          {previous && state.transition && (
            <div key={`prev-${state.transition.id}`} className={`prototype-layer ${previousClass ?? ""}`} style={animationStyle}>
              <PreviewLayer document={document} repository={repository} projectId={projectId} scene={previous} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
            </div>
          )}
          {screen && (
            <div key={`cur-${state.transition?.id ?? "static"}`} className={`prototype-layer ${currentClass ?? ""}`} style={animationStyle}>
              <PreviewLayer document={document} repository={repository} projectId={projectId} scene={screen} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
            </div>
          )}
          {overlays.some(overlay => overlay.dim) && <div className="prototype-backdrop" />}
          {overlays.map(overlay => (
            <div key={overlay.id} className="prototype-layer prototype-overlay">
              <PreviewLayer document={document} repository={repository} projectId={projectId} scene={overlay.scene} width={CANVAS_WIDTH} height={CANVAS_HEIGHT} transparent />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 进入中的屏幕动画。 */
/** 命中 overlay 时：只有自身带交互的节点才算「可点」，否则点空白不该穿透到下面的屏幕。 */
function hasAnyInteraction(document: DesignDocument, nodeId: NodeId): boolean {
  return Boolean(document.nodes[nodeId]?.interactions?.length);
}

export function currentAnimationClass(animation: PrototypeAnimation): string {
  if (animation.type === "dissolve") return "proto-fade-in";
  const direction = animation.direction ?? "right";
  return animation.type === "slide" ? `proto-slide-in-${direction}` : `proto-push-in-${direction}`;
}

/** 退出中的上一屏动画；slide 与 dissolve 不需要（新屏覆盖或淡入即可）。 */
export function previousAnimationClass(animation: PrototypeAnimation): string | undefined {
  if (animation.type !== "push") return undefined;
  return `proto-push-out-${animation.direction ?? "right"}`;
}
