import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import { defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";

/**
 * 属性面板的「溢出」小节。
 *
 * 规格见 `docs/prototype-runtime.md` §8：
 * - 缺省是「裁切」（字段不写）；
 * - 选「滚动」写 `overflow: "scroll"`；
 * - 选回「裁切」把字段删掉（回到缺省语义）；
 * - 非容器节点不显示这一节。
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
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
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

/** 面板里所有按钮的文本。 */
function buttonLabels(): string[] {
  return [...container.querySelectorAll("button")].map(button => (button.textContent ?? "").trim());
}

/** 点一个分段控件上的按钮。 */
function clickSegment(label: string): void {
  const button = [...container.querySelectorAll("button")].find(candidate => (candidate.textContent ?? "").trim() === label);
  assert.ok(button, `找不到分段控件按钮：${label}`);
  react.act(() => { button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })); });
}

test("容器节点显示溢出小节", () => {
  renderPanel(node());
  assert.ok(container.textContent?.includes("溢出"));
  assert.ok(buttonLabels().includes("滚动"));
});

test("非容器节点不显示溢出小节", () => {
  renderPanel(node({ type: "rectangle" }));
  assert.ok(!container.textContent?.includes("溢出"));
  assert.ok(!buttonLabels().includes("滚动"));
});

test("选「滚动」写入 overflow: scroll", () => {
  const patches = renderPanel(node());
  clickSegment("滚动");
  assert.deepEqual(patches, [{ overflow: "scroll" }]);
});

test("选「可见」写入 overflow: visible", () => {
  const patches = renderPanel(node({ overflow: "scroll" }));
  clickSegment("可见");
  assert.deepEqual(patches, [{ overflow: "visible" }]);
});

test("选回「裁切」把字段删掉（回到缺省语义）", () => {
  const patches = renderPanel(node({ overflow: "scroll" }));
  clickSegment("裁切");
  assert.deepEqual(patches, [{ overflow: undefined }]);
});
