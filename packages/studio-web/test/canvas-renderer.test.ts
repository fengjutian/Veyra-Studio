import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import type { SceneNode } from "../src/renderer/scene";

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
    // 记录填充瞬间的阴影状态：多层填充时阴影只在第一层生效，事后看最终值看不出来。
    fill: (...args: unknown[]) => { calls.push({ name: "fill", args, shadow: context.shadowColor, shadowBlur: context.shadowBlur }); },
    stroke: record("stroke"),
    drawImage: record("drawImage"),
    fillText: record("fillText"),
    measureText: (value: string) => ({ width: value.length * 10 }),
    createLinearGradient: (...args: unknown[]) => { calls.push({ name: "createLinearGradient", args }); return { addColorStop: (offset: number, color: string) => calls.push({ name: "addColorStop", args: [offset, color] }) }; },
    createRadialGradient: (...args: unknown[]) => { calls.push({ name: "createRadialGradient", args }); return { addColorStop: (offset: number, color: string) => calls.push({ name: "addColorStop", args: [offset, color] }) }; },
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
    // 背景模糊要从主画布快照，渲染器读的是 context.canvas。
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
    // 滤镜要能被断言「模糊半径是多少」，所以走 setter 记录调用。
    get filter() { return state.filter; },
    set filter(value: string) { state.filter = value; calls.push({ name: "filter", args: [value] }); },
    // 混合模式落到 Canvas 的 globalCompositeOperation。
    get globalCompositeOperation() { return state.composite; },
    set globalCompositeOperation(value: string) { state.composite = value; calls.push({ name: "globalCompositeOperation", args: [value] }); },
    // 渲染器用 `"filter" in context` 判断浏览器是否支持 canvas filter；
    // filter 用上面的 getter/setter 记录调用。
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
test("paints the drop shadow with the node's offset and blur", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ fill: "#ffffff", shadow: { x: 4, y: 8, blur: 12, color: "#00000080" } }),
  ], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  // 填充那一刻的阴影状态才是真正生效的。
  const painted = context.calls.find(call => call.name === "fill" && call.shadow === "#00000080");
  assert.ok(painted, "expected the shadow to be active while filling");
  assert.equal(painted.shadowBlur, 12);
});

test("resets the shadow before drawing a child so effects are not inherited", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  const child = sceneNode({ id: "child", box: { x: 0, y: 0, width: 10, height: 10 }, fill: "#f00", clip: false });
  renderer.paint([
    sceneNode({ fill: "#ffffff", shadow: { x: 4, y: 8, blur: 12, color: "#00000080" }, children: [child] }),
  ], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  // 最后一个绘制的是子节点，它不该继承父节点的阴影。
  assert.equal(context.shadowColor, "transparent");
  assert.equal(context.shadowBlur, 0);
});

test("applies layer blur as a canvas filter", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([sceneNode({ fill: "#000000", blur: 6 })], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  assert.equal(context.filter, "blur(6px)");
});
test("paints a linear gradient from the shared gradient line", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ paints: [{ type: "linear", angle: 90, stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#ffffff" }] }] }),
  ], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  const gradient = context.calls.find(call => call.name === "createLinearGradient");
  assert.ok(gradient);
  // 90deg = 从左到右：起止点在盒子中线两侧。
  assert.deepEqual(gradient.args, [10, 45, 110, 45]);
  const stops = context.calls.filter(call => call.name === "addColorStop").map(call => call.args);
  assert.deepEqual(stops, [[0, "#111111"], [1, "#ffffff"]]);
});
test("paints every fill layer and casts the shadow only once", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  const before = context.calls.filter(call => call.name === "fill").length;
  renderer.paint([
    sceneNode({
      paints: [{ type: "solid", color: "#ff0000" }, { type: "solid", color: "#00ff00" }],
      shadow: { x: 0, y: 4, blur: 8, color: "#00000080" },
    }),
  ], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map() });
  const fills = context.calls.filter(call => call.name === "fill").length - before;
  assert.equal(fills, 2);
  // 阴影只投一次，否则两层填充会把影子叠得更黑。
  assert.equal(context.shadowColor, "transparent");
});
test("paints a radial gradient from the box centre", () => {
  const context = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ paints: [{ type: "radial", cx: 0.5, cy: 0.5, r: 0.5, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }] }),
  ], { width: 120, height: 40, zoom: 1, devicePixelRatio: 1, images: new Map() });
  const radial = context.calls.find(call => call.name === "createRadialGradient");
  assert.ok(radial);
  // 测试夹具的盒子是 100×50、位于 (10,20)：中心 (60,45)，半径 = 长边(100) × 0.5 = 50。
  assert.deepEqual(radial.args, [60, 45, 0, 60, 45, 50]);
});

