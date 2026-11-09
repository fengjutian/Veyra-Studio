import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  hasPreserveScroll,
  validateInteraction,
  type DesignDocument,
  type DesignNode,
  type Interaction,
} from "@ufira/design-schema";
import type { ProjectRepository } from "@ufira/design-persistence";
import { applyScrollToScene, buildTranslatedScene, computeScrollMax, scrollHostsInSubtree } from "../src/prototype/scene-build";
import { clampScroll, dispatchPrototype, startPrototype } from "../src/prototype/state";

/**
 * 原型运行时的滚动测试。
 *
 * 覆盖两件事：
 * 1. **滚动保持**——离开一屏时记住位置，`preserveScroll` 到达时恢复，否则重置为 0；
 * 2. **滚动容器**——滚轮在容器内容上滚动，超出部分裁切，偏移夹紧在 `[0, maxScroll]`。
 *
 * 前半部分是纯逻辑（Node 里就能跑），后半部分用 jsdom 起真的预览：
 * 滚轮事件进去，画布上内容的绘制坐标随之平移。
 */

/** 造一个 frame 节点；`overflow` 是可选文档字段（还没进 schema，见交付报告）。 */
function frame(
  id: string,
  parentId: string,
  options: {
    childIds?: string[];
    interactions?: Interaction[];
    overflow?: "visible" | "hidden" | "scroll";
    layout?: { x?: number; y?: number; width?: number; height?: number };
    fill?: string;
  } = {},
): DesignNode {
  const node = {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: options.childIds ?? [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 300, height: 200, ...options.layout },
    appearance: {
      ...defaultAppearance(),
      ...(options.fill ? { fills: [{ type: "solid" as const, color: options.fill }] } : {}),
    },
    ...(options.interactions ? { interactions: options.interactions } : {}),
  } as DesignNode;
  if (options.overflow) (node as { overflow?: string }).overflow = options.overflow;
  return node;
}

function navigateTo(destination: string, preserveScroll?: boolean): Interaction {
  return {
    eventType: "click",
    actionType: "navigate",
    destination,
    ...(preserveScroll === undefined ? {} : { preserveScroll }),
  };
}

/**
 * 两屏 + 一个滚动容器：
 *
 * ```
 * screen (300×200)          ← 顶层 frame，永远是滚动宿主
 *   tall   (300×600)         ← 直接子节点，超出 400px
 *   panel  (200×100, overflow: "scroll")
 *     content (200×400)      ← 超出 panel 300px
 *   link   (100×20) → other  ← navigate 交互
 * other  (300×200)
 *   back-link (100×20) → screen
 * ```
 */
function scrollDocument(): DesignDocument {
  const document = createDocument("doc:scroll", "Scroll", "page:1");
  const screen = frame("screen", "page:1", { childIds: ["tall", "panel", "link"], layout: { width: 300, height: 200 } });
  const tall = frame("tall", "screen", { layout: { width: 300, height: 600 } });
  const panel = frame("panel", "screen", { childIds: ["content"], overflow: "scroll", layout: { width: 200, height: 100 } });
  const content = frame("content", "panel", { layout: { width: 200, height: 400 }, fill: "#ff0000" });
  const link = frame("link", "screen", { interactions: [navigateTo("other")], layout: { width: 100, height: 20 } });
  const other = frame("other", "page:1", { childIds: ["back-link"], layout: { width: 300, height: 200 } });
  const backLink = frame("back-link", "other", { interactions: [navigateTo("screen")], layout: { width: 100, height: 20 } });
  for (const node of [screen, tall, panel, content, link, other, backLink]) document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = ["screen", "other"];
  return document;
}

/** 布局结果（页面坐标）。测试里手写，避免依赖布局引擎的具体数值。 */
const boxes = {
  screen: { x: 0, y: 0, width: 300, height: 200 },
  tall: { x: 0, y: 0, width: 300, height: 600 },
  panel: { x: 0, y: 0, width: 200, height: 100 },
  content: { x: 0, y: 0, width: 200, height: 400 },
  link: { x: 0, y: 180, width: 100, height: 20 },
  other: { x: 0, y: 0, width: 300, height: 200 },
  "back-link": { x: 0, y: 180, width: 100, height: 20 },
};

test("滚动偏移夹紧在 [0, maxScroll]，不会滚成负数或越界", () => {
  const document = scrollDocument();
  let state = startPrototype(document, "screen");

  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 120, maxX: 0, maxY: 400 }).state;
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 120 });

  // 往上滚：夹在 0，不会变成负数。
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: -999, maxX: 0, maxY: 400 }).state;
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 0 });

  // 往下滚过头：夹在 maxScroll。
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 9999, maxX: 0, maxY: 400 }).state;
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 400 });

  // 已经在边界上时状态不变（不产生多余的绘）。
  const settled = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 9999, maxX: 0, maxY: 400 }).state;
  assert.equal(settled, state);
});

