import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import type { GridTrack } from "@ufira/design-schema";
import {
  addGridTrack,
  isContentGridTrack,
  isResizableGridTrack,
  layoutGridTracks,
  removeGridTrack,
  resizeGridTrack,
  resizeGridTrackBoundary,
  setGridGutter,
  setGridMargin,
  setGridTrackCount,
  type GridTrackModel,
} from "../src/grid-track-model";
import { gridTrackBaseWidths } from "@ufira/design-layout";

/**
 * Grid 可视化轨道编辑的回归测试。
 *
 * 规格见 `docs/grid-layout.md`。
 *
 * 覆盖模型层（纯函数，断言具体数值）：最小宽度夹紧、容器总宽守恒、
 * 间隙溢出夹紧、删除轨道后的重排、增删轨道的结果；
 * 以及组件层（jsdom + react-dom/client）：轨道条渲染、+/- 按钮、指针拖拽。
 */

let dom: JSDOM;
let react: typeof import("react");
let editor: typeof import("../src/grid-track-editor");
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
  editor = await import("../src/grid-track-editor");
  container = window.document.getElementById("root")!;
  teardown = () => { react.act(() => { client?.unmount(); }); window.close(); };
});

after(() => teardown?.());

/**
 * 渲染一个组件。
 *
 * 每个用例都重新挂载：React 的 `useState` 只在首次挂载时取初值，
 * 复用同一个根会让上一个用例的轨道状态漏进下一个用例。
 */
function paint(element: ReactElement): void {
  if (client) react.act(() => { client?.unmount(); });
  client = createRoot(container);
  react.act(() => { client?.render(element); });
}

/** 固定像素轨道构成的模型。 */
function fixedModel(sizes: number[], containerWidth: number, gutter = 0): GridTrackModel {
  return {
    tracks: sizes.map(size => ({ type: "fixed", size })),
    gutter,
    margin: 0,
    containerWidth,
  };
}

/** 内容轨道（auto）构成的模型。 */
function autoModel(count: number, containerWidth: number): GridTrackModel {
  return {
    tracks: Array.from({ length: count }, () => ({ type: "auto" }) as GridTrack),
    gutter: 0,
    margin: 0,
    containerWidth,
  };
}

/** 轨道宽度之和。 */
function sumWidths(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0);
}

/* ----------------------------- 模型层（纯函数） ----------------------------- */

test("轨道宽度被夹到最小宽度，差额由其余轨道吸收", () => {
  const model = fixedModel([100, 100], 200);
  const result = resizeGridTrack(model, 0, 5);

  // 24px 是轨道最小宽度。
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 24 }, { type: "fixed", size: 176 }]);
  assert.equal(result.widths[0], 24);
  assert.equal(result.widths[1], 176);
  // 夹紧的诊断要报出来，不能静默吞掉。
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "min-width-clamped"));
  assert.equal(result.diagnostics.find(diagnostic => diagnostic.code === "min-width-clamped")!.index, 0);
});

test("加轨道时容器总宽守恒：其余轨道等比收缩，不产生溢出", () => {
  const model = fixedModel([100, 100], 200);
  const result = addGridTrack(model, "fixed");

  // 新轨道以最小宽度 24px 起步，两条老轨道各让出 12px。
  assert.deepEqual(result.tracks, [
    { type: "fixed", size: 88 },
    { type: "fixed", size: 88 },
    { type: "fixed", size: 24 },
  ]);
  assert.equal(result.widths.length, 3);
  assert.equal(sumWidths(result.widths), 200);
  assert.equal(result.totalWidth, 200);
  assert.equal(result.overflow, 0);
});

test("删轨道后其余轨道重排，容器总宽仍然守恒", () => {
  const model = fixedModel([100, 100, 100], 300);
  const result = removeGridTrack(model, 1);

  // 删掉中间那条，剩下的两条瓜分 300px。
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 150 }, { type: "fixed", size: 150 }]);
  assert.equal(sumWidths(result.widths), 300);
  assert.equal(result.totalWidth, 300);
  assert.equal(result.overflow, 0);
});

