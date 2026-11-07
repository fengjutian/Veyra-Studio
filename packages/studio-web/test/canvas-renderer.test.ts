import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import type { SceneNode } from "../src/renderer/scene";

interface Call { name: string; args: unknown[] }

/** 记录调用的假 2D 上下文；只实现渲染器用到的 API。 */
function fakeContext() {
  const calls: Call[] = [];
  const stack: Array<{ alpha: number; fillStyle: string; font: string; textAlign: string }> = [];
  const state = { alpha: 1, fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "", textAlign: "left", textBaseline: "alphabetic", letterSpacing: "" };
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  const context = {
    calls,
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    beginPath: record("beginPath"),
    rect: record("rect"),
    clip: record("clip"),
    moveTo: record("moveTo"),
    arcTo: record("arcTo"),
    closePath: record("closePath"),
    fill: record("fill"),
    stroke: record("stroke"),
    drawImage: record("drawImage"),
    fillText: record("fillText"),
    measureText: (value: string) => ({ width: value.length * 10 }),
    save: () => { stack.push({ alpha: state.alpha, fillStyle: state.fillStyle, font: state.font, textAlign: state.textAlign }); calls.push({ name: "save", args: [] }); },
    restore: () => {
      const previous = stack.pop();
      if (previous) { state.alpha = previous.alpha; state.fillStyle = previous.fillStyle; state.font = previous.font; state.textAlign = previous.textAlign; }
      calls.push({ name: "restore", args: [] });
    },
    get globalAlpha() { return state.alpha; },
    set globalAlpha(value: number) { state.alpha = value; calls.push({ name: "globalAlpha", args: [value] }); },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(value: string) { state.fillStyle = value; calls.push({ name: "fillStyle", args: [value] }); },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(value: string) { state.strokeStyle = value; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(value: number) { state.lineWidth = value; },
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

function fakeCanvas(context: ReturnType<typeof fakeContext>) {
  return { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => context } as unknown as HTMLCanvasElement;
}

function sceneNode(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    id: "node:1",
    type: "frame",
    box: { x: 10, y: 20, width: 100, height: 50 },
    clip: false,
    opacity: 1,
    strokeWidth: 0,
    radius: 0,
    children: [],
    ...overrides,
  };
}

test("sizes the backing store by zoom and device pixel ratio", () => {
  const context = fakeContext();
  const canvas = fakeCanvas(context);
  const renderer = createCanvas2DRenderer(canvas);
  renderer.paint([], { width: 100, height: 50, zoom: 2, devicePixelRatio: 2, images: new Map() });
  assert.equal(canvas.width, 400);
  assert.equal(canvas.height, 200);
  // CSS 尺寸不乘 zoom（外层容器负责缩放），位图分辨率才乘。\n  assert.equal(canvas.style.width, "100px");
  assert.deepEqual(context.calls[0]?.name, "setTransform");
  assert.deepEqual(context.calls[0]?.args, [4, 0, 0, 4, 0, 0]);
});

test("fills shapes, strokes borders and clips container children", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([sceneNode({ fill: "#f8fafc", stroke: "#0f172a", strokeWidth: 2, radius: 8, clip: true, children: [sceneNode({ id: "child", box: { x: 0, y: 0, width: 10, height: 10 }, fill: "#f00", clip: false })] })] , { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  const names = context.calls.map(call => call.name);
  assert.ok(names.includes("fill"));
  assert.ok(names.includes("stroke"));
  assert.equal(names.filter(name => name === "clip").length, 1);
  assert.ok(context.calls.some(call => call.name === "fillStyle" && call.args[0] === "#f00"));
});

test("draws wrapped text lines and skips invisible nodes", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({
      type: "text",
      box: { x: 10, y: 20, width: 40, height: 50 },
      fill: "#111111",
      text: { value: "abcdef", fontFamily: "Inter", fontSize: 20, lineHeight: 24, fontWeight: 400, fontStyle: "normal", align: "left", letterSpacing: 0, color: "#111111" },
    }),
    sceneNode({ id: "hidden", opacity: 0 }),
    sceneNode({ id: "empty", box: { x: 0, y: 0, width: 0, height: 0 } }),
  ], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });

  const textCalls = context.calls.filter(call => call.name === "fillText");
  assert.equal(textCalls.length, 2);
  assert.equal(textCalls[0]?.args[0], "abcd");
  assert.equal(textCalls[1]?.args[0], "ef");
  assert.deepEqual(textCalls[0]?.args.slice(1), [10, 20]);
});

test("draws cover images with clipping and placeholders when the asset is missing", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  const image = { width: 50, height: 100 } as CanvasImageSource;
  renderer.paint([
    sceneNode({ type: "image", image: { assetId: "asset:1", fit: "cover" } }),
    sceneNode({ id: "missing", type: "image", image: { assetId: "asset:2", fit: "contain" } }),
  ], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map([["asset:1", image]]) });

  const draws = context.calls.filter(call => call.name === "drawImage");
  assert.equal(draws.length, 1);
  // cover：源图 50x100 画进 100x50 → 放大 2 倍，宽度溢出后被裁掉。
  // cover：源图 50x100 画进 100x50 → 放大 2 倍，高度 200 溢出后被裁掉。
  assert.deepEqual(draws[0]?.args.slice(1), [10, -55, 100, 200]);
  // 缺图占位只画一次灰色填充（图片节点本身没有背景）。
  assert.ok(context.calls.filter(call => call.name === "fill").length >= 1);
});

test("draws per-corner radii as four separate arcs", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([sceneNode({ fill: "#000000", radii: [4, 8, 12, 16] })], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  // 顺序：右上、右下、左下、左上（从 moveTo(左上切点) 出发绕一圈）。
  const arcs = context.calls.filter(call => call.name === "arcTo");
  assert.deepEqual(arcs.map(call => call.args[4]), [8, 12, 16, 4]);
});

test("clamps per-corner radii to half of the short side", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  // 50 高的盒子：任何角都不能超过 25，否则弧线会互相穿透。
  renderer.paint([sceneNode({ fill: "#000000", radii: [10, 100, 100, 10] })], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  const arcs = context.calls.filter(call => call.name === "arcTo");
  // 顺序：右上、右下、左下、左上；只有后两个角超过上限，被钳到 25。
  assert.deepEqual(arcs.map(call => call.args[4]), [25, 25, 10, 10]);
});