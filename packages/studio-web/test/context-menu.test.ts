import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";

/**
 * 画布右键菜单的回归测试。
 *
 * 浏览器自动化点不出 `contextmenu` 事件，所以这里用 jsdom 手动构造该事件，
 * 验证三件事：命中节点的判定、Radix 菜单的开关、以及菜单项到命令函数的接线。
 *
 * React 相关模块全部动态导入，确保它们在 jsdom 全局装好之后才被求值。
 */

let dom: JSDOM;
let container: HTMLElement;
let react: typeof import("react");
let menu: typeof import("../src/ui/context-menu");
let paint: (element: unknown) => void;
let teardown: () => void;

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
  // Radix 菜单依赖这些浏览器 API，jsdom 没有实现。
  scope.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  if (!window.Element.prototype.setPointerCapture) {
    window.Element.prototype.setPointerCapture = () => undefined;
    window.Element.prototype.releasePointerCapture = () => undefined;
    window.Element.prototype.hasPointerCapture = () => false;
  }
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => undefined;

  react = await import("react");
  const { createRoot } = await import("react-dom/client");
  menu = await import("../src/ui/context-menu");
  container = window.document.getElementById("root")!;
  const client = createRoot(container);
  paint = (element: unknown) => { react.act(() => { client.render(element); }); };
  teardown = () => { react.act(() => { client.unmount(); }); window.close(); };
});

after(() => teardown?.());

function dispatch(target: Element, type: string) {
  react.act(() => {
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
  });
}

function menuItems(): HTMLElement[] {
  return [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

function buildTree(props: { onSelect?: () => void; disabled?: boolean }) {
  const { ContextMenuRoot, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSub } = menu;
  return react.createElement(
    ContextMenuRoot,
    null,
    react.createElement(
      ContextMenuTrigger,
      null,
      react.createElement("button", { type: "button" }, "画布"),
    ),
    react.createElement(
      ContextMenuContent,
      null,
      react.createElement(ContextMenuItem, { icon: "copy", onSelect: props.onSelect }, "复制"),
      react.createElement(ContextMenuItem, { icon: "paste", disabled: props.disabled, onSelect: props.onSelect }, "粘贴"),
      react.createElement(
        ContextMenuSub,
        { label: "图层顺序", icon: "layerOrder" },
        react.createElement(ContextMenuItem, { icon: "toFront", onSelect: props.onSelect }, "置顶"),
      ),
    ),
  );
}

test("resolveContextNodeId returns the closest node id for a hit", () => {
  const node = dom.window.document.createElement("div");
  node.dataset.nodeId = "rectangle:1";
  const child = dom.window.document.createElement("span");
  node.append(child);
  assert.equal(menu.resolveContextNodeId(child), "rectangle:1");
});

test("resolveContextNodeId returns undefined on empty canvas", () => {
  const canvas = dom.window.document.createElement("div");
  assert.equal(menu.resolveContextNodeId(canvas), undefined);
});

test("resolveContextNodeId tolerates a target without closest", () => {
  assert.equal(menu.resolveContextNodeId({} as unknown as EventTarget), undefined);
  assert.equal(menu.resolveContextNodeId(null), undefined);
});

test("a contextmenu event opens the menu", () => {
  paint(buildTree({}));
  assert.equal(dom.window.document.querySelector('[role="menu"]'), null);
  dispatch(container.querySelector("button")!, "contextmenu");
  assert.ok(dom.window.document.querySelector('[role="menu"]'));
  assert.ok(menuItems().some(item => item.textContent === "复制"));
});

test("choosing an item invokes onSelect", () => {
  let calls = 0;
  paint(buildTree({ onSelect: () => { calls += 1; } }));
  dispatch(container.querySelector("button")!, "contextmenu");
  const copy = menuItems().find(item => item.textContent === "复制")!;
  dispatch(copy, "click");
  assert.equal(calls, 1);
});

test("a disabled item never invokes onSelect", () => {
  let calls = 0;
  paint(buildTree({ onSelect: () => { calls += 1; }, disabled: true }));
  dispatch(container.querySelector("button")!, "contextmenu");
  const paste = menuItems().find(item => item.textContent === "粘贴")!;
  dispatch(paste, "click");
  assert.equal(calls, 0);
});

test("a submenu opens on click and reports its items", () => {
  let calls = 0;
  paint(buildTree({ onSelect: () => { calls += 1; } }));
  dispatch(container.querySelector("button")!, "contextmenu");
  const trigger = menuItems().find(item => item.textContent?.includes("图层顺序"))!;
  dispatch(trigger, "click");
  const top = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "置顶");
  assert.ok(top);
  dispatch(top, "click");
  assert.equal(calls, 1);
});