test("至少保留一条轨道", () => {
  const model = fixedModel([100], 200);
  const result = removeGridTrack(model, 0);
  assert.equal(result.tracks.length, 1);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "track-count-clamped"));
});

test("间隙总和超过容器可用宽时被夹紧，并给出诊断", () => {
  const model = fixedModel([100, 100], 200);
  const result = setGridGutter(model, 1000);

  // 两条轨道至少要各留 24px：200 - 2×24 = 152。
  assert.equal(result.model.gutter, 152);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "gutter-clamped"));
  // 夹紧之后轨道仍然守得住最小宽度，总宽还是容器的宽度。
  assert.equal(result.widths[0], 24);
  assert.equal(result.widths[1], 24);
  assert.equal(result.totalWidth, 200);
  assert.equal(result.overflow, 0);
});

test("间隙在允许范围内时原样保留", () => {
  const model = fixedModel([90, 90], 200);
  const result = setGridGutter(model, 20);
  assert.equal(result.model.gutter, 20);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === "gutter-clamped"), false);
  // 90 + 90 + 20 = 200：刚好放下，轨道尺寸不用动。
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 90 }, { type: "fixed", size: 90 }]);
  assert.equal(result.totalWidth, 200);
});

test("调整单条轨道宽度，差额由相邻轨道承担", () => {
  const model = fixedModel([100, 100], 200);
  const result = resizeGridTrack(model, 0, 150);
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 150 }, { type: "fixed", size: 50 }]);
  assert.equal(result.totalWidth, 200);
});

test("拖拽轨道边界按真实像素换算", () => {
  const model = fixedModel([100, 100], 200);
  const result = resizeGridTrackBoundary(model, 0, 20);
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 120 }, { type: "fixed", size: 80 }]);
  assert.equal(result.totalWidth, 200);
});

test("比例轨道改宽度时反解权重，其余轨道等比让位", () => {
  const model: GridTrackModel = {
    tracks: [{ type: "fraction", weight: 1 }, { type: "fraction", weight: 1 }],
    gutter: 0,
    margin: 0,
    containerWidth: 200,
  };
  const result = resizeGridTrack(model, 0, 150);
  // 150 : 50 = 3 : 1。
  assert.deepEqual(result.tracks, [{ type: "fraction", weight: 3 }, { type: "fraction", weight: 1 }]);
  assert.equal(Math.round(result.widths[0]), 150);
  assert.equal(Math.round(result.widths[1]), 50);
  assert.equal(result.totalWidth, 200);
});

test("内容轨道不能直接调整宽度", () => {
  const model = autoModel(2, 200);
  const result = resizeGridTrack(model, 0, 50);
  assert.deepEqual(result.tracks, [{ type: "auto" }, { type: "auto" }]);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "track-not-resizable"));
});

test("设置轨道数量：少的补上，多了删掉", () => {
  const model = autoModel(2, 200);
  const grown = setGridTrackCount(model, 3);
  assert.equal(grown.tracks.length, 3);
  assert.equal(grown.totalWidth, 200);
  assert.equal(grown.overflow, 0);

  const shrunk = setGridTrackCount(model, 1);
  assert.equal(shrunk.tracks.length, 1);
  assert.equal(shrunk.totalWidth, 200);
});

test("轨道数量下限为 1", () => {
  const model = autoModel(2, 200);
  const result = setGridTrackCount(model, 0);
  assert.equal(result.tracks.length, 1);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "track-count-clamped"));
});