test("混合模式按图层组离屏合成：节点与整棵子树一起参与混合", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({
      fill: "#ff0000",
      blendMode: "multiply",
      children: [sceneNode({ id: "child", box: { x: 12, y: 22, width: 20, height: 10 }, fill: "#00ff00", clip: false })],
    }),
  ], { width: 200, height: 100, zoom: 1, devicePixelRatio: 1, images: new Map(), surface: fakeSurface(layer) });

  // 节点自己的填充与子树都画在离屏层上——主画布不直接画它们。
  assert.ok(layer.calls.some(call => call.name === "fillStyle" && call.args[0] === "#ff0000"));
  assert.ok(layer.calls.some(call => call.name === "fillStyle" && call.args[0] === "#00ff00"));
  assert.ok(!context.calls.some(call => call.name === "fillStyle" && call.args[0] === "#00ff00"));
  // 主画布只把整张离屏层贴一次，并且用混合模式合成。
  const draws = context.calls.filter(call => call.name === "drawImage");
  assert.equal(draws.length, 1);
  // 包围盒就是节点盒子（子树在盒子内）：(10,20) 起点、100×50。
  assert.deepEqual(draws[0]?.args.slice(1), [10, 20, 100, 50]);
  assert.equal(context.globalCompositeOperation, "multiply");
});

test("颜色类混合模式在画布上直接生效，不再退回 normal", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const warnings: string[] = [];
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([sceneNode({ fill: "#000000", blendMode: "hue" })], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map(), surface: fakeSurface(layer), onWarning: message => warnings.push(message) });
  assert.equal(context.globalCompositeOperation, "hue");
  assert.deepEqual(warnings, []);
});

test("没有离屏画布时混合模式退化为就地混合，并明确给出警告", () => {
  const context = fakeContext();
  const warnings: string[] = [];
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([sceneNode({ fill: "#000000", blendMode: "multiply" })], { width: 100, height: 50, zoom: 1, devicePixelRatio: 1, images: new Map(), onWarning: message => warnings.push(message) });
  assert.equal(context.globalCompositeOperation, "multiply");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /离屏画布/);
});

test("背景模糊：把节点后面的内容快照、模糊，再按形状裁剪贴回", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([sceneNode({ fill: "#000000", backgroundBlur: 6 })], { width: 200, height: 100, zoom: 1, devicePixelRatio: 1, images: new Map(), surface: fakeSurface(layer) });
  // 离屏层上先挂上模糊滤镜，再从主画布取快照。
  assert.ok(layer.calls.some(call => call.name === "filter" && call.args[0] === "blur(6px)"), "离屏层应先设置模糊滤镜");
  const snapshots = layer.calls.filter(call => call.name === "drawImage");
  assert.equal(snapshots.length, 1);
  // 快照区域是节点盒子外扩模糊半径的余量：(10-12, 20-12) 起，124×74。
  assert.deepEqual(snapshots[0]?.args.slice(1, 5), [-2, 8, 124, 74]);
  // 贴回主画布时要按节点形状裁剪，形状之外保持清晰。
  assert.ok(context.calls.some(call => call.name === "clip"));
  const draws = context.calls.filter(call => call.name === "drawImage");
  assert.equal(draws.length, 1);
  assert.deepEqual(draws[0]?.args.slice(1), [-2, 8, 124, 74]);
});

test("椭圆渐变用离屏画布贴回，并按形状裁剪", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ paints: [{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }] }),
  ], { width: 120, height: 40, zoom: 1, devicePixelRatio: 1, images: new Map(), surface: fakeSurface(layer) });
  const draws = context.calls.filter(call => call.name === "drawImage");
  assert.equal(draws.length, 1);
  // 离屏是正方形（512×512），贴回时按椭圆的两个半轴非等比缩放。
  assert.deepEqual(draws[0]?.args.slice(1), [-256, -256, 512, 512]);
  const scales = context.calls.filter(call => call.name === "scale");
  assert.equal(scales.length, 1);
  // 半轴 (50, 12.5)，离屏半径 256 → 缩放比。
  assert.deepEqual(scales[0]?.args, [50 / 256, 12.5 / 256]);
  // 渐变必须被裁到形状里，否则会糊到形状外面。
  assert.ok(context.calls.some(call => call.name === "clip"));
});

test("椭圆渐变带旋转角时绕中心旋转", () => {
  const context = fakeContext();
  const layer = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ paints: [{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, angle: 90, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }] }),
  ], { width: 120, height: 40, zoom: 1, devicePixelRatio: 1, images: new Map(), surface: fakeSurface(layer) });
  const rotations = context.calls.filter(call => call.name === "rotate");
  assert.equal(rotations.length, 1);
  assert.ok(Math.abs(Number(rotations[0]?.args[0]) - Math.PI / 2) < 1e-9);
});

test("椭圆渐变缺少离屏画布时退化成圆形渐变并给出警告", () => {
  const context = fakeContext();
  const warnings: string[] = [];
  const renderer = createCanvas2DRenderer(fakeCanvas(context));
  renderer.paint([
    sceneNode({ paints: [{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }] }),
  ], { width: 120, height: 40, zoom: 1, devicePixelRatio: 1, images: new Map(), onWarning: message => warnings.push(message) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /椭圆渐变/);
  // 退化路径至少要画出一个圆形径向渐变，而不是什么都不画。
  assert.ok(context.calls.some(call => call.name === "createRadialGradient"));
});