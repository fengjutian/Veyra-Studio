import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import type { GridCell, GridSpec, NodeId } from "@ufira/design-schema";

/**
 * Grid 命名区域编辑器的组件回归测试。
 *
 * 规格见 `docs/grid-layout.md` §9。
 *
 * 模型层（纯函数）在 `grid-areas-model.test.ts` 里断言具体数值；
 * 这里只验证接线：文本域草稿、实时诊断、应用按钮的可用性、子节点下拉框的回调。
 */

let dom: JSDOM;
let react: typeof import("react");
let editor: typeof import("../src/grid-area-editor");
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
  scope.getComputedStyle = window.getComputedStyle.bind(window);
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });

  react = await import("react");
  const clientModule = await import("react-dom/client");
  createRoot = clientModule.createRoot;
  editor = await import("../src/grid-area-editor");
  container = window.document.getElementById("root")!;
  teardown = () => { react.act(() => { client?.unmount(); }); window.close(); };
});

after(() => teardown?.());

function paint(element: ReactElement): void {
  if (client) react.act(() => { client?.unmount(); });
  client = createRoot(container);
  react.act(() => { client?.render(element); });
}

type Props = import("../src/grid-area-editor").GridAreaEditorProps;

function render(props: Props): void {
  paint(react.createElement(editor.GridAreaEditor, props));
}

function grid(overrides: Partial<GridSpec> = {}): GridSpec {
  return {
    columns: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }],
    rows: [{ type: "fixed", size: 50 }, { type: "fixed", size: 50 }],
    columnGap: 0,
    rowGap: 0,
    ...overrides,
  };
}

/** 像用户一样改文本域：走原生 value setter + input 事件，React 才认这次改动。 */
function typeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  react.act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** 下拉框换选项。 */
function choose(select: HTMLSelectElement, value: string): void {
  react.act(() => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

function applyButton(): HTMLButtonElement {
  return buttons().find(button => button.textContent === "应用模板")!;
}

const childIds: NodeId[] = ["first", "second"];

test("命名区域：文本域显示当前模板", () => {
  render({ grid: grid({ areas: ["header header"] }), childIds, onChange: () => {} });
  assert.equal(container.querySelector("textarea")!.value, "header header");
});

test("命名区域：非法模板实时报错，应用按钮禁用", () => {
  render({ grid: grid(), childIds, onChange: () => {} });
  typeTextarea(container.querySelector("textarea")!, "a b a");
  assert.equal(applyButton().disabled, true);
  assert.ok(container.textContent?.includes("non-rectangular"));
});

test("命名区域：列数与轨道对不上时不提交", () => {
  render({ grid: grid(), childIds, onChange: () => {} });
  typeTextarea(container.querySelector("textarea")!, "a b c");
  assert.equal(applyButton().disabled, true);
  assert.ok(container.textContent?.includes("模板有 3 列，但列轨道有 2 条"));
});

test("命名区域：合法模板可以应用，回调带上规范化模板与补齐的 cells", () => {
  const received: Array<{ areas?: string[]; cells?: Record<NodeId, GridCell> }> = [];
  render({ grid: grid(), childIds, onChange: changes => received.push(changes) });
  typeTextarea(container.querySelector("textarea")!, "  header   header  \nsidebar main");
  assert.equal(applyButton().disabled, false);
  react.act(() => { applyButton().click(); });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0]?.areas, ["header header", "sidebar main"]);
  // 两个子节点原本没有条目：模板生效后按顺序补位，不能凭空消失。
  assert.deepEqual(received[0]?.cells?.first, { row: 1, column: 1 });
  assert.deepEqual(received[0]?.cells?.second, { row: 1, column: 2 });
});

test("命名区域：子节点下拉框可以指定区域", () => {
  const received: Array<{ areas?: string[]; cells?: Record<NodeId, GridCell> }> = [];
  render({
    grid: grid({ areas: ["header header", "sidebar main"] }),
    childIds,
    nodeName: id => `节点 ${id}`,
    onChange: changes => received.push(changes),
  });

  const select = container.querySelectorAll("select")[1] as HTMLSelectElement;
  choose(select, "main");
  assert.deepEqual(received.at(-1)?.cells?.second, { area: "main" });
});

test("命名区域：清除按钮把模板与区域引用一起撤掉", () => {
  const received: Array<{ areas?: string[]; cells?: Record<NodeId, GridCell> }> = [];
  render({
    grid: grid({ areas: ["header header"], cells: { first: { area: "header" }, second: { row: 1, column: 2 } } }),
    childIds,
    onChange: changes => received.push(changes),
  });

  const clear = buttons().find(button => button.textContent === "清除")!;
  react.act(() => { clear.click(); });
  assert.equal(received.at(-1)?.areas, undefined);
  // 区域引用退回顺序填充，行列号定位的第二个子节点保持不动。
  assert.deepEqual(received.at(-1)?.cells?.first, { row: 1, column: 1 });
  assert.deepEqual(received.at(-1)?.cells?.second, { row: 1, column: 2 });
});
