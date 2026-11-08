import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import type { SceneNode } from "../src/renderer/scene";

/**
 * 画布上的列表标记与缩进。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

interface Call { name: string; args: unknown[]; align?: string }

interface Draw { text: string; x: number; y: number; align: string }

/** 只实现渲染器文字绘制路径用到的 API；measureText 固定 10px/字符。 */
function fakeContext() {
  const calls: Call[] = [];
  const state = { alpha: 1, fillStyle: "#000", font: "", textAlign: "left", textBaseline: "alphabetic", letterSpacing: "" };
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  const context = {
    calls,
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    beginPath: record("beginPath"),
    rect: record("rect"),
    clip: record("clip"),
    save: record("save"),
    restore: record("restore"),
    fillText: (value: string, x: number, y: number) => { calls.push({ name: "fillText", args: [value, x, y], align: state.textAlign }); },
    measureText: (value: string) => ({ width: Array.from(value).length * 10 }),
    get globalAlpha() { return state.alpha; },
    set globalAlpha(value: number) { state.alpha = value; },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(value: string) { state.fillStyle = value; calls.push({ name: "fillStyle", args: [value] }); },
    get font() { return state.font; },
    set font(value: string) { state.font = value; calls.push({ name: "font", args: [value] }); },
    get textAlign() { return state.textAlign; },
    set textAlign(value: string) { state.textAlign = value; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(value: string) { state.textBaseline = value; },
    get letterSpacing() { return state.letterSpacing; },
    set letterSpacing(value: string) { state.letterSpacing = value; },
  };
  return context;
}

function textNode(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: "text:1",
    type: "text",
    box: { x: 10, y: 20, width: 200, height: 200 },
    clip: false,
    opacity: 1,
    strokeWidth: 0,
    radius: 0,
    children: [],
    text: {
      value: "ab",
      fontFamily: "Inter",
      fontSize: 16,
      lineHeight: 20,
      fontWeight: 400,
      fontStyle: "normal",
      align: "left",
      letterSpacing: 0,
      color: "#111111",
    },
    ...overrides,
  };
}

/** 渲染一个节点，返回所有 fillText 调用（带上落笔时的对齐方式）。 */
function draw(node: SceneNode): Draw[] {
  const context = fakeContext();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const renderer = createCanvas2DRenderer(canvas);
  renderer.paint([node], { width: 400, height: 400, zoom: 1, devicePixelRatio: 1, images: new Map() });
  return context.calls
    .filter(call => call.name === "fillText")
    .map(call => ({ text: call.args[0] as string, x: call.args[1] as number, y: call.args[2] as number, align: call.align ?? "left" }));
}

test("draws the list marker right-aligned in the marker area", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listType: "bullet" } }];
  const draws = draw(node);
  // 标记右对齐在正文左侧 4px 处：正文左偏移 = 20（标记区宽度）。
  assert.deepEqual(draws[0], { text: "•", x: 10 + 20 - 4, y: 20, align: "right" });
  // 正文在缩进之后。
  assert.deepEqual(draws[1], { text: "ab", x: 10 + 20, y: 20, align: "left" });
});

test("shifts the body by the indent level", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listType: "bullet", indent: 2 } }];
  const draws = draw(node);
  // 左偏移 = 级别缩进 48 + 标记区 20。
  assert.equal(draws[0]!.x, 10 + 68 - 4);
  assert.equal(draws[1]!.x, 10 + 68);
});

test("draws the number of an ordered list", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listType: "ordered" } }];
  const draws = draw(node);
  assert.equal(draws[0]!.text, "1.");
});

test("does not repeat the marker on the wrapped lines", () => {
  const node = textNode({ box: { x: 10, y: 20, width: 45, height: 200 } });
  node.text!.value = "abcdef";
  node.text!.paragraphStyles = [{ from: 0, to: 6, style: { listType: "bullet" } }];
  const draws = draw(node);
  // 可用宽度 45 - 20 = 25 → 每行两个字，三行。
  assert.equal(draws.filter(item => item.text === "•").length, 1);
  // 后续行不再画标记，但正文仍然与首行左对齐。
  const bodies = draws.filter(item => item.text !== "•");
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0]!.x, bodies[1]!.x);
  assert.equal(bodies[1]!.x, bodies[2]!.x);
});

test("keeps plain text on the old path", () => {
  const draws = draw(textNode());
  assert.deepEqual(draws.map(item => item.text), ["ab"]);
  assert.equal(draws[0]!.x, 10);
});
