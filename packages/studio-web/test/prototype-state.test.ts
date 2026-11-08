import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode, type Interaction } from "@ufira/design-schema";
import {
  collectSubtreeIds,
  dispatchPrototype,
  findPageId,
  resolveInteraction,
  scheduledInteractions,
  startPrototype,
  type PrototypeState,
} from "../src/prototype/state";

function frame(id: string, parentId: string, extra: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 320, height: 200 },
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

function interaction(overrides: Partial<Interaction>): Interaction {
  return { eventType: "click", actionType: "navigate", ...overrides };
}

/**
 * 两个页面、三块屏幕：
 * home（按钮 → detail）、detail（按钮 → 回 home 的 overlay）、menu（overlay）。
 */
function prototypeDocument(): DesignDocument {
  const document = createDocument("doc:proto", "Proto", "page:1");
  document.pages["page:2"] = { id: "page:2", name: "Page 2", childIds: [] };
  document.pageOrder.push("page:2");

  const home = frame("screen:home", "page:1", { childIds: ["label"] });
  const label = frame("label", "screen:home", {
    childIds: ["label-text"],
    interactions: [interaction({ destination: "screen:detail" })],
  });
  const labelText = frame("label-text", "label");
  const openMenu = frame("open-menu", "screen:home", {
    interactions: [interaction({ actionType: "open-overlay", destination: "screen:menu", overlayPositionType: "center" })],
  });
  const detail = frame("screen:detail", "page:1");
  const menu = frame("screen:menu", "page:2", { childIds: ["menu-body"] });
  const menuBody = frame("menu-body", "screen:menu");
  const delayed = frame("screen:delayed", "page:1", {
    interactions: [interaction({ eventType: "after-delay", delay: 300, destination: "screen:detail" })],
  });
  const back = frame("back", "screen:detail", {
    interactions: [interaction({ actionType: "prev-screen" })],
  });
  const external = frame("external", "screen:home", {
    interactions: [interaction({ actionType: "open-url", url: "https://example.com" })],
  });
  const nestedBack = frame("nested-back", "label-text", {
    interactions: [interaction({ actionType: "navigate", destination: "screen:delayed" })],
  });

  const pressable = frame("pressable", "screen:home", {
    interactions: [interaction({ eventType: "mouse-press", destination: "screen:detail" })],
  });
  const hoverBoth = frame("hover-both", "screen:home", {
    interactions: [
      interaction({ eventType: "mouse-enter", destination: "screen:detail" }),
      interaction({ eventType: "mouse-over", destination: "screen:delayed" }),
    ],
  });
  const hoverOverOnly = frame("hover-over-only", "screen:home", {
    interactions: [interaction({ eventType: "mouse-over", destination: "screen:delayed" })],
  });
  const hoverLeave = frame("hover-leave", "screen:detail", {
    interactions: [interaction({ eventType: "mouse-leave", actionType: "close-overlay" })],
  });

  for (const node of [home, label, labelText, openMenu, detail, menu, menuBody, delayed, back, external, nestedBack, pressable, hoverBoth, hoverOverOnly, hoverLeave]) {
    document.nodes[node.id] = node;
  }
  document.pages["page:1"]!.childIds = ["screen:home", "screen:detail", "screen:delayed"];
  document.pages["page:2"]!.childIds = ["screen:menu"];
  home.childIds = ["label", "open-menu", "external", "pressable", "hover-both", "hover-over-only"];
  label.childIds = ["label-text"];
  labelText.childIds = ["nested-back"];
  detail.childIds = ["back", "hover-leave"];
  menu.childIds = ["menu-body"];
  return document;
}

test("starting a preview requires a real screen", () => {
  const document = prototypeDocument();
  assert.equal(startPrototype(document, "screen:home").screenId, "screen:home");
  assert.throws(() => startPrototype(document, "missing"), /does not exist/);
});

