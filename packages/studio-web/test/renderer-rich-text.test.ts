import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import type { SceneNode } from "../src/renderer/scene";

interface Call { name: string; args: unknown[] }

/** 只实现渲染器文字绘制路径用到的 API；measureText 固定 10px/字符，便于断言换行。 */
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
    fillText: record("fillText"),
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
    box: { x: 10, y: 20, width: 40, height: 80 },
    clip: false,
    opacity: 1,
    strokeWidth: 0,
    radius: 0,
    children: [],
    text: {
      value: "abcdef",
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

test("draws rich text run by run with the run's own font and color", () => {
  const context = fakeContext();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const renderer = createCanvas2DRenderer(canvas);
  const node = textNode();
  node.text!.runs = [
    { from: 0, to: 2, style: { fontWeight: 700 } },
    { from: 2, to: 4, style: { color: "#ef4444" } },
  ];

  renderer.paint([node], { width: 100, height: 100, zoom: 1, devicePixelRatio: 1, images: new Map() });

  const draws = context.calls.filter(call => call.name === "fillText");
  // 40px 宽、10px/字符 → 每行 4 个字符：第一行 "ab"+"cd"，第二行 "ef"。
  assert.deepEqual(draws.map(call => call.args[0]), ["ab", "cd", "ef"]);
  assert.deepEqual(draws.map(call => call.args[1]), [10, 30, 10]);
  assert.ok(context.calls.some(call => call.name === "font" && String(call.args[0]).includes("700")), "bold run should set a 700 font");
  assert.ok(context.calls.some(call => call.name === "font" && String(call.args[0]).includes("400")), "regular run should set a 400 font");
  assert.ok(context.calls.some(call => call.name === "fillStyle" && call.args[0] === "#ef4444"), "colored run should switch fillStyle");
});

test("draws plain text with one fill per line, as before", () => {
  const context = fakeContext();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  createCanvas2DRenderer(canvas).paint([textNode()], { width: 100, height: 100, zoom: 1, devicePixelRatio: 1, images: new Map() });
  const draws = context.calls.filter(call => call.name === "fillText");
  assert.equal(draws.length, 2);
  assert.deepEqual(draws.map(call => call.args[0]), ["abcd", "ef"]);
});

test("a larger run advances the next line by that line's height", () => {
  const context = fakeContext();
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const renderer = createCanvas2DRenderer(canvas);
  const node = textNode();
  node.text!.runs = [{ from: 0, to: 2, style: { fontSize: 40 } }];

  renderer.paint([node], { width: 100, height: 100, zoom: 1, devicePixelRatio: 1, images: new Map() });

  const draws = context.calls.filter(call => call.name === "fillText");
  assert.deepEqual(draws.map(call => [call.args[0], call.args[2]]), [["ab", 20], ["cd", 20], ["ef", 60]]);
  assert.ok(context.calls.some(call => call.name === "font" && String(call.args[0]).includes("40px")), "large run should use its own font size");
});