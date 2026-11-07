/**
 * 画布绘制基线。
 *
 *   npm run bench:paint
 *   npm run bench:paint -- --budget
 *
 * 在 Node 里用记录调用的假 2D 上下文跑渲染器：不测真实 GPU/光栅化，但能稳定测出
 * 「场景构建 + 遍历节点 + 发出绘制调用」的成本，以及视口裁剪减少了多少根节点。
 * 真实浏览器里的光栅化耗时以后由 harness 页面自报（见 docs/canvas-renderer-roadmap.md）。
 */
import { computePageLayout } from "@ufira/design-layout";
import { documentWithNodes } from "../../design-layout/bench/layout-bench";
import { buildScene, type SceneNode } from "../src/renderer/scene";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import { cullScene, countSceneNodes } from "../src/renderer/culling";

interface Case {
  requestedNodes: number;
  nodes: number;
  paintedNodes: number;
  paintMs: number;
  drawCalls: number;
}

const SIZES = [200, 1000, 5000];
const ITERATIONS: Record<number, number> = { 200: 20, 1000: 8, 5000: 3 };
const VIEWPORT = { x: 0, y: 0, width: 1280, height: 800 };
const BUDGET_MS: Record<number, number> = { 200: 120, 1000: 400, 5000: 1600 };

interface FakeContext {
  calls: number;
}

function fakeContext(): { context: CanvasRenderingContext2D; stats: FakeContext } {
  const stats: FakeContext = { calls: 0 };
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "top",
    letterSpacing: "",
  };
  const noop = () => undefined;
  const context = new Proxy(state, {
    get(target, property) {
      if (property === "measureText") return (value: string) => ({ width: value.length * 7 });
      if (property in target) return target[property as string];
      return (...args: unknown[]) => {
        if (["fill", "stroke", "fillText", "drawImage", "fillRect", "clip"].includes(String(property))) stats.calls += 1;
        void args;
        return undefined;
      };
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  void noop;
  return { context, stats };
}

function fakeCanvas(context: CanvasRenderingContext2D): HTMLCanvasElement {
  return { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => context } as unknown as HTMLCanvasElement;
}

function run(size: number): Case {
  const document = documentWithNodes(size);
  const layout = computePageLayout(document, "page:1", { viewport: { width: 960, height: 680 } });
  const scene = buildScene(document, "page:1", layout.boxes);
  const visible = cullScene(scene, VIEWPORT);
  const { context, stats } = fakeContext();
  const renderer = createCanvas2DRenderer(fakeCanvas(context));

  const iterations = ITERATIONS[size] ?? 3;
  let paintMs = Number.POSITIVE_INFINITY;
  for (let index = 0; index < iterations; index += 1) {
    stats.calls = 0;
    const started = process.hrtime.bigint();
    renderer.paint(visible, { width: 960, height: 680, zoom: 1, devicePixelRatio: 1, images: new Map() });
    paintMs = Math.min(paintMs, Number(process.hrtime.bigint() - started) / 1e6);
  }

  return {
    requestedNodes: size,
    nodes: countSceneNodes(scene),
    paintedNodes: countSceneNodes(visible),
    paintMs,
    drawCalls: stats.calls,
  };
}

const cases = SIZES.map(run);
const enforceBudget = process.argv.includes("--budget");
const json = process.argv.includes("--json");
const failures = cases.filter(item => enforceBudget && item.paintMs > (BUDGET_MS[item.requestedNodes] ?? Infinity));

if (json) {
  console.log(JSON.stringify({ cases, budget: BUDGET_MS, failed: failures.map(item => item.requestedNodes), viewport: VIEWPORT }, null, 2));
} else {
  console.log("目标节点\t场景节点\t绘制节点\t耗时(ms)\t绘制调用\t预算(ms)");
  for (const item of cases) {
    console.log(`${item.requestedNodes}\t\t${item.nodes}\t\t${item.paintedNodes}\t\t${item.paintMs.toFixed(1)}\t\t${item.drawCalls}\t\t${BUDGET_MS[item.requestedNodes] ?? "-"}`);
  }
}

if (failures.length) {
  console.error(`绘制超预算：${failures.map(item => `${item.requestedNodes} 节点 ${item.paintMs.toFixed(1)}ms`).join("，")}`);
  process.exitCode = 1;
}

export type { Case, SceneNode };
