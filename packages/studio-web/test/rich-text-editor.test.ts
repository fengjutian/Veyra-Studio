import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import { defaultAppearance, defaultLayout, type DesignNode, type ParagraphStyleRun, type TextRun } from "@ufira/design-schema";

/**
 * 画布内联文本编辑器的回归测试。
 *
 * 规格见 `docs/inline-text-editing.md`。
 *
 * 覆盖三件事：段落描述（run 切片 + 列表标记与缩进）、编辑器 DOM 的构建与文本还原、
 * 以及键盘规则（Enter 提交 / Shift+Enter 换行 / Esc 取消）。
 */

let dom: JSDOM;
let react: typeof import("react");
let model: typeof import("../src/renderer/rich-text-editor-model");
let overlay: typeof import("../src/renderer/text-edit-overlay");
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
  scope.MutationObserver = window.MutationObserver;
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

  react = await import("react");
  const { createRoot } = await import("react-dom/client");
  model = await import("../src/renderer/rich-text-editor-model");
  overlay = await import("../src/renderer/text-edit-overlay");
  const container = window.document.getElementById("root")!;
  const client = createRoot(container);
  paint = (element: unknown) => { react.act(() => { client.render(element); }); };
  teardown = () => { react.act(() => { client.unmount(); }); window.close(); };
});

after(() => teardown?.());

function textNode(content: string, extra: Partial<DesignNode> = {}): DesignNode {
  return {
    id: "text:1",
    type: "text",
    name: "text:1",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 60 },
    appearance: defaultAppearance(),
    text: content,
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...extra,
  } as DesignNode;
}

const BASE = { fontWeight: 400, fontStyle: "normal" as const, fontSize: 16, color: "#111111" };

/**
 * 挂载编辑器。
 *
 * 先卸载再挂载：React 会复用同位置的组件实例，而编辑器是「一次编辑会话一个实例」
 * （提交/取消后卸载），复用会让上一场的 `finished` 状态串场。
 */
function mountOverlay(props: {
  node: DesignNode;
  onCommit(value: string): void;
  onCancel(): void;
  onCommitRich?(value: string, runs: TextRun[], paragraphStyles: ParagraphStyleRun[]): void;
}): HTMLElement {
  paint(null);
  paint(react.createElement(overlay.TextEditOverlay, {
    ...props,
    box: { x: 0, y: 0, width: 200, height: 40 },
  }));
  return dom.window.document.querySelector(".rich-text-editor") as HTMLElement;
}

/**
 * 在编辑器里选中一段字符。
 *
 * 先 mousedown 再 mouseup：工具条只在用户**自己**拉出选区后才出现
 * （进入编辑时的全选不算）。
 */
function selectRange(editor: HTMLElement, from: number, to: number): void {
  const run = editor.querySelector("[data-editor-run]") as HTMLElement;
  const range = dom.window.document.createRange();
  range.setStart(run.firstChild!, from);
  range.setEnd(run.firstChild!, to);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  react.act(() => {
    editor.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    editor.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
  });
}

test("splits the text into paragraphs", () => {
  const paragraphs = model.editorParagraphs("a\nb", undefined, undefined);
  assert.deepEqual(paragraphs.map(paragraph => paragraph.text), ["a", "b"]);
  assert.deepEqual(paragraphs.map(paragraph => paragraph.index), [0, 1]);
});

test("keeps the run styles inside their paragraph", () => {
  const paragraphs = model.editorParagraphs("ab\ncd", [{ from: 0, to: 2, style: { fontWeight: 700 } }], undefined);
  assert.deepEqual(paragraphs[0]!.runs.map(run => [run.text, run.style.fontWeight]), [["ab", 700]]);
  assert.deepEqual(paragraphs[1]!.runs.map(run => [run.text, run.style.fontWeight]), [["cd", undefined]]);
});

test("reports the list marker and the indent of a list paragraph", () => {
  const paragraphs = model.editorParagraphs("a\nb", undefined, [{ from: 0, to: 3, style: { listType: "ordered" } }]);
  assert.deepEqual(paragraphs.map(paragraph => paragraph.marker), ["1.", "2."]);
  assert.deepEqual(paragraphs.map(paragraph => paragraph.listType), ["ordered", "ordered"]);
  assert.equal(paragraphs[0]!.indent, 0);
});

test("renders the paragraph blocks with their indent and marker", () => {
  const root = dom.window.document.createElement("div");
  const paragraphs = model.editorParagraphs("a", undefined, [{ from: 0, to: 1, style: { listType: "bullet", indent: 2 } }]);
  model.renderEditorParagraphs(root, paragraphs, BASE);
  const block = root.querySelector("[data-editor-paragraph]") as HTMLElement;
  assert.ok(block);
  // 级别缩进由 padding 让出。
  assert.equal(block.style.paddingLeft, "48px");
  const marker = block.querySelector("[data-editor-marker]") as HTMLElement;
  assert.equal(marker.textContent, "•");
  assert.equal(marker.getAttribute("contenteditable"), "false");
});

