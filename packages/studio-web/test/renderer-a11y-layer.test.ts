import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";

/**
 * 画布可访问性列表的键盘路径回归测试。
 *
 * 纯 Canvas 画布下，键盘用户靠这个视觉隐藏的 listbox 进出结构。这里验证三件事：
 * 列表按图层顺序渲染、上下键移动并同步选中、Delete 键能删掉当前节点——但删不掉
 * 锁定节点（锁定语义与画布、层板一致）。
 *
 * React 相关模块全部动态导入，确保它们在 jsdom 全局装好之后才被求值。
 */

let dom: JSDOM;
let container: HTMLElement;
let react: typeof import("react");
let layer: typeof import("../src/renderer/a11y-layer");
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
  scope.KeyboardEvent = window.KeyboardEvent;
  scope.MouseEvent = window.MouseEvent;
  scope.getComputedStyle = window.getComputedStyle.bind(window);
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback(Date.now()), 0) as unknown as number;
  scope.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });

  react = await import("react");
  const { createRoot } = await import("react-dom/client");
  layer = await import("../src/renderer/a11y-layer");
  container = window.document.getElementById("root")!;
  const client = createRoot(container);
  paint = (element: unknown) => { react.act(() => { client.render(element); }); };
  teardown = () => { react.act(() => { client.unmount(); }); window.close(); };
});

after(() => teardown?.());

function node(id: string, extra: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

function designDocument(): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes = Object.fromEntries([
    node("free"),
    node("locked", { locked: true }),
  ].map(item => [item.id, item]));
  document.pages["page:1"]!.childIds = ["free", "locked"];
  return document;
}

function renderLayer(props: { selectedIds?: string[]; onSelect?: (ids: string[]) => void; onDelete?: (id: string) => void }) {
  paint(react.createElement(layer.CanvasA11yLayer, {
    document: designDocument(),
    pageId: "page:1",
    selectedIds: props.selectedIds ?? [],
    onSelect: props.onSelect ?? (() => undefined),
    onDelete: props.onDelete,
  }));
}

function listbox(): HTMLElement {
  return dom.window.document.querySelector<HTMLElement>('[role="listbox"]')!;
}

function options(): HTMLElement[] {
  return [...dom.window.document.querySelectorAll<HTMLElement>('[role="option"]')];
}

function press(target: Element, key: string) {
  react.act(() => {
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

test("the hidden list renders one option per visible node in layer order", () => {
  renderLayer({});
  const items = options();
  assert.equal(items.length, 2);
  assert.ok(items[0]?.textContent?.startsWith("free"));
  assert.ok(items[1]?.textContent?.startsWith("locked"));
});

test("a locked node is marked disabled for assistive technology", () => {
  renderLayer({});
  const items = options();
  assert.equal(items[0]?.getAttribute("aria-disabled"), null);
  assert.equal(items[1]?.getAttribute("aria-disabled"), "true");
});

test("Delete removes the selected node", () => {
  const deleted: string[] = [];
  renderLayer({ selectedIds: ["free"], onDelete: id => { deleted.push(id); } });
  press(listbox(), "Delete");
  assert.deepEqual(deleted, ["free"]);
});

test("Delete refuses a locked node", () => {
  const deleted: string[] = [];
  renderLayer({ selectedIds: ["locked"], onDelete: id => { deleted.push(id); } });
  press(listbox(), "Delete");
  assert.deepEqual(deleted, []);
});

test("ArrowDown moves to the next node and syncs the selection", () => {
  const selected: string[][] = [];
  renderLayer({ selectedIds: ["free"], onSelect: ids => { selected.push(ids); } });
  press(listbox(), "ArrowDown");
  assert.ok(selected.some(ids => ids[0] === "locked"));
});