test("a click bubbles from a child up to the container with the interaction", () => {
  const document = prototypeDocument();
  let state = startPrototype(document, "screen:home");
  // 点击「label-text」的子孙：nested-back 自己有交互，优先它；换成普通子孙再点则冒泡。
  const result = dispatchPrototype(state, document, { kind: "click", nodeId: "label-text" });
  state = result.state;
  assert.equal(state.screenId, "screen:detail");
  assert.deepEqual(state.history, ["screen:home"]);
  assert.equal(state.previousScreenId, "screen:home");
  assert.equal(state.overlays.length, 0);
});

test("the deepest interaction wins over an ancestor's", () => {
  const document = prototypeDocument();
  const state = startPrototype(document, "screen:home");
  const nested = dispatchPrototype(state, document, { kind: "click", nodeId: "nested-back" });
  assert.equal(nested.state.screenId, "screen:delayed");
});

test("a click without an interaction, or with a missing destination, changes nothing", () => {
  const document = prototypeDocument();
  const state = startPrototype(document, "screen:detail");
  assert.deepEqual(dispatchPrototype(state, document, { kind: "click", nodeId: "screen:detail" }).state, state);

  document.nodes["broken"] = frame("broken", "screen:detail", {
    interactions: [interaction({ destination: "nowhere" })],
  });
  document.nodes["screen:detail"]!.childIds.push("broken");
  assert.deepEqual(dispatchPrototype(state, document, { kind: "click", nodeId: "broken" }).state, state);
});

test("navigate keeps the destination's animation for the UI layer", () => {
  const document = prototypeDocument();
  document.nodes["open-menu"]!.interactions = [interaction({
    destination: "screen:detail",
    animation: { type: "slide", duration: 240, easing: "ease-out", way: "in", direction: "left", offsetEffect: false },
  })];
  const state = dispatchPrototype(startPrototype(document, "screen:home"), document, { kind: "click", nodeId: "open-menu" }).state;
  assert.equal(state.transition?.animation?.type, "slide");
  assert.equal(state.transition?.id, 1);
  assert.equal(state.screenId, "screen:detail");
});

test("overlay actions open, toggle and close the destination", () => {
  const document = prototypeDocument();
  const state = startPrototype(document, "screen:home");
  const opened = dispatchPrototype(state, document, { kind: "click", nodeId: "open-menu" }).state;
  assert.deepEqual(opened.overlays.map(overlay => overlay.nodeId), ["screen:menu"]);
  assert.equal(opened.overlays[0]!.triggerNodeId, "open-menu");
  assert.equal(opened.screenId, "screen:home");

  // 重复 open 不会叠加同一个 overlay。
  const again = dispatchPrototype(opened, document, { kind: "click", nodeId: "open-menu" }).state;
  assert.equal(again.overlays.length, 1);

  // 再点一次 toggle-overlay 会关掉它。
  document.nodes["open-menu"]!.interactions = [interaction({ actionType: "toggle-overlay", destination: "screen:menu" })];
  const toggled = dispatchPrototype(opened, document, { kind: "click", nodeId: "open-menu" }).state;
  assert.equal(toggled.overlays.length, 0);
});

test("clicking outside closes the top overlay unless it opted out", () => {
  const document = prototypeDocument();
  const opened = dispatchPrototype(startPrototype(document, "screen:home"), document, { kind: "click", nodeId: "open-menu" }).state;
  assert.equal(dispatchPrototype(opened, document, { kind: "click-outside" }).state.overlays.length, 0);

  const persistent = { ...opened, overlays: opened.overlays.map(overlay => ({ ...overlay, interaction: { ...overlay.interaction, closeClickOutside: false } })) };
  assert.equal(dispatchPrototype(persistent, document, { kind: "click-outside" }).state.overlays.length, 1);
});

test("back and prev-screen pop the history", () => {
  const document = prototypeDocument();
  const navigated = dispatchPrototype(startPrototype(document, "screen:home"), document, { kind: "click", nodeId: "label-text" }).state;
  const back = dispatchPrototype(navigated, document, { kind: "back" }).state;
  assert.equal(back.screenId, "screen:home");
  assert.deepEqual(back.history, []);

  const viaAction = dispatchPrototype(navigated, document, { kind: "click", nodeId: "back" }).state;
  assert.equal(viaAction.screenId, "screen:home");
  // 已经在第一屏时返回什么都不做。
  assert.deepEqual(dispatchPrototype(back, document, { kind: "back" }).state, back);
});