test("renders the run styles as inline styles", () => {
  const root = dom.window.document.createElement("div");
  const paragraphs = model.editorParagraphs("ab", [{ from: 0, to: 2, style: { fontWeight: 700, color: "#ef4444" } }], undefined);
  model.renderEditorParagraphs(root, paragraphs, BASE);
  const run = root.querySelector("[data-editor-run]") as HTMLElement;
  assert.equal(run.textContent, "ab");
  assert.equal(run.style.fontWeight, "700");
  assert.equal(run.style.color, "rgb(239, 68, 68)");
});

test("reads the text back without the markers", () => {
  const root = dom.window.document.createElement("div");
  const paragraphs = model.editorParagraphs("a\nb", undefined, [{ from: 0, to: 1, style: { listType: "bullet" } }]);
  model.renderEditorParagraphs(root, paragraphs, BASE);
  assert.equal(model.readEditorText(root), "a\nb");
});

test("reads a line break inside a paragraph as a newline", () => {
  const root = dom.window.document.createElement("div");
  const paragraphs = model.editorParagraphs("a", undefined, undefined);
  model.renderEditorParagraphs(root, paragraphs, BASE);
  const block = root.querySelector("[data-editor-paragraph]") as HTMLElement;
  block.appendChild(dom.window.document.createElement("br"));
  block.appendChild(dom.window.document.createTextNode("b"));
  assert.equal(model.readEditorText(root), "a\nb");
});

test("ignores a marker the user deleted", () => {
  const root = dom.window.document.createElement("div");
  const paragraphs = model.editorParagraphs("a", undefined, [{ from: 0, to: 1, style: { listType: "bullet" } }]);
  model.renderEditorParagraphs(root, paragraphs, BASE);
  root.querySelector("[data-editor-marker]")!.remove();
  assert.equal(model.readEditorText(root), "a");
});

test("commits the edited text on Enter", () => {
  const committed: string[] = [];
  const editor = mountOverlay({
    node: textNode("hello"),
    onCommit: (value: string) => committed.push(value),
    onCancel: () => committed.push("<cancel>"),
  });
  assert.ok(editor);
  assert.equal(editor.textContent, "hello");
  // 模拟输入：改写第一个 run 的内容。
  const run = editor.querySelector("[data-editor-run]") as HTMLElement;
  run.textContent = "world";
  const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  react.act(() => { editor.dispatchEvent(event); });
  assert.deepEqual(committed, ["world"]);
});

test("cancels on Escape without committing", () => {
  const committed: string[] = [];
  const editor = mountOverlay({
    node: textNode("hello"),
    onCommit: (value: string) => committed.push(value),
    onCancel: () => committed.push("<cancel>"),
  });
  const event = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  react.act(() => { editor.dispatchEvent(event); });
  assert.deepEqual(committed, ["<cancel>"]);
});

test("shows the list marker and the indent in the editor", () => {
  const editor = mountOverlay({
    node: textNode("a\nb", {
      paragraphStyles: [{ from: 0, to: 3, style: { listType: "ordered" } }],
    } as Partial<DesignNode>),
    onCommit: () => {},
    onCancel: () => {},
  });
  const markers = Array.from(editor.querySelectorAll("[data-editor-marker]"));
  assert.deepEqual(markers.map(marker => marker.textContent), ["1.", "2."]);
});

test("rebuilds the content when the edited node changes", () => {
  const editor = mountOverlay({
    node: textNode("hello"),
    onCommit: () => {},
    onCancel: () => {},
  });
  assert.equal(editor.textContent, "hello");
  // 换成另一个文本节点：内容必须跟着换（否则显示的是上一个节点）。
  paint(react.createElement(overlay.TextEditOverlay, {
    node: textNode("world", { id: "text:2" }),
    box: { x: 0, y: 0, width: 200, height: 40 },
    onCommit: () => {},
    onCancel: () => {},
  }));
  const next = dom.window.document.querySelector(".rich-text-editor") as HTMLElement;
  assert.equal(next.textContent, "world");
});

test("reads the selection as character offsets", () => {
  const root = dom.window.document.createElement("div");
  // 选区必须落在文档里（浏览器的选区不会挂在游离节点上）。
  dom.window.document.body.appendChild(root);
  model.renderEditorParagraphs(root, model.editorParagraphs("hello", undefined, undefined), BASE);
  const run = root.querySelector("[data-editor-run]") as HTMLElement;
  const range = dom.window.document.createRange();
  range.setStart(run.firstChild!, 1);
  range.setEnd(run.firstChild!, 3);
  const selection = dom.window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  assert.deepEqual(model.editorSelectionOffsets(root, selection), { from: 1, to: 3 });
  root.remove();
});