test("clampScroll 把越界的值收进 [0, max]", () => {
  assert.equal(clampScroll(-10, 100), 0);
  assert.equal(clampScroll(50, 100), 50);
  assert.equal(clampScroll(150, 100), 100);
  assert.equal(clampScroll(10, 0), 0);
  assert.equal(clampScroll(Number.NaN, 100), 0);
});

test("离开一屏时把滚动位置存进记忆", () => {
  const document = scrollDocument();
  let state = startPrototype(document, "screen");
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 120, maxX: 0, maxY: 400 }).state;
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 120 });

  state = dispatchPrototype(state, document, { kind: "click", nodeId: "link" }).state;
  assert.equal(state.screenId, "other");
  assert.deepEqual(state.scrollMemory["screen"], { x: 0, y: 120 });
});

test("preserveScroll 到达时恢复记住的位置", () => {
  const document = scrollDocument();
  let state = startPrototype(document, "screen");
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 120, maxX: 0, maxY: 400 }).state;
  state = dispatchPrototype(state, document, { kind: "click", nodeId: "link" }).state;

  document.nodes["back-link"]!.interactions = [navigateTo("screen", true)];
  state = dispatchPrototype(state, document, { kind: "click", nodeId: "back-link" }).state;
  assert.equal(state.screenId, "screen");
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 120 });
});

test("不保留滚动位置时到达目标屏重置为 0", () => {
  const document = scrollDocument();
  let state = startPrototype(document, "screen");
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 120, maxX: 0, maxY: 400 }).state;
  state = dispatchPrototype(state, document, { kind: "click", nodeId: "link" }).state;

  // 显式 false：重置。
  document.nodes["back-link"]!.interactions = [navigateTo("screen", false)];
  state = dispatchPrototype(state, document, { kind: "click", nodeId: "back-link" }).state;
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 0 });

  // 缺省（字段没写）：同样重置。
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 120, maxX: 0, maxY: 400 }).state;
  state = dispatchPrototype(state, document, { kind: "click", nodeId: "back-link" }).state;
  assert.equal(state.screenId, "screen");
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 0 });
});

test("返回上一屏时恢复当时记住的位置", () => {
  const document = scrollDocument();
  let state = startPrototype(document, "screen");
  state = dispatchPrototype(state, document, { kind: "scroll", hostId: "screen", deltaX: 0, deltaY: 120, maxX: 0, maxY: 400 }).state;
  state = dispatchPrototype(state, document, { kind: "click", nodeId: "link" }).state;

  state = dispatchPrototype(state, document, { kind: "back" }).state;
  assert.equal(state.screenId, "screen");
  assert.deepEqual(state.scroll["screen"], { x: 0, y: 120 });
});

test("滚动宿主：顶层 frame 永远算，容器要显式声明 overflow: scroll", () => {
  const document = scrollDocument();
  assert.deepEqual(scrollHostsInSubtree(document, "screen"), ["screen", "panel"]);
  assert.deepEqual(scrollHostsInSubtree(document, "other"), ["other"]);

  // 显式声明 hidden 的顶层 frame 不再是宿主。
  document.nodes["other"] = frame("other", "page:1", { childIds: ["back-link"], overflow: "hidden" });
  assert.deepEqual(scrollHostsInSubtree(document, "other"), []);
});

test("最大可滚动距离按子节点相对宿主盒子的超出量算", () => {
  const document = scrollDocument();
  assert.deepEqual(computeScrollMax(document, boxes, "screen"), { x: 0, y: 400 });
  assert.deepEqual(computeScrollMax(document, boxes, "panel"), { x: 0, y: 300 });
  // 内容没超出 → 滚不动。
  assert.deepEqual(computeScrollMax(document, boxes, "other"), { x: 0, y: 0 });
});

