import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import type { SceneNode } from "../src/renderer/scene";

/**
 * 画布上的悬挂列表标记与段落缩进。
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

function draw(node: SceneNode): { draws: Draw[]; rects: number[][] } {
  const context = fakeContext();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const renderer = createCanvas2DRenderer(canvas);
  renderer.paint([node], { width: 400, height: 400, zoom: 1, devicePixelRatio: 1, images: new Map() });
  return {
    draws: context.calls
      .filter(call => call.name === "fillText")
      .map(call => ({ text: call.args[0] as string, x: call.args[1] as number, y: call.args[2] as number, align: call.align ?? "left" })),
    rects: context.calls.filter(call => call.name === "rect").map(call => call.args as number[]),
  };
}

test("draws a hanging marker outside the text box", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listType: "bullet", hanging: true } }];
  const { draws } = draw(node);
  // 标记悬在框外：右边缘停在框的左边界之前 4px。
  assert.deepEqual(draws[0], { text: "•", x: 10 - 4, y: 20, align: "right" });
  // 正文从框的左边缘开始（标记不占宽度）。
  assert.deepEqual(draws[1], { text: "ab", x: 10, y: 20, align: "left" });
});

test("widens the clip area so the hanging marker is not cut off", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listType: "bullet", hanging: true } }];
  const { rects } = draw(node);
  // 标记宽度 10px + 间隙 4px → 裁剪区往左让出 14px。
  assert.deepEqual(rects[0], [10 - 14, 20, 200 + 14, 200]);
});

test("keeps the clip area untouched for a normal list", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listType: "bullet" } }];
  const { rects } = draw(node);
  assert.deepEqual(rects[0], [10, 20, 200, 200]);
});

test("shifts the text by the paragraph indent", () => {
  const node = textNode();
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { paragraphIndent: 30 } }];
  const { draws } = draw(node);
  assert.equal(draws[0]!.x, 10 + 30);
});

test("pushes the next paragraph down by the list spacing", () => {
  const node = textNode();
  node.text!.value = "ab\ncd";
  node.text!.paragraphStyles = [{ from: 0, to: 2, style: { listSpacing: 10 } }];
  const { draws } = draw(node);
  assert.equal(draws[0]!.y, 20);
  // 间距加在第一段的行高上 → 第二段整体下移 10px。
  assert.equal(draws[1]!.y, 20 + 20 + 10);
});
