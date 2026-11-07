import assert from "node:assert/strict";
import test from "node:test";
import { paintDrawPreview } from "../src/renderer/selection-overlay";

interface Call { name: string; args: unknown[] }

/** 记录调用的假 2D 上下文：只实现绘制预览用到的 API。 */
function fakeContext() {
  const calls: Call[] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }); };
  let lineWidth = 1;
  return {
    calls,
    save: record("save"),
    restore: record("restore"),
    beginPath: record("beginPath"),
    rect: record("rect"),
    ellipse: record("ellipse"),
    fill: record("fill"),
    stroke: record("stroke"),
    setLineDash: record("setLineDash"),
    get lineWidth() { return lineWidth; },
    set lineWidth(value: number) { lineWidth = value; calls.push({ name: "lineWidth", args: [value] }); },
  };
}

const canvas = (context: ReturnType<typeof fakeContext>) => context as unknown as CanvasRenderingContext2D;

test("draws the preview as a dashed rectangle", () => {
  const context = fakeContext();
  paintDrawPreview(canvas(context), { x: 10, y: 20, width: 120, height: 80 }, { zoom: 1 });
  const names = context.calls.map(call => call.name);
  // 必须是一条闭合路径：填充之后再描边，虚线只在描边这一层。
  assert.deepEqual(names, ["save", "lineWidth", "setLineDash", "beginPath", "rect", "fill", "stroke", "restore"]);
  assert.deepEqual(context.calls.find(call => call.name === "setLineDash")?.args[0], [4, 3]);
  assert.deepEqual(context.calls.find(call => call.name === "rect")?.args, [10, 20, 120, 80]);
});

test("keeps the dash and stroke width at screen size when zoomed", () => {
  const context = fakeContext();
  paintDrawPreview(canvas(context), { x: 0, y: 0, width: 40, height: 40 }, { zoom: 2 });
  assert.deepEqual(context.calls.find(call => call.name === "setLineDash")?.args[0], [2, 1.5]);
  assert.equal(context.calls.find(call => call.name === "lineWidth")?.args[0], 0.75);
});

test("uses an ellipse path for the ellipse tool", () => {
  const context = fakeContext();
  paintDrawPreview(canvas(context), { x: 0, y: 0, width: 100, height: 60 }, { zoom: 1, shape: "ellipse" });
  const names = context.calls.map(call => call.name);
  assert.ok(names.includes("ellipse"));
  assert.ok(!names.includes("rect"));
  // 椭圆以矩形中心为圆心、半宽半高为半径。
  assert.deepEqual(context.calls.find(call => call.name === "ellipse")?.args.slice(0, 5), [50, 30, 50, 30, 0]);
});

test("never draws a negative extent", () => {
  const context = fakeContext();
  paintDrawPreview(canvas(context), { x: 5, y: 5, width: -30, height: -10 }, { zoom: 1 });
  assert.deepEqual(context.calls.find(call => call.name === "rect")?.args, [5, 5, 0, 0]);
});
