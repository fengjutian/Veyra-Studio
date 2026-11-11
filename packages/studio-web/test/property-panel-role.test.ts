import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import { defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";

/**
 * 属性面板的「角色」小节。
 *
 * 角色是同一组件集里「同一个东西」的稳定标识：切换变体时覆盖按角色迁移，
 * 两个变体结构不一样也能对上（见 `docs/component-properties.md`）。
 */

let dom: JSDOM;
let react: typeof import("react");
let panel: typeof import("../src/property-panel");
let createRoot: typeof import("react-dom/client").createRoot;
let client: ReturnType<typeof import("react-dom/client").createRoot> | null = null;
let teardown: () => void;
let container: HTMLElement;

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
  scope.requestAnimationFrame = (callback: FrameRequestFrame) => setTimeout(callback, 0) as unknown as number;
  scope.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
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
  const clientModule = await import("react-dom/client");
  createRoot = clientModule.createRoot;
  panel = await import("../src/property-panel");
  container = window.document.getElementById("root")!;
  teardown = () => { react.act(() => { client?.unmount(); }); window.close(); };
});

after(() => teardown?.());

function paint(element: ReactElement): void {
  if (client) react.act(() => { client?.unmount(); });
  client = createRoot(container);
  react.act(() => { client?.render(element); });
}

function node(extra: Partial<DesignNode> = {}): DesignNode {
  return {
    id: "node:1",
    type: "frame",
    name: "Frame",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

/** 渲染属性面板，收集 `onPatch` 的入参。 */
function renderPanel(target: DesignNode): Array<Record<string, unknown>> {
  const patches: Array<Record<string, unknown>> = [];
  paint(
    react.createElement(panel.PropertyPanel, {
      node: target,
      onPatch: patch => patches.push(patch as Record<string, unknown>),
      onPatchText: () => undefined,
      onPatchImage: () => undefined,
    }),
  );
  return patches;
}

/** 往角色输入框里打字（React 要的是原生 setter + input 事件）。 */
function typeRole(value: string): void {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="例如 title / body"]');
  assert.ok(input, "属性面板里没有角色输入框");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  react.act(() => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

test("面板里有角色小节和角色输入框", () => {
  renderPanel(node());
  assert.ok(container.textContent?.includes("角色"));
  assert.ok(container.querySelector('input[placeholder="例如 title / body"]'));
});

test("输入角色名写入 role 字段", () => {
  const patches = renderPanel(node());
  typeRole("title");
  assert.deepEqual(patches, [{ role: "title" }]);
});

test("清空输入把 role 删掉（回到「没设角色」）", () => {
  const patches = renderPanel(node({ role: "title" }));
  typeRole("  ");
  assert.deepEqual(patches, [{ role: undefined }]);
});

test("已有的角色显示在输入框里", () => {
  renderPanel(node({ role: "title" }));
  const input = container.querySelector<HTMLInputElement>('input[placeholder="例如 title / body"]');
  assert.equal(input?.value, "title");
});
