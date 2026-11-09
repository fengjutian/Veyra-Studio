import { hasPreserveScroll, type DesignDocument, type Interaction, type NodeId, type PrototypeAnimation } from "@ufira/design-schema";
import { scrollHostsInSubtree, type ScrollOffset } from "./scene-build";

/**
 * 原型运行时的状态机。
 *
 * 这里只有纯函数：给定文档、状态和事件，算出新状态与需要宿主执行的副作用。
 * 计时器、画布绘制、CSS 动画都在 `preview.tsx` —— 状态机本身可以在 Node 里跑单元测试。
 */

export interface PrototypeOverlay {
  nodeId: NodeId;
  /** 触发这次 overlay 的交互（定位与「点外面关闭」都从这里读）。 */
  interaction: Interaction;
  /** 触发这次 overlay 的节点：manual 定位与 `positionRelativeTo` 都相对它。 */
  triggerNodeId: NodeId;
}

export interface PrototypeTransition {
  /** 单调递增，UI 用它当 animation key 重新触发 CSS 动画。 */
  id: number;
  animation?: PrototypeAnimation;
}

export interface PrototypeState {
  /** 当前屏幕节点（通常是 frame，也可以是任意容器）。 */
  screenId: NodeId;
  /** 正在退出的上一屏；动画结束事件会清掉它。 */
  previousScreenId?: NodeId;
  /** 屏幕历史（不含当前屏），供 `prev-screen` 使用。 */
  history: NodeId[];
  overlays: PrototypeOverlay[];
  transition?: PrototypeTransition;
  /** 自增序号：给 transition.id 用，保证同一屏连续切换也有不同的 key。 */
  seq: number;
  /** 各滚动宿主的当前滚动偏移（按宿主节点 id）。 */
  scroll: Record<NodeId, ScrollOffset>;
  /**
   * 各滚动宿主被记住的滚动偏移。
   *
   * 离开一屏时写入，`preserveScroll` 到达该屏时读回——见 `docs/prototype-runtime.md` 第 7 节。
   */
  scrollMemory: Record<NodeId, ScrollOffset>;
}

export type PrototypeEvent =
  | { kind: "click"; nodeId: NodeId }
  /** 指针按下（先于 click 触发）。 */
  | { kind: "press"; nodeId: NodeId }
  /**
   * 指针进入节点：优先 `mouse-enter`，没有才用 `mouse-over`。
   *
   * 两者在运行时都只在**进入时触发一次**，而不是每帧触发——持续触发的 hover 动作
   * 会把「悬停打开 overlay」变成死循环。
   */
  | { kind: "hover-in"; nodeId: NodeId }
  | { kind: "hover-out"; nodeId: NodeId }
  | { kind: "after-delay"; nodeId: NodeId }
  /** 点在没有交互的空白处：如果最上层 overlay 允许，就关掉它。 */
  | { kind: "click-outside" }
  | { kind: "back" }
  /**
   * 滚动：宿主 id + 滚轮增量 + 该宿主当前的最大可滚动距离。
   *
   * 最大可滚动距离由宿主盒子的超出量算出来（要布局才知道），
   * 所以由调用方算好带进来，状态机只负责夹紧与累加。
   */
  | { kind: "scroll"; hostId: NodeId; deltaX: number; deltaY: number; maxX: number; maxY: number }
  | { kind: "animation-end"; transitionId: number };

export interface PrototypeResult {
  state: PrototypeState;
  /** 需要宿主执行的副作用：用系统浏览器打开外链。 */
  openUrl?: string;
}

/** 从某一屏开始预览。屏幕必须存在，否则抛错——静默显示空白比报错更难排查。 */
export function startPrototype(document: DesignDocument, screenId: NodeId): PrototypeState {
  if (!document.nodes[screenId]) throw new Error(`Prototype screen ${screenId} does not exist`);
  return { screenId, history: [], overlays: [], seq: 0, scroll: {}, scrollMemory: {} };
}

/** 节点自己身上的交互（不向上找）。 */
export function interactionsOf(document: DesignDocument, nodeId: NodeId, eventType: Interaction["eventType"]): Interaction[] {
  const node = document.nodes[nodeId];
  if (!node?.interactions?.length) return [];
  return node.interactions.filter(interaction => interaction.eventType === eventType);
}

/**
 * 从命中节点向上找第一条该事件的交互。
 *
 * 与 Figma 一致：子节点没有交互时，点击事件冒泡到父容器——所以按钮里的文字
 * 不需要自己再挂一条交互。
 */