test("reads the run styles back from the editor DOM", () => {
  const root = dom.window.document.createElement("div");
  const paragraphs = model.editorParagraphs("hello", [{ from: 1, to: 3, style: { fontWeight: 700 } }], undefined);
  model.renderEditorParagraphs(root, paragraphs, BASE);
  assert.deepEqual(model.readEditorRuns(root, BASE), [{ from: 1, to: 3, style: { fontWeight: 700 } }]);
  // 没有覆盖的段落不产生区间。
  const plain = dom.window.document.createElement("div");
  model.renderEditorParagraphs(plain, model.editorParagraphs("hello", undefined, undefined), BASE);
  assert.deepEqual(model.readEditorRuns(plain, BASE), []);
});

test("merges a style into the selection instead of replacing it", () => {
  const runs = [{ from: 0, to: 5, style: { color: "#ef4444" } }];
  // 加粗不清掉颜色。
  assert.deepEqual(model.mergeEditorRunStyle("hello", runs, 0, 5, { fontWeight: 700 }), [
    { from: 0, to: 5, style: { color: "#ef4444", fontWeight: 700 } },
  ]);
  // 取消加粗：只移除字重，颜色留着。
  assert.deepEqual(model.mergeEditorRunStyle("hello", runs, 0, 5, {}, ["fontWeight"]), [
    { from: 0, to: 5, style: { color: "#ef4444" } },
  ]);
});

test("updates the run styles in place without rebuilding the DOM", () => {
  const root = dom.window.document.createElement("div");
  model.renderEditorParagraphs(root, model.editorParagraphs("hello", undefined, undefined), BASE);
  const run = root.querySelector("[data-editor-run]") as HTMLElement;
  // 节点级字重变了：只改行内样式，元素本身不换（光标因此保住）。
  assert.equal(model.updateEditorRunStyles(root, [], { ...BASE, fontWeight: 700 }), true);
  assert.equal(run.style.fontWeight, "700");
  assert.equal(root.querySelector("[data-editor-run]"), run);
});

test("bolds the selected text from the canvas toolbar", () => {
  const editor = mountOverlay({
    node: textNode("hello"),
    onCommit: () => {},
    onCancel: () => {},
  });
  selectRange(editor, 1, 3);
  const toolbar = dom.window.document.querySelector(".rte-toolbar") as HTMLElement;
  assert.ok(toolbar, "选中文字后应该出现工具条");
  const bold = toolbar.querySelector(".rte-tool") as HTMLElement;
  react.act(() => { bold.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  // 应用样式会重建 DOM，元素是新的。
  // 选区 [1,3) 加粗 → 切成「h / el / lo」三段，中间那段加粗。
  const runs = Array.from(editor.querySelectorAll("[data-editor-run]"));
  assert.deepEqual(runs.map(run => [run.textContent, run.style.fontWeight]), [
    ["h", "400"],
    ["el", "700"],
    ["lo", "400"],
  ]);
  assert.equal(runs[1]!.getAttribute("data-editor-style"), JSON.stringify({ fontWeight: 700 }));
});

test("commits the rich text with the runs read back from the DOM", () => {
  const committed: { text: string; runs: TextRun[] }[] = [];
  const editor = mountOverlay({
    node: textNode("hello"),
    onCommit: () => {},
    onCancel: () => {},
    onCommitRich: (value, runs) => { committed.push({ text: value, runs }); },
  });
  selectRange(editor, 1, 3);
  const bold = (dom.window.document.querySelector(".rte-tool") as HTMLElement);
  react.act(() => { bold.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  react.act(() => { editor.dispatchEvent(event); });
  assert.deepEqual(committed, [{ text: "hello", runs: [{ from: 1, to: 3, style: { fontWeight: 700 } }] }]);
});

test("reflects a node style change in the editor without rebuilding the DOM", () => {
  const editor = mountOverlay({
    node: textNode("hello"),
    onCommit: () => {},
    onCancel: () => {},
  });
  const run = editor.querySelector("[data-editor-run]") as HTMLElement;
  // 同一个节点，只是节点级字重变了。
  paint(react.createElement(overlay.TextEditOverlay, {
    node: textNode("hello", { fontWeight: 700 }),
    box: { x: 0, y: 0, width: 200, height: 40 },
    onCommit: () => {},
    onCancel: () => {},
  }));
  const next = dom.window.document.querySelector(".rich-text-editor") as HTMLElement;
  assert.equal(next.querySelector("[data-editor-run]"), run, "样式变化不该重建 DOM");
  assert.equal((next.querySelector("[data-editor-run]") as HTMLElement).style.fontWeight, "700");
});
