import { computePageLayout } from "@ufira/design-layout";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { buildScene } from "../src/renderer/scene";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import { cullScene } from "../src/renderer/culling";
import { paintSelectionOverlay } from "../src/renderer/selection-overlay";
import { selectedBoxes, selectionBounds } from "../src/renderer/selection";
import { fixtureDocument } from "./fixture";

/**
 * 画布 harness：像素基线 + 浏览器内绘制耗时。
 *
 * 直接调用渲染器而不是挂载整个工作台：截图只反映 `scene + renderer` 的变化，
 * 不受登录、后端和面板布局影响。构建脚本把打包结果内联进 HTML，`file://` 即可加载。
 *
 * 绘制耗时用独立的离屏 canvas 测，测完再画可视 canvas，所以截图内容不会被测速影响。
 * 结果写进 `#harness-metrics` 的 JSON，脚本通过 Chrome `--dump-dom` 读取。
 */
const WIDTH = 960;
const HEIGHT = 680;
const SIZES = [200, 1000, 5000];
const CULL_VIEWPORT = { x: 0, y: 0, width: 1280, height: 800 };

interface PaintMetrics {
  dpr: number;
  fixtureMs: number;
  sizes: Array<{ nodes: number; fullMs: number; culledMs: number; culledNodes: number }>;
}

async function main(): Promise<void> {
  const doc = fixtureDocument();
  const layout = computePageLayout(doc, "page:1", { viewport: { width: WIDTH, height: HEIGHT } });
  const scene = buildScene(doc, "page:1", layout.boxes);

  const canvas = document.createElement("canvas");
  canvas.id = "stage";
  canvas.style.display = "block";
  document.body.appendChild(canvas);
  const renderer = createCanvas2DRenderer(canvas);

  // 等字体就绪再画，避免截到回退字体。
  await document.fonts.ready.catch(() => undefined);
  const options = { width: WIDTH, height: HEIGHT, zoom: 1, devicePixelRatio: 1, images: new Map([["asset:sample", sampleImage()]]) };

  const fixtureMs = measure(() => renderer.paint(scene, options), 3);
  const sizes = SIZES.map(size => measureSize(size));

  // 最终画面必须是完整 fixture（测速用的是独立 canvas，不会污染截图），
  // 并叠加一个双选选择框，让像素基线同时覆盖选择框绘制。
  const demoSelection = selectionBounds(selectedBoxes(scene, ["card", "accent"]));
  renderer.paint(scene, {
    ...options,
    onAfterPaint: context => {
      if (demoSelection) paintSelectionOverlay(context, demoSelection, { zoom: 1 });
    },
  });

  const metrics: PaintMetrics = { dpr: window.devicePixelRatio, fixtureMs, sizes };
  const pre = document.createElement("pre");
  pre.id = "harness-metrics";
  pre.textContent = JSON.stringify(metrics);
  pre.style.display = "none";
  document.body.appendChild(pre);

  const ready = document.createElement("div");
  ready.id = "harness-ready";
  ready.textContent = `ready:${countNodes(scene)}`;
  ready.style.display = "none";
  document.body.appendChild(ready);
}

function measureSize(size: number): PaintMetrics["sizes"][number] {
  const doc = syntheticDocument(size);
  const layout = computePageLayout(doc, "page:1", { viewport: { width: WIDTH, height: HEIGHT } });
  const scene = buildScene(doc, "page:1", layout.boxes);
  const culled = cullScene(scene, CULL_VIEWPORT);

  const canvas = document.createElement("canvas");
  const renderer = createCanvas2DRenderer(canvas);
  const options = { width: WIDTH, height: HEIGHT, zoom: 1, devicePixelRatio: 1, images: new Map<string, CanvasImageSource>() };

  return {
    nodes: countNodes(scene),
    fullMs: measure(() => renderer.paint(scene, options), 3),
    culledMs: measure(() => renderer.paint(culled, options), 3),
    culledNodes: countNodes(culled),
  };
}

function measure(run: () => void, iterations: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return Math.round(best * 100) / 100;
}

/** 与 design-layout 基准同构的合成文档：绝对定位网格 + 每三个节点一个文本。 */
function syntheticDocument(target: number): DesignDocument {
  const document = createDocument("doc:synthetic", "Synthetic", "page:1");
  const page = document.pages["page:1"]!;
  const columns = Math.ceil(Math.sqrt(target));
  let created = 0;
  let index = 0;
  while (created < target) {
    const x = (index % columns) * 120;
    const y = Math.floor(index / columns) * 80;
    const id = `node:${index}`;
    const isText = index % 3 === 0;
    const base = {
      id,
      name: id,
      parentId: "page:1",
      childIds: [],
      visible: true,
      locked: false,
      layout: { ...defaultLayout(), x, y, width: 110, height: 60 },
      appearance: { ...defaultAppearance(), fill: isText ? "#0f172a" : "#e2e8f0" },
    } as DesignNode;
    document.nodes[id] = isText
      ? ({ ...base, type: "text", text: "示例文字", fontFamily: "Inter", fontSize: 14, lineHeight: 20 } as DesignNode)
      : ({ ...base, type: "frame" } as DesignNode);
    page.childIds.push(id);
    created += 1;
    index += 1;
  }
  return document;
}

/** 用离屏 canvas 生成一张双色样图，cover 裁剪时能看出比例。 */
function sampleImage(): CanvasImageSource {
  const source = document.createElement("canvas");
  source.width = 80;
  source.height = 80;
  const context = source.getContext("2d");
  if (context) {
    context.fillStyle = "#0ea5e9";
    context.fillRect(0, 0, 80, 40);
    context.fillStyle = "#f59e0b";
    context.fillRect(0, 40, 80, 40);
    context.fillStyle = "#ffffff";
    context.beginPath();
    context.arc(40, 40, 18, 0, Math.PI * 2);
    context.fill();
  }
  return source;
}

function countNodes(nodes: ReturnType<typeof buildScene>): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

void main().catch(error => {
  console.error(error);
  const pre = document.createElement("pre");
  pre.id = "harness-error";
  pre.textContent = `${String(error)}\n${(error as Error)?.stack ?? ""}`;
  document.body.appendChild(pre);
});