export function resolveInteraction(document: DesignDocument, nodeId: NodeId, eventType: Interaction["eventType"]): { interaction: Interaction; triggerNodeId: NodeId } | undefined {
  let current: NodeId | undefined = nodeId;
  const visited = new Set<NodeId>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const found = interactionsOf(document, current, eventType)[0];
    if (found) return { interaction: found, triggerNodeId: current };
    current = document.nodes[current]?.parentId;
  }
  return undefined;
}

/** 页面 id：从节点沿 parentId 往上，直到某一层的 id 是页面。 */
export function findPageId(document: DesignDocument, nodeId: NodeId): string | undefined {
  let current: NodeId | undefined = nodeId;
  const visited = new Set<NodeId>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (document.pages[current]) return current;
    current = document.nodes[current]?.parentId;
  }
  return undefined;
}

/** 屏幕子树里的所有节点 id（含自身），供 after-delay 扫描与动画定位使用。 */
export function collectSubtreeIds(document: DesignDocument, rootId: NodeId): NodeId[] {
  const ids: NodeId[] = [];
  const walk = (id: NodeId) => {
    if (!document.nodes[id]) return;
    ids.push(id);
    for (const childId of document.nodes[id]!.childIds) walk(childId);
  };
  walk(rootId);
  return ids;
}

/** 屏幕树里所有 `after-delay` 交互（进入屏幕后要排的计时器）。 */
export function scheduledInteractions(document: DesignDocument, screenId: NodeId): Array<{ nodeId: NodeId; interaction: Interaction }> {
  const scheduled: Array<{ nodeId: NodeId; interaction: Interaction }> = [];
  for (const nodeId of collectSubtreeIds(document, screenId)) {
    for (const interaction of interactionsOf(document, nodeId, "after-delay")) scheduled.push({ nodeId, interaction });
  }
  return scheduled;
}

function nextTransition(state: PrototypeState, animation: PrototypeAnimation | undefined): PrototypeTransition {
  return { id: state.seq + 1, ...(animation ? { animation } : {}) };
}

/**
 * 把滚动偏移夹进 `[0, max]`。
 *
 * 内容比上次短时（换了屏、重新布局），旧位置可能已经越界——
 * 夹紧比停在一片空白上好。
 */
export function clampScroll(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(Math.max(value, 0), max);
}

/**
 * 离开当前屏、到达目标屏时的滚动处理。
 *
 * - **离开**：把当前屏各滚动宿主的偏移存进记忆（`scrollMemory`）；
 * - **到达**：`preserve` 为真就用记忆恢复（没有记忆就是 0），否则把目标屏
 *   各宿主的当前偏移直接清零。
 *
 * 记忆只在离开时写入，所以「到达时重置」不会顺手抹掉记忆——
 * 真正覆盖它的是下一次离开这一屏。
 */