test("加一条比例轨道时按权重瓜分剩余空间", () => {
  const model: GridTrackModel = {
    tracks: [{ type: "fraction", weight: 1 }],
    gutter: 0,
    margin: 0,
    containerWidth: 200,
  };
  const result = addGridTrack(model, "fraction");
  assert.deepEqual(result.tracks, [{ type: "fraction", weight: 1 }, { type: "fraction", weight: 1 }]);
  assert.equal(Math.round(result.widths[0]), 100);
  assert.equal(Math.round(result.widths[1]), 100);
  assert.equal(result.totalWidth, 200);
});

test("只有一条比例轨道时没有可调节的余量", () => {
  const model: GridTrackModel = {
    tracks: [{ type: "fraction", weight: 1 }],
    gutter: 0,
    margin: 0,
    containerWidth: 200,
  };
  const result = resizeGridTrack(model, 0, 50);
  assert.deepEqual(result.tracks, [{ type: "fraction", weight: 1 }]);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "track-not-resizable"));
});

test("删除越界的轨道下标时什么都不做", () => {
  const model = fixedModel([100, 100], 200);
  const result = removeGridTrack(model, 9);
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }]);
});

test("轨道数量被夹到允许范围时给出诊断", () => {
  const model = autoModel(2, 200);
  const result = setGridTrackCount(model, 100);
  assert.equal(result.tracks.length, 24);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "track-count-clamped"));
});

test("留白缩小可用宽度，轨道按规则收缩", () => {
  const model = fixedModel([100, 100], 200);
  const result = setGridMargin(model, 20);
  assert.equal(result.model.margin, 20);
  assert.equal(result.availableWidth, 160);
  // 200px 的轨道要塞进 160px：各让出 20px。
  assert.deepEqual(result.tracks, [{ type: "fixed", size: 80 }, { type: "fixed", size: 80 }]);
  assert.equal(result.totalWidth, 160);
});

test("留白超过容器宽度的一半时被夹住", () => {
  const model = fixedModel([100, 100], 200);
  const result = setGridMargin(model, 500);
  assert.equal(result.model.margin, 100);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "margin-clamped"));
});

test("只读布局不会改动轨道声明", () => {
  const model = fixedModel([200], 100);
  const layout = layoutGridTracks(model);
  // 放不下时编辑器把显示宽度夹到能放下的值，声明本身一个字都不动。
  assert.deepEqual(layout.tracks, [{ type: "fixed", size: 200 }]);
  assert.equal(layout.widths[0], 100);
  assert.equal(layout.totalWidth, 100);
});

test("容器连轨道的最小宽度都放不下时报告溢出", () => {
  const model = fixedModel([50, 50, 50, 50, 50], 100);
  const layout = layoutGridTracks(model);
  // 五条轨道最少要 5 × 24 = 120px，容器只有 100px。
  assert.deepEqual(layout.widths, [24, 24, 24, 24, 24]);
  assert.equal(layout.overflow, 20);
  assert.ok(layout.diagnostics.some(diagnostic => diagnostic.code === "container-overflow"));
});

/* ------------------------------- 组件层（DOM） ------------------------------- */

/** 受控外壳：把 onChange 记下来，并把新轨道灌回去。 */
function Harness(props: { initial: GridTrack[]; gutter?: number; onUpdate(next: { tracks: GridTrack[]; gutter: number }): void }) {
  const [tracks, setTracks] = react.useState(props.initial);
  return react.createElement(editor.GridTrackEditor, {
    tracks,
    gutter: props.gutter ?? 0,
    containerWidth: 200,
    onChange: (next: { tracks: GridTrack[]; gutter: number }) => {
      setTracks(next.tracks);
      props.onUpdate(next);
    },
  });
}

