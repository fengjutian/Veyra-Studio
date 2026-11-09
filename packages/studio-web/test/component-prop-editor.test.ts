import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import type { ComponentPropertyValue } from "@ufira/design-schema";

/**
 * 组件属性按类型控件（`ComponentPropEditor`）。
 *
 * 规格见 `docs/component-properties.md` §3、§7.1：
 * - `text` → 文本输入框
 * - `boolean` → 开关
 * - `color` → 取色器
 * - `number` → 数字输入框
 * - `instance-swap` → 下拉选择候选组件
 *
 * 控件类型由 `PROPERTY_TYPE_SPECS` 决定——面板与运行时读同一张表。
 */

let dom: JSDOM;
let react: typeof import("react");
let editor: typeof import("../src/component-prop-editor");
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
  editor = await import("../src/component-prop-editor");
  container = window.document.getElementById("root")!;
  teardown = () => { react.act(() => { client?.unmount(); }); window.close(); };
});

after(() => teardown?.());

function paint(element: ReactElement): void {
  if (client) react.act(() => { client?.unmount(); });
  client = createRoot(container);
  react.act(() => { client?.render(element); });
}

/** 渲染一个属性控件，收集它的取值回调。 */
function render(type: "text" | "boolean" | "instance-swap" | "color" | "number", value: ComponentPropertyValue): Array<ComponentPropertyValue> {
  const values: Array<ComponentPropertyValue> = [];
  paint(
    react.createElement(editor.ComponentPropEditor, {
      label: "属性",
      type,
      value,
      components: [{ componentId: "component:icon", label: "图标" }],
      onChange: next => values.push(next),
    }),
  );
  return values;
}

test("text renders a text input", () => {
  render("text", "确定");
  const input = container.querySelector("input[type=text], input:not([type])") as HTMLInputElement | null;
  assert.ok(input, "没有找到文本输入框");
  assert.equal(input.value, "确定");
});

test("boolean renders a checkbox", () => {
  render("boolean", true);
  const input = container.querySelector("input[type=checkbox]") as HTMLInputElement | null;
  assert.ok(input, "没有找到开关");
  assert.equal(input.checked, true);
});

test("color renders a color picker with the current value", () => {
  render("color", "#ff0000");
  const input = container.querySelector("input[type=color]") as HTMLInputElement | null;
  assert.ok(input, "没有找到取色器");
  assert.equal(input.value, "#ff0000");
});

test("number renders a numeric input", () => {
  render("number", 18);
  const input = container.querySelector("input[type=number]") as HTMLInputElement | null;
  assert.ok(input, "没有找到数字输入框");
  assert.equal(input.value, "18");
});

test("instance-swap renders a select with the component choices", () => {
  render("instance-swap", "component:icon");
  const select = container.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, "没有找到下拉框");
  assert.equal(select.value, "component:icon");
  const options = [...select.options].map(option => option.value);
  assert.deepEqual(options, ["", "component:icon"]);
});

test("instance-swap reports the chosen component", () => {
  const values = render("instance-swap", "");
  const select = container.querySelector("select") as HTMLSelectElement;
  react.act(() => {
    select.value = "component:icon";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  assert.deepEqual(values, ["component:icon"]);
});

test("boolean reports the toggled value", () => {
  const values = render("boolean", false);
  const input = container.querySelector("input[type=checkbox]") as HTMLInputElement;
  // React 对 checkbox 的 onChange 挂在 click 上：直接 click 才会翻转并触发回调。
  react.act(() => { input.click(); });
  assert.deepEqual(values, [true]);
});
