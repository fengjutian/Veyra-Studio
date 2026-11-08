import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTERACTION_DELAY,
  defaultInteraction,
  hasDelay,
  hasDestination,
  hasOverlayPosition,
  hasUrl,
  isAnimationAllowedForAction,
  isEventTypeAllowedForNode,
  validateInteraction,
  withActionType,
  withAnimation,
  withDelay,
  withEventType,
  type Interaction,
} from "../src/interactions";

/**
 * 原型交互模型的用例。
 *
 * 语义对齐 Penpot 的 `types/shape/interactions.cljc`，见 `docs/penpot-porting.md`。
 * 重点覆盖 Penpot 明确注释过的那个坑：**切换类型时旧字段不删除**。
 */

test("default: 缺省交互是点击后跳转", () => {
  const interaction = defaultInteraction();
  assert.equal(interaction.eventType, "click");
  assert.equal(interaction.actionType, "navigate");
  assert.equal(interaction.destination, null);
  assert.equal(interaction.preserveScroll, false);
});

test("hasDelay: 只有 after-delay 事件才算有延迟", () => {
  assert.equal(hasDelay({ eventType: "after-delay", actionType: "navigate" }), true);
  assert.equal(hasDelay({ eventType: "click", actionType: "navigate" }), false);
});

test("hasDestination: 只有能跳转的动作才算有目标", () => {
  assert.equal(hasDestination({ eventType: "click", actionType: "navigate" }), true);
  assert.equal(hasDestination({ eventType: "click", actionType: "open-overlay" }), true);
  assert.equal(hasDestination({ eventType: "click", actionType: "prev-screen" }), false);
  assert.equal(hasDestination({ eventType: "click", actionType: "open-url" }), false);
});

test("hasOverlayPosition / hasUrl: 按动作类型区分", () => {
  assert.equal(hasOverlayPosition({ eventType: "click", actionType: "open-overlay" }), true);
  assert.equal(hasOverlayPosition({ eventType: "click", actionType: "toggle-overlay" }), true);
  assert.equal(hasOverlayPosition({ eventType: "click", actionType: "navigate" }), false);
  assert.equal(hasUrl({ eventType: "click", actionType: "open-url" }), true);
  assert.equal(hasUrl({ eventType: "click", actionType: "navigate" }), false);
});

test("事件类型: after-delay 只对 frame 合法", () => {
  assert.equal(isEventTypeAllowedForNode("after-delay", "frame"), true);
  assert.equal(isEventTypeAllowedForNode("after-delay", "rectangle"), false);
  assert.equal(isEventTypeAllowedForNode("after-delay", "text"), false);
  assert.equal(isEventTypeAllowedForNode("click", "rectangle"), true);
});

test("切换事件类型: 保留其它字段（Penpot 的关键语义）", () => {
  const original: Interaction = {
    eventType: "click",
    actionType: "navigate",
    destination: "node-1",
    delay: 1200,
    url: "https://example.com",
  };
  const switched = withEventType(original, "mouse-over");
  // 旧字段必须还在——用户切回来时能恢复原值。
  assert.equal(switched.eventType, "mouse-over");
  assert.equal(switched.destination, "node-1");
  assert.equal(switched.delay, 1200);
  assert.equal(switched.url, "https://example.com");
});

test("切换到 after-delay: 补上缺省延迟", () => {
  const switched = withEventType({ eventType: "click", actionType: "navigate" }, "after-delay");
  assert.equal(switched.delay, DEFAULT_INTERACTION_DELAY);
});

test("切换事件类型到非法组合时抛错", () => {
  assert.throws(
    () => withEventType({ eventType: "click", actionType: "navigate" }, "after-delay", "rectangle"),
    /not allowed/,
  );
});

test("切换动作类型: 保留旧字段并补齐新类型需要的字段", () => {
  const original: Interaction = {
    eventType: "click",
    actionType: "navigate",
    destination: "node-1",
    preserveScroll: true,
  };
  const switched = withActionType(original, "open-overlay");
  assert.equal(switched.actionType, "open-overlay");
  // 旧字段仍在。
  assert.equal(switched.destination, "node-1");
  assert.equal(switched.preserveScroll, true);
  // 新类型需要的字段被补上。
  assert.equal(switched.overlayPositionType, "center");
  assert.deepEqual(switched.overlayPosition, { x: 0, y: 0 });
});

test("切换到 open-url: 补上空串作为缺省链接", () => {
  const switched = withActionType({ eventType: "click", actionType: "navigate" }, "open-url");
  assert.equal(switched.url, "");
});

test("动画: slide/push 只对 navigate 合法", () => {
  assert.equal(isAnimationAllowedForAction("navigate", "slide"), true);
  assert.equal(isAnimationAllowedForAction("navigate", "push"), true);
  assert.equal(isAnimationAllowedForAction("navigate", "dissolve"), true);
  assert.equal(isAnimationAllowedForAction("open-overlay", "slide"), false);
  assert.equal(isAnimationAllowedForAction("open-overlay", "push"), false);
  // dissolve 是淡入淡出，对 overlay 也有意义。
  assert.equal(isAnimationAllowedForAction("open-overlay", "dissolve"), true);
});

test("设置不允许的动画时动画被丢弃", () => {
  const withSlide = withAnimation(
    { eventType: "click", actionType: "navigate" },
    { type: "slide", duration: 300, easing: "ease", way: "in", direction: "right", offsetEffect: false },
  );
  assert.ok(withSlide.animation);

  const switched = withActionType(withSlide, "open-overlay");
  // 换成 overlay 后 slide 不再合法，动画必须被清掉。
  assert.equal(switched.animation, undefined);
});

test("设置延迟: 事件类型不是 after-delay 时忽略", () => {
  const click = withDelay({ eventType: "click", actionType: "navigate" }, 500);
  assert.equal(click.delay, undefined);

  const delayed = withDelay({ eventType: "after-delay", actionType: "navigate" }, 500);
  assert.equal(delayed.delay, 500);
});

test("设置负延迟抛错", () => {
  assert.throws(() => withDelay({ eventType: "after-delay", actionType: "navigate" }, -1), /invalid interaction delay/);
});

test("校验: 报出每一条不自洽之处", () => {
  const problems = validateInteraction({ eventType: "after-delay", actionType: "navigate" });
  assert.ok(problems.some((problem) => problem.includes("delay")));

  const urlProblems = validateInteraction({ eventType: "click", actionType: "open-url" });
  assert.ok(urlProblems.some((problem) => problem.includes("url")));

  const destinationProblems = validateInteraction({ eventType: "click", actionType: "navigate" });
  assert.ok(destinationProblems.some((problem) => problem.includes("destination")));

  const nodeTypeProblems = validateInteraction(
    { eventType: "after-delay", actionType: "navigate", delay: 100, destination: "n1" },
    "rectangle",
  );
  assert.ok(nodeTypeProblems.some((problem) => problem.includes("not allowed for node type")));

  assert.deepEqual(
    validateInteraction({
      eventType: "click",
      actionType: "navigate",
      destination: "node-1",
    }),
    [],
  );
});

test("校验: 畸形输入只返回问题、不抛异常", () => {
  // 这个函数在运行时命令分发路径上，抛异常会以 TypeError 的形式冒出命令层，
  // 调用方分不清是「交互不合法」还是「代码坏了」。
  assert.doesNotThrow(() => validateInteraction(undefined as never));
  assert.doesNotThrow(() => validateInteraction(null as never));
  assert.doesNotThrow(() => validateInteraction({} as never));
  assert.ok(validateInteraction(undefined as never).length > 0);
  assert.ok(validateInteraction({} as never).length > 0);
});