test("轨道条按真实比例渲染，间隙单独画出来", () => {
  const updates: { tracks: GridTrack[]; gutter: number }[] = [];
  paint(react.createElement(Harness, { initial: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }], gutter: 20, onUpdate: next => updates.push(next) }));

  const cells = container.querySelectorAll(".grid-track-editor-cell");
  assert.equal(cells.length, 2);
  // 容器 200px、间隙 20px：两条轨道各 90px，第二条从 110px 开始。
  assert.equal((cells[0] as HTMLElement).style.left, "0px");
  assert.equal((cells[0] as HTMLElement).style.width, "90px");
  assert.equal((cells[1] as HTMLElement).style.left, "110px");
  assert.equal((cells[1] as HTMLElement).style.width, "90px");

  const gutters = container.querySelectorAll(".grid-track-editor-gutter");
  assert.equal(gutters.length, 1);
  assert.equal((gutters[0] as HTMLElement).style.width, "20px");
});

test("点 + 加一条轨道，点 − 删掉最后一条", () => {
  const updates: { tracks: GridTrack[]; gutter: number }[] = [];
  paint(react.createElement(Harness, { initial: [{ type: "fixed", size: 100 }], onUpdate: next => updates.push(next) }));

  const buttons = Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];
  const add = buttons.find(button => button.textContent?.includes("+ 轨道"))!;
  const remove = buttons.find(button => button.textContent?.includes("− 轨道"))!;

  react.act(() => { add.click(); });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].tracks.length, 2);
  // 新轨道守住 24px 的最小宽度，让出来的空间归原轨道（总宽守恒）。
  assert.deepEqual(updates[0].tracks, [{ type: "fixed", size: 176 }, { type: "fixed", size: 24 }]);

  react.act(() => { remove.click(); });
  assert.equal(updates.length, 2);
  assert.equal(updates[1].tracks.length, 1);
});

test("拖拽轨道边界改宽度", () => {
  const updates: { tracks: GridTrack[]; gutter: number }[] = [];
  paint(react.createElement(Harness, { initial: [{ type: "fixed", size: 100 }, { type: "fixed", size: 100 }], onUpdate: next => updates.push(next) }));

  const handle = container.querySelector('button[aria-label^="调整轨道"]') as HTMLButtonElement;
  assert.ok(handle);

  handle.dispatchEvent(new dom.window.MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
  react.act(() => {
    dom.window.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: 120, bubbles: true }));
  });

  assert.equal(updates.length, 1);
  // 拖了 20px：左边轨道 100 → 120，右边轨道 100 → 80。
  assert.deepEqual(updates[0].tracks, [{ type: "fixed", size: 120 }, { type: "fixed", size: 80 }]);
});

test("相邻两条都是内容轨道时手柄不可用", () => {
  paint(react.createElement(Harness, { initial: [{ type: "auto" }, { type: "auto" }], onUpdate: () => undefined }));
  const handle = container.querySelector('button[aria-label^="调整轨道"]') as HTMLButtonElement;
  assert.equal(handle.disabled, true);
});

/* ------------------------- 自动重复轨道（repeat） ------------------------- */

test("自动重复轨道在编辑期只显示一条最小宽度的占位，且不可拖拽", () => {
  const repeat: GridTrack = { type: "repeat", mode: "auto-fill", min: 140, grow: true };
  const model: GridTrackModel = { tracks: [repeat], gutter: 0, margin: 0, containerWidth: 400 };
  const layout = layoutGridTracks(model);

  // 真实条数由容器宽度在布局时展开；编辑器里只有一个占位。
  assert.deepEqual(layout.widths, [140]);
  assert.equal(layout.slack, 260);
  assert.equal(isResizableGridTrack(repeat), false);
  assert.equal(isContentGridTrack(repeat), false);
});

test("自动重复轨道不能拖拽改宽，给出明确诊断", () => {
  const model: GridTrackModel = {
    tracks: [{ type: "repeat", mode: "auto-fill", min: 140, grow: true }],
    gutter: 0,
    margin: 0,
    containerWidth: 400,
  };
  const result = resizeGridTrack(model, 0, 220);
  assert.equal(result.diagnostics[0]?.code, "track-not-resizable");
  // 宽度一个字都不动：条数由容器宽度在布局时决定，编辑器不越权。
  assert.deepEqual(result.widths, [140]);
});
