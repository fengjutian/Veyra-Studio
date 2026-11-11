import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import { buildScene } from "../src/renderer/scene";
import type { SceneNode } from "../src/renderer/scene";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";

/**
 * 外观新能力在画布上的落法：阴影的扩散半径与内阴影、软蒙版、布尔组的旋转。
 *
 * 画布与 HTML/SVG 必须是同一套语义——差异要么不存在，要么三端都明确标出来。
 */

interface Call { name: string; args: unknown[] }

/** 记录调用的假 2D 上下文；只实现渲染器用到的 API。 */
function fakeContext() {
  const calls: Call[] = [];
  const stack: Array<{ alpha: number; fillStyle: string; font: string; textAlign: string }> = [];
  const state = { alpha: 1, fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "", textAlign: "left", textBaseline: "alphabetic", letterSpacing: "", composite: "source-over", filter: "none" };
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
    fill: (...args: unknown[]) => { calls.push({ name: "fill", args, shadow: context.shadowColor, shadowBlur: context.shadowBlur }); },
    stroke: record("stroke"),
    drawImage: record("drawImage"),
    fillText: record("fillText"),
    measureText: (value: string) => ({ width: value.length * 10 }),
    createLinearGradient: (...args: unknown[]) => { calls.push({ name: "createLinearGradient", args }); return { addColorStop: () => {} }; },
    createRadialGradient: (...args: unknown[]) => { calls.push({ name: "createRadialGradient", args }); return { addColorStop: () => {} }; },
    save: () => { stack.push({ alpha: state.alpha, fillStyle: state.fillStyle, font: state.font, textAlign: state.textAlign }); calls.push({ name: "save", args: [] }); },
    restore: () => {
      const previous = stack.pop();
      if (previous) { state.alpha = previous.alpha; state.fillStyle = previous.fillStyle; state.font = previous.font; state.textAlign = previous.textAlign; }
      calls.push({ name: "restore", args: [] });
    },
    translate: record("translate"),
    rotate: record("rotate"),
    scale: record("scale"),
    ellipse: record("ellipse"),
    canvas: { width: 0, height: 0 },
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
    get filter() { return state.filter; },
    set filter(value: string) { state.filter = value; calls.push({ name: "filter", args: [value] }); },
    get globalCompositeOperation() { return state.composite; },
    set globalCompositeOperation(value: string) { state.composite = value; calls.push({ name: "globalCompositeOperation", args: [value] }); },
  };
  return context;
}

function fakeCanvas(context: ReturnType<typeof fakeContext>) {
  return { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => context } as unknown as HTMLCanvasElement;
}

/** 离屏画布工厂：把离屏层的绘制记录到给定的假上下文里。 */
function fakeSurface(context: ReturnType<typeof fakeContext>) {
  return (width: number, height: number) => ({
    canvas: { width, height } as CanvasImageSource,
    context: context as unknown as CanvasRenderingContext2D,
    width,
    height,
  });
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

const PAINT_OPTIONS = { width: 200, height: 100, zoom: 1, devicePixelRatio: 1, images: new Map<string, CanvasImageSource>() };

test("带扩散半径的投影走离屏合成：先膨胀再模糊", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ fill: "#ffffff", shadow: { x: 4, y: 8, blur: 12, color: "#00000080", spread: 6 } }),
  ], { ...PAINT_OPTIONS, surface: fakeSurface(layer) });

  // 扩散半径靠「沿轮廓描一条 2×spread 宽的边」实现，因此会有一次描边。
  assert.ok(layer.calls.some(call => call.name === "stroke"), "应有膨胀用的描边");
  // 模糊在离屏层上做（Canvas 的 shadow* 没有扩散半径）。
  assert.ok(layer.calls.some(call => call.name === "filter" && call.args[0] === "blur(12px)"), "应有模糊");
  // 投影画在内容下面：离屏层先贴出来，节点自己的填充随后才画。
  const drawIndex = context.calls.findIndex(call => call.name === "drawImage");
  const fillIndex = context.calls.findIndex(call => call.name === "fill");
  assert.ok(drawIndex >= 0 && fillIndex > drawIndex, "投影应先于节点自身的填充");
});

test("内阴影走离屏合成：形状减去模糊并偏移后的自己", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ fill: "#ffffff", shadow: { x: 0, y: 2, blur: 6, color: "#00000040", type: "inner" } }),
  ], { ...PAINT_OPTIONS, surface: fakeSurface(layer) });

  // destination-out 用来挖掉「模糊并偏移后的自己」。
  assert.ok(layer.calls.some(call => call.name === "globalCompositeOperation" && call.args[0] === "destination-out"));
  // 内阴影画在填充之后（CSS box-shadow: inset 的层序：填充之上、内容之下）。
  const fillIndex = layer.calls.findIndex(call => call.name === "fill");
  const eraseIndex = layer.calls.findIndex(call => call.name === "globalCompositeOperation" && call.args[0] === "destination-out");
  assert.ok(eraseIndex > fillIndex, "内阴影应在填充之后");
});