function applyScrollOnEnter(
  state: PrototypeState,
  document: DesignDocument,
  target: NodeId,
  preserve: boolean,
): { scroll: Record<NodeId, ScrollOffset>; scrollMemory: Record<NodeId, ScrollOffset> } {
  const scrollMemory = { ...state.scrollMemory };
  for (const host of scrollHostsInSubtree(document, state.screenId)) {
    scrollMemory[host] = state.scroll[host] ?? { x: 0, y: 0 };
  }
  const scroll = { ...state.scroll };
  for (const host of scrollHostsInSubtree(document, target)) {
    scroll[host] = preserve ? (scrollMemory[host] ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
  }
  return { scroll, scrollMemory };
}

function navigate(state: PrototypeState, document: DesignDocument, interaction: Interaction): PrototypeState {
  const target = interaction.destination;
  if (!target) return state;
  const { scroll, scrollMemory } = applyScrollOnEnter(state, document, target, hasPreserveScroll(interaction));
  return {
    screenId: target,
    previousScreenId: state.screenId,
    history: [...state.history, state.screenId],
    overlays: [],
    transition: nextTransition(state, interaction.animation),
    seq: state.seq + 1,
    scroll,
    scrollMemory,
  };
}

function openOverlay(state: PrototypeState, interaction: Interaction, triggerNodeId: NodeId): PrototypeState {
  const target = interaction.destination;
  if (!target) return state;
  if (state.overlays.some(overlay => overlay.nodeId === target)) return state;
  return {
    ...state,
    overlays: [...state.overlays, { nodeId: target, interaction, triggerNodeId }],
  };
}

function closeOverlay(state: PrototypeState, target: NodeId | null | undefined): PrototypeState {
  if (!state.overlays.length) return state;
  if (target) return { ...state, overlays: state.overlays.filter(overlay => overlay.nodeId !== target) };
  return { ...state, overlays: state.overlays.slice(0, -1) };
}

function goBack(state: PrototypeState, document: DesignDocument): PrototypeState {
  if (!state.history.length) return state;
  const history = [...state.history];
  const screenId = history.pop()!;
  // 「返回」就是回到刚才待过的地方，所以按 keep（`preserveScroll: true`）处理。
  const { scroll, scrollMemory } = applyScrollOnEnter(state, document, screenId, true);
  return {
    screenId,
    previousScreenId: state.screenId,
    history,
    overlays: [],
    transition: nextTransition(state, undefined),
    seq: state.seq + 1,
    scroll,
    scrollMemory,
  };
}

/**
 * 推进状态机。
 *
 * 不合法或不存在的目标一律「什么都不做」：预览里的一次误点不应该把运行时打崩，
 * 也不应该把用户带到一片空白。
 */
export function dispatchPrototype(state: PrototypeState, document: DesignDocument, event: PrototypeEvent): PrototypeResult {
  switch (event.kind) {
    case "animation-end":
      if (!state.transition || state.transition.id !== event.transitionId) return { state };
      return { state: { ...state, previousScreenId: undefined, transition: undefined } };

    case "click-outside": {
      const top = state.overlays[state.overlays.length - 1];
      if (!top || top.interaction.closeClickOutside === false) return { state };
      return { state: closeOverlay(state, undefined) };
    }

    case "back":
      return { state: goBack(state, document) };

    case "scroll": {
      const current = state.scroll[event.hostId] ?? { x: 0, y: 0 };
      const next = {
        x: clampScroll(current.x + event.deltaX, event.maxX),
        y: clampScroll(current.y + event.deltaY, event.maxY),
      };
      // 已经在边界上：状态不变，省掉一次没意义的重绘。
      if (next.x === current.x && next.y === current.y) return { state };
      return { state: { ...state, scroll: { ...state.scroll, [event.hostId]: next } } };
    }

    case "click":
      return applyInteraction(state, document, resolveInteraction(document, event.nodeId, "click"));
    case "press":
      return applyInteraction(state, document, resolveInteraction(document, event.nodeId, "mouse-press"));
    case "hover-in":
      // enter 优先于 over：两者都是「进入时一次」，同时写时按更具体的语义走。
      return applyInteraction(state, document,
        resolveInteraction(document, event.nodeId, "mouse-enter") ?? resolveInteraction(document, event.nodeId, "mouse-over"));
    case "hover-out":
      return applyInteraction(state, document, resolveInteraction(document, event.nodeId, "mouse-leave"));
    case "after-delay":
      return applyInteraction(state, document, resolveInteraction(document, event.nodeId, "after-delay"));
  }
}

/**
 * 把一条已解析的交互作用到状态上。
 *
 * 事件解析（点击冒泡、hover 回退）与动作执行分开：新增事件类型时只改上半段，
 * 动作语义始终只有一份。
 */
function applyInteraction(
  state: PrototypeState,
  document: DesignDocument,
  resolved: ReturnType<typeof resolveInteraction>,
): PrototypeResult {
  if (!resolved) return { state };
  const { interaction, triggerNodeId } = resolved;
  switch (interaction.actionType) {
    case "navigate": {
      const target = interaction.destination;
      if (!target || !document.nodes[target]) return { state };
      return { state: navigate(state, document, interaction) };
    }
    case "open-overlay":
    case "toggle-overlay": {
      const target = interaction.destination;
      if (!target || !document.nodes[target]) return { state };
      if (interaction.actionType === "toggle-overlay" && state.overlays.some(overlay => overlay.nodeId === target)) {
        return { state: closeOverlay(state, target) };
      }
      return { state: openOverlay(state, interaction, triggerNodeId) };
    }
    case "close-overlay":
      return { state: closeOverlay(state, interaction.destination ?? undefined) };
    case "prev-screen":
      return { state: goBack(state, document) };
    case "open-url": {
      const url = interaction.url;
      if (!url) return { state };
      return { state, openUrl: url };
    }
    default:
      return { state };
  }
}

/** 当前应该渲染的层，从下到上。 */
export function prototypeLayers(state: PrototypeState): NodeId[] {
  const layers: NodeId[] = [];
  if (state.previousScreenId) layers.push(state.previousScreenId);
  layers.push(state.screenId);
  for (const overlay of state.overlays) layers.push(overlay.nodeId);
  return layers;
}

/** 某个节点是否属于 overlay（用于点击穿透判定）。 */
export function overlayOwner(state: PrototypeState, document: DesignDocument, nodeId: NodeId): PrototypeOverlay | undefined {
  for (const overlay of state.overlays) {
    if (collectSubtreeIds(document, overlay.nodeId).includes(nodeId)) return overlay;
  }
  return undefined;
}