test("open-url returns a side effect instead of mutating the state", () => {
  const document = prototypeDocument();
  const result = dispatchPrototype(startPrototype(document, "screen:home"), document, { kind: "click", nodeId: "external" });
  assert.equal(result.openUrl, "https://example.com");
  assert.equal(result.state.screenId, "screen:home");
});

test("animation-end only clears the matching transition", () => {
  const document = prototypeDocument();
  const navigated = dispatchPrototype(startPrototype(document, "screen:home"), document, { kind: "click", nodeId: "label-text" }).state;
  const stale = dispatchPrototype(navigated, document, { kind: "animation-end", transitionId: 99 }).state;
  assert.equal(stale.previousScreenId, "screen:home");

  const cleared = dispatchPrototype(navigated, document, { kind: "animation-end", transitionId: navigated.transition!.id }).state;
  assert.equal(cleared.previousScreenId, undefined);
  assert.equal(cleared.transition, undefined);
});

test("after-delay interactions are scheduled per screen", () => {
  const document = prototypeDocument();
  const scheduled = scheduledInteractions(document, "screen:delayed");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.nodeId, "screen:delayed");
  assert.equal(scheduled[0]!.interaction.delay, 300);

  const fired = dispatchPrototype(startPrototype(document, "screen:delayed"), document, { kind: "after-delay", nodeId: "screen:delayed" }).state;
  assert.equal(fired.screenId, "screen:detail");
});

test("helpers walk the tree and the parent chain", () => {
  const document = prototypeDocument();
  assert.equal(findPageId(document, "nested-back"), "page:1");
  assert.equal(findPageId(document, "menu-body"), "page:2");
  assert.deepEqual(collectSubtreeIds(document, "label").sort(), ["label", "label-text", "nested-back"]);
  assert.equal(resolveInteraction(document, "nested-back", "click")?.triggerNodeId, "nested-back");
  assert.equal(resolveInteraction(document, "screen:home", "click"), undefined);
});

test("prototype actions never mutate the input state", () => {
  const document = prototypeDocument();
  const state: PrototypeState = startPrototype(document, "screen:home");
  const snapshot = JSON.stringify(state);
  dispatchPrototype(state, document, { kind: "click", nodeId: "open-menu" });
  dispatchPrototype(state, document, { kind: "click", nodeId: "label-text" });
  assert.equal(JSON.stringify(state), snapshot);
});

test("mouse-press fires on pointer down, independently of click", () => {
  const document = prototypeDocument();
  const state = startPrototype(document, "screen:home");
  assert.equal(dispatchPrototype(state, document, { kind: "press", nodeId: "pressable" }).state.screenId, "screen:detail");
  // 只有 mouse-press 的节点点一下（click）不该有任何动作。
  assert.equal(dispatchPrototype(state, document, { kind: "click", nodeId: "pressable" }).state.screenId, "screen:home");
});

test("hover-in prefers mouse-enter and falls back to mouse-over", () => {
  const document = prototypeDocument();
  const state = startPrototype(document, "screen:home");
  assert.equal(dispatchPrototype(state, document, { kind: "hover-in", nodeId: "hover-both" }).state.screenId, "screen:detail");
  assert.equal(dispatchPrototype(state, document, { kind: "hover-in", nodeId: "hover-over-only" }).state.screenId, "screen:delayed");
  // 没有 hover 交互的节点：什么都不做。
  assert.equal(dispatchPrototype(state, document, { kind: "hover-in", nodeId: "screen:home" }).state.screenId, "screen:home");
});

test("hover-out triggers mouse-leave actions", () => {
  const document = prototypeDocument();
  const opened = dispatchPrototype(startPrototype(document, "screen:home"), document, { kind: "click", nodeId: "open-menu" }).state;
  assert.equal(opened.overlays.length, 1);
  const left = dispatchPrototype(opened, document, { kind: "hover-out", nodeId: "hover-leave" }).state;
  assert.equal(left.overlays.length, 0);
});