test("滚动偏移把宿主的内容平移，宿主自己不动", () => {
  const document = scrollDocument();
  const scene = buildTranslatedScene(document, "panel", boxes, 0, 0)!;
  assert.deepEqual(scene.box, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(scene.children[0]!.box, { x: 0, y: 0, width: 200, height: 400 });

  const scrolled = applyScrollToScene(scene, { panel: { x: 0, y: 100 } });
  assert.deepEqual(scrolled.box, { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(scrolled.children[0]!.box, { x: 0, y: -100, width: 200, height: 400 });
});

test("overflow: visible 的容器不裁切子节点，其余照常裁切", () => {
  const document = scrollDocument();
  assert.equal(buildTranslatedScene(document, "panel", boxes, 0, 0)!.clip, true, "默认与 scroll 都裁切");

  document.nodes["panel"] = frame("panel", "screen", { childIds: ["content"], overflow: "visible", layout: { width: 200, height: 100 } });
  assert.equal(buildTranslatedScene(document, "panel", boxes, 0, 0)!.clip, false, "visible 不裁切");
});

test("preserveScroll 只在 navigate 上生效，其它动作上的残留字段被忽略", () => {
  assert.equal(hasPreserveScroll({ eventType: "click", actionType: "navigate", preserveScroll: true }), true);
  assert.equal(hasPreserveScroll({ eventType: "click", actionType: "navigate", preserveScroll: false }), false);
  assert.equal(hasPreserveScroll({ eventType: "click", actionType: "navigate" }), false);
  assert.equal(hasPreserveScroll({ eventType: "click", actionType: "open-overlay", preserveScroll: true }), false);
});

test("校验会挑出形状不对的 preserveScroll", () => {
  assert.deepEqual(validateInteraction({ eventType: "click", actionType: "navigate", destination: "x", preserveScroll: true }), []);
  const problems = validateInteraction({ eventType: "click", actionType: "navigate", destination: "x", preserveScroll: "yes" } as never);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /preserveScroll/);
});

// ---------------------------------------------------------------------------
// jsdom：真的起一个预览，滚轮事件进去，画布上的内容随之平移。
// ---------------------------------------------------------------------------

interface DrawCall {
  method: string;
  args: number[];
}

let dom: JSDOM;
let react: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let PrototypePreview: typeof import("../src/prototype/preview").PrototypePreview;
let recorded: DrawCall[] = [];
let teardown: () => void;

/** 记下画布上每一次几何调用，用来断言内容被平移了多少。 */
function mockContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    canvas,
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  };
  return new Proxy(target, {
    get(t, prop: string) {
      if (prop in t) return t[prop];
      // 没登记的方法一律空操作，但把参数记下来（几何调用才是断言的对象）。
      return (...args: unknown[]) => {
        recorded.push({ method: prop, args: args.filter((value): value is number => typeof value === "number") });
      };
    },
    set(t, prop: string, value: unknown) {
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

before(async () => {
  dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });
  const { window } = dom;
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window = window;
  scope.document = window.document;
  scope.HTMLElement = window.HTMLElement;
  scope.Element = window.Element;
  scope.Node = window.Node;
  scope.Event = window.Event;
  scope.WheelEvent = window.WheelEvent;
  scope.MouseEvent = window.MouseEvent;
  scope.KeyboardEvent = window.KeyboardEvent;
  scope.CustomEvent = window.CustomEvent;
  scope.DOMRect = window.DOMRect;
  scope.DOMRectReadOnly = window.DOMRectReadOnly;
  scope.MutationObserver = window.MutationObserver;
  scope.IntersectionObserver = window.IntersectionObserver;
  scope.getComputedStyle = window.getComputedStyle.bind(window);
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  scope.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });

  // jsdom 没有真正的 Canvas 2D：塞一个会记账的假上下文。
  window.HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    return mockContext(this);
  } as unknown as HTMLCanvasElement["getContext"];

  react = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ PrototypePreview } = await import("../src/prototype/preview"));
  teardown = () => { window.close(); };
});

after(() => teardown?.());

test("预览里滚轮滚动的是容器内容，超出部分被裁切", () => {
  const document = scrollDocument();
  const container = dom.window.document.getElementById("root")!;
  const client = createRoot(container);
  react.act(() => {
    client.render(react.createElement(PrototypePreview, {
      document,
      repository: {} as unknown as ProjectRepository,
      projectId: "project:1",
      startScreenId: "screen",
      onExit: () => undefined,
    }));
  });

  const stage = container.querySelector(".prototype-stage");
  assert.ok(stage, "预览舞台应该渲染出来");

  /** 内容（200×400）被画在哪。 */
  const contentRects = () => recorded.filter(call => call.method === "rect" && call.args[2] === 200 && call.args[3] === 400);

  recorded = [];
  react.act(() => {
    stage!.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: 100, clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
  });

  const rects = contentRects();
  assert.equal(rects.length, 1, "内容应该被画一次");
  assert.equal(rects[0]!.args[0], 0);
  assert.equal(rects[0]!.args[1], -100, "滚了 100px，内容应该向上平移 100px");

  // 容器本身不动：它的盒子还是 (0,0,200,100)。
  const panelRects = recorded.filter(call => call.method === "rect" && call.args[2] === 200 && call.args[3] === 100);
  assert.ok(panelRects.length > 0);
  assert.deepEqual(panelRects[0]!.args.slice(0, 2), [0, 0]);

  react.act(() => { client.unmount(); });
});
