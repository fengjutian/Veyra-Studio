/**
 * 原型交互模型。
 *
 * 语义对齐自 Penpot 的 `common/src/app/common/types/shape/interactions.cljc`（MPL-2.0）。
 * 这里**只借鉴交互语义**（有哪些事件、哪些动作、哪些动画、overlay 怎么定位），
 * 不复制其数据结构与代码表达。详见 `docs/penpot-porting.md`。
 *
 * ## 为什么需要这一层
 *
 * 这是本项目与 Figma / Penpot 差距最大、此前完全空缺的一块。
 * 交互模型是**数据**——事件、动作、动画、overlay 定位；
 * 运行时（预览模式、状态机、跳转执行）是另一件事，不在这一层。
 *
 * ## 一条必须照搬的语义：切换类型时旧字段不删除
 *
 * Penpot 在源码里明确注释了这一点：切换事件或动作类型时**不清掉**不属于新类型的字段，
 * 这样用户把类型切回来时还能恢复原值。
 *
 * 代价是：一条交互里可能同时残留着 `delay`（当前类型不用）、`url`（当前类型不用）、
 * `destination`（当前类型不用）等等。
 *
 * 因此**读取字段必须先问「当前类型用得上吗」**，不能直接读。
 * 本项目用 `hasDelay()` / `hasDestination()` / `hasOverlayPosition()` 这类判定函数表达这一点，
 * 调用方一律走这些函数，不要直接读可选字段。
 */

import type { NodeId } from "./types";

/** 触发交互的事件。 */
export type InteractionEventType =
  | "click"
  | "mouse-press"
  | "mouse-over"
  | "mouse-enter"
  | "mouse-leave"
  | "after-delay";

/** 交互触发的动作。 */
export type InteractionActionType =
  | "navigate"
  | "open-overlay"
  | "toggle-overlay"
  | "close-overlay"
  | "prev-screen"
  | "open-url";

/** Overlay 的定位方式。 */
export type OverlayPositionType =
  | "manual"
  | "center"
  | "top-left"
  | "top-right"
  | "top-center"
  | "bottom-left"
  | "bottom-right"
  | "bottom-center";

/** 缓动函数。 */
export type EasingType = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";

/** 动画方向。 */
export type AnimationDirection = "right" | "left" | "up" | "down";

/** 动画的进入/离开方式。 */
export type AnimationWay = "in" | "out";

/** 动画类型。 */
export type AnimationType = "dissolve" | "slide" | "push";

/** 渐变淡入淡出。 */
export interface DissolveAnimation {
  type: "dissolve";
  /** 时长（ms）。 */
  duration: number;
  easing: EasingType;
  way?: AnimationWay;
  /** 淡入淡出时带位移。 */
  offsetEffect?: boolean;
  direction?: AnimationDirection;
}

/** 滑动。 */
export interface SlideAnimation {
  type: "slide";
  duration: number;
  easing: EasingType;
  way: AnimationWay;
  direction: AnimationDirection;
  offsetEffect: boolean;
}

/** 推入。 */
export interface PushAnimation {
  type: "push";
  duration: number;
  easing: EasingType;
  direction: AnimationDirection;
}

export type PrototypeAnimation = DissolveAnimation | SlideAnimation | PushAnimation;

/** overlay 的定位信息。 */
export interface OverlayPosition {
  /** 手动定位时的偏移（相对定位基准）。 */
  x: number;
  y: number;
}

/**
 * 一条交互。
 *
 * 字段大多是可选的——**不是因为「可省略」，而是因为「切换类型后残留」**。
 * 见文件头说明：读字段一律走 `hasDelay()` 等判定函数。
 */
export interface Interaction {
  eventType: InteractionEventType;
  actionType: InteractionActionType;

  /** 延迟触发时长（ms）。仅 `after-delay` 事件有意义。 */
  delay?: number;
  /** 跳转目标节点。 */
  destination?: NodeId | null;
  /** 跳转时保持滚动位置。 */
  preserveScroll?: boolean;
  /** 外部链接（`open-url` 动作）。 */
  url?: string;
  /** overlay 的定位类型。 */
  overlayPositionType?: OverlayPositionType;
  /** overlay 的手动定位偏移。 */
  overlayPosition?: OverlayPosition;
  /** 点击 overlay 外部是否关闭。 */
  closeClickOutside?: boolean;
  /** overlay 背景是否可见。 */
  backgroundOverlay?: boolean;
  /** overlay 相对于哪个节点定位（缺省相对触发节点）。 */
  positionRelativeTo?: NodeId | null;
  /** 过渡动画。 */
  animation?: PrototypeAnimation;
}

/** `after-delay` 的缺省延迟（ms）。 */
export const DEFAULT_INTERACTION_DELAY = 600;

/** 缺省交互：点击后跳转。 */
export function defaultInteraction(): Interaction {
  return {
    eventType: "click",
    actionType: "navigate",
    destination: null,
    positionRelativeTo: null,
    preserveScroll: false,
  };
}

/** 该事件类型是否需要延迟字段。 */
export function hasDelay(interaction: Interaction): boolean {
  return interaction?.eventType === "after-delay";
}

/** 该动作类型是否可以有跳转目标。 */
export function hasDestination(interaction: Interaction): boolean {
  const actionType = interaction?.actionType;
  return (
    actionType === "navigate" ||
    actionType === "open-overlay" ||
    actionType === "toggle-overlay" ||
    actionType === "close-overlay"
  );
}

/** 该动作类型是否可以设置 overlay 定位。 */
export function hasOverlayPosition(interaction: Interaction): boolean {
  const actionType = interaction?.actionType;
  return actionType === "open-overlay" || actionType === "toggle-overlay";
}

/** 该动作类型是否可以设置外部链接。 */
export function hasUrl(interaction: Interaction): boolean {
  return interaction?.actionType === "open-url";
}

/**
 * 事件类型对节点类型是否合法。
 *
 * `after-delay` 只对 frame 合法——延迟触发意味着「进入这个页面后等一会儿」，
 * 只有作为容器的 frame 才有这个语义。
 */
export function isEventTypeAllowedForNode(eventType: InteractionEventType, nodeType: string): boolean {
  if (eventType === "after-delay") return nodeType === "frame";
  return true;
}

/**
 * 切换事件类型。
 *
 * 保留其余字段（见文件头说明），只替换 `eventType`；
 * 切到 `after-delay` 时补上缺省延迟。
 */
export function withEventType(interaction: Interaction, eventType: InteractionEventType, nodeType?: string): Interaction {
  if (nodeType !== undefined && !isEventTypeAllowedForNode(eventType, nodeType)) {
    throw new Error(`event type "${eventType}" is not allowed for node type "${nodeType}"`);
  }
  if (interaction.eventType === eventType) return interaction;
  if (eventType === "after-delay") {
    return { ...interaction, eventType, delay: interaction.delay ?? DEFAULT_INTERACTION_DELAY };
  }
  return { ...interaction, eventType };
}

/**
 * 切换动作类型。
 *
 * 同样保留其余字段，让用户切回来时能恢复原值。
 * 切到 `open-url` 时补上缺省空串（URL 是必填字段）。
 *
 * **动画会被重新判定**：新动作类型不允许的动画必须被清掉
 * （`slide`/`push` 只对 `navigate` 有意义）。Penpot 的 `set-action-type`
 * 同样会在这一步清掉不再适用的动画——否则一条 overlay 交互会带着
 * 一条永远不会被执行的 slide 动画。
 */
export function withActionType(interaction: Interaction, actionType: InteractionActionType): Interaction {
  if (interaction.actionType === actionType) return interaction;

  const next: Interaction = (() => {
    switch (actionType) {
      case "navigate":
        return {
          ...interaction,
          actionType,
          destination: interaction.destination ?? null,
          preserveScroll: interaction.preserveScroll ?? false,
        };
      case "open-overlay":
      case "toggle-overlay":
        return {
          ...interaction,
          actionType,
          overlayPositionType: interaction.overlayPositionType ?? "center",
          overlayPosition: interaction.overlayPosition ?? { x: 0, y: 0 },
        };
      case "close-overlay":
        return { ...interaction, actionType, destination: interaction.destination ?? null };
      case "prev-screen":
        return { ...interaction, actionType };
      case "open-url":
        return { ...interaction, actionType, url: interaction.url ?? "" };
    }
  })();

  if (next.animation && !isAnimationAllowedForAction(actionType, next.animation.type)) {
    const { animation: _removed, ...rest } = next;
    return rest;
  }
  return next;
}

/**
 * 动画类型是否与动作类型匹配。
 *
 * `slide` / `push` 是「两个屏幕之间」的动画，只对 `navigate` 有意义；
 * `dissolve`（淡入淡出）可以对 overlay 使用。
 */
export function isAnimationAllowedForAction(actionType: InteractionActionType, animationType: AnimationType): boolean {
  if (animationType === "dissolve") return true;
  if (animationType === "slide" || animationType === "push") return actionType === "navigate";
  return false;
}

/** 设置动画；动作类型不允许时丢弃动画。 */
export function withAnimation(interaction: Interaction, animation: PrototypeAnimation | undefined): Interaction {
  if (!animation) {
    const { animation: _removed, ...rest } = interaction;
    return rest;
  }
  if (!isAnimationAllowedForAction(interaction.actionType, animation.type)) {
    const { animation: _removed, ...rest } = interaction;
    return rest;
  }
  return { ...interaction, animation };
}

/** 设置延迟；事件类型不是 `after-delay` 时忽略。 */
export function withDelay(interaction: Interaction, delay: number): Interaction {
  if (!hasDelay(interaction)) return interaction;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error(`invalid interaction delay: ${delay}`);
  }
  return { ...interaction, delay };
}

/**
 * 校验一条交互是否自洽。
 *
 * 返回问题描述列表，空数组表示通过。
 *
 * **这个函数在运行时命令分发路径上**（`interaction.patch` → `applyCommand`），
 * 所以它必须对畸形输入**只返回问题、不抛异常**——抛出的异常会以
 * `TypeError` 的形式冒出命令层，调用方分不清是「交互不合法」还是「代码坏了」。
 * 因此所有读取都先做类型守卫。
 */
export function validateInteraction(interaction: Interaction, nodeType?: string): string[] {
  const problems: string[] = [];

  if (!interaction || typeof interaction !== "object") {
    problems.push("interaction must be an object");
    return problems;
  }

  // 事件与动作是必填的：没有它们这条交互什么都不会发生。
  // 缺字段时各个 `has*` 判定都会返回 false，问题列表会是空的——
  // 那样「校验通过」会被误读成「这条交互有效」。
  if (!interaction.eventType) {
    problems.push("interaction requires an eventType");
  }
  if (!interaction.actionType) {
    problems.push("interaction requires an actionType");
  }

  if (nodeType !== undefined && !isEventTypeAllowedForNode(interaction.eventType, nodeType)) {
    problems.push(`event type "${interaction.eventType}" is not allowed for node type "${nodeType}"`);
  }

  if (hasDelay(interaction)) {
    if (interaction.delay === undefined || !Number.isFinite(interaction.delay) || interaction.delay < 0) {
      problems.push("after-delay interaction requires a non-negative delay");
    }
  }

  if (hasUrl(interaction) && !interaction.url) {
    problems.push("open-url interaction requires a url");
  }

  if (interaction.animation && !isAnimationAllowedForAction(interaction.actionType, interaction.animation.type)) {
    problems.push(`animation "${interaction.animation.type}" is not allowed for action "${interaction.actionType}"`);
  }

  if (hasDestination(interaction) && !interaction.destination) {
    problems.push(`action "${interaction.actionType}" requires a destination`);
  }

  return problems;
}