/** 造一个「蒙版 + 被裁剪的兄弟」的场景（走真实的 buildScene，蒙版关系由兄弟顺序决定）。 */
function maskedScene(maskExtra: Partial<DesignNode> = {}): SceneNode[] {
  const document = createDocument("doc:1", "Demo", "page:1");
  const frame = {
    id: "frame",
    type: "frame",
    name: "frame",
    parentId: "page:1",
    childIds: ["mask", "photo"],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 100 },
    appearance: defaultAppearance(),
  } as DesignNode;
  const mask = {
    id: "mask",
    type: "ellipse",
    name: "mask",
    parentId: "frame",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    appearance: defaultAppearance(),
    mask: true,
    ...maskExtra,
  } as DesignNode;
  const photo = {
    id: "photo",
    type: "rectangle",
    name: "photo",
    parentId: "frame",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 100 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ff0000" }] },
  } as DesignNode;
  document.nodes["frame"] = frame;
  document.nodes["mask"] = mask;
  document.nodes["photo"] = photo;
  document.pages["page:1"]!.childIds = ["frame"];
  return buildScene(document, "page:1", {});
}

test("半透明蒙版用离屏合成做半透明裁剪", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  const scene = maskedScene({ appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#00000080" }] } });
  renderer.paint(scene, { ...PAINT_OPTIONS, surface: fakeSurface(layer) });

  // 合成时用 destination-in：内容只在蒙版不透明的地方留下。
  assert.ok(layer.calls.some(call => call.name === "globalCompositeOperation" && call.args[0] === "destination-in"));
  // 蒙版本身不绘制（它的填充色不该出现在画布上）。
  assert.ok(!layer.calls.some(call => call.name === "fillStyle" && call.args[0] === "#00000080"));
});

test("硬蒙版仍然走 clip（与升级前一致）", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint(maskedScene(), { ...PAINT_OPTIONS, surface: fakeSurface(layer) });
  assert.ok(context.calls.some(call => call.name === "clip"));
  assert.ok(!layer.calls.some(call => call.name === "globalCompositeOperation" && call.args[0] === "destination-in"));
});

test("蒙版带羽化时边缘被模糊", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint(maskedScene({ maskFeather: 8 }), { ...PAINT_OPTIONS, surface: fakeSurface(layer) });
  assert.ok(layer.calls.some(call => call.name === "filter" && call.args[0] === "blur(8px)"), "羽化应模糊蒙版轮廓");
});

test("场景里的文字颜色用统一规则（多层取第一层、无填充取默认色）", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  const text = {
    id: "t",
    type: "text",
    name: "t",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 20 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ff0000" }, { type: "solid", color: "#00ff00" }] },
    text: "文字",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 20,
  } as DesignNode;
  const plain = {
    id: "p",
    type: "text",
    name: "p",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 20 },
    appearance: defaultAppearance(),
    text: "文字",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 20,
  } as DesignNode;
  document.nodes["t"] = text;
  document.nodes["p"] = plain;
  document.pages["page:1"]!.childIds = ["t", "p"];
  const scene = buildScene(document, "page:1", {});
  assert.equal(scene[0]?.text?.color, "#ff0000");
  assert.equal(scene[1]?.text?.color, "#111111");
});

test("布尔组的盒子是操作数并集（旋转过的操作数会撑出去）", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  const bool = {
    id: "bool",
    type: "boolean",
    name: "bool",
    parentId: "page:1",
    childIds: ["a", "b"],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    appearance: defaultAppearance(),
    operation: "union",
  } as DesignNode;
  const operand = (id: string, x: number, rotation?: number) => ({
    id,
    type: "rectangle",
    name: id,
    parentId: "bool",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y: 0, width: 100, height: 100, ...(rotation ? { rotation } : {}) },
    appearance: defaultAppearance(),
  } as DesignNode);
  document.nodes["bool"] = bool;
  document.nodes["a"] = operand("a", 0);
  document.nodes["b"] = operand("b", 100, 45);
  document.pages["page:1"]!.childIds = ["bool"];
  const boxes = {
    bool: { x: 0, y: 0, width: 100, height: 100 },
    a: { x: 0, y: 0, width: 100, height: 100 },
    b: { x: 100, y: 0, width: 100, height: 100 },
  };
  const scene = buildScene(document, "page:1", boxes);
  // 第二个操作数转 45° 后伸到 100 + 100/√2 ≈ 170.7。
  assert.ok(scene[0]!.box.width > 165, `宽度 ${scene[0]!.box.width}`);
  assert.ok(scene[0]!.path?.length, "布尔组应当有运算结果路径");
});
