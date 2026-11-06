import { computePageLayout } from "@ufira/design-layout";
import { buildScene } from "../src/renderer/scene";
import { createCanvas2DRenderer } from "../src/renderer/canvas-renderer";
import { fixtureDocument } from "./fixture";

/**
 * 画布像素基线的入口页。
 *
 * 直接调用渲染器而不是挂载整个工作台：这样截图只反映 `scene + renderer` 的变化，
 * 不受登录、后端和面板布局影响。构建脚本会把打包结果内联进 HTML，`file://` 即可
 * 加载，不需要 dev server。
 */
const WIDTH = 960;
const HEIGHT = 680;

async function main(): Promise<void> {
  const doc = fixtureDocument();
  const layout = computePageLayout(doc, "page:1", { viewport: { width: WIDTH, height: HEIGHT } });
  const scene = buildScene(doc, "page:1", layout.boxes);

  const canvas = document.createElement("canvas");
  canvas.id = "stage";
  canvas.style.display = "block";
  document.body.appendChild(canvas);

  // 等字体就绪再画，避免截到回退字体。
  await document.fonts.ready.catch(() => undefined);

  const renderer = createCanvas2DRenderer(canvas);
  renderer.paint(scene, { width: WIDTH, height: HEIGHT, zoom: 1, devicePixelRatio: 1, images: new Map([["asset:sample", sampleImage()]]) });

  const ready = document.createElement("div");
  ready.id = "harness-ready";
  ready.textContent = `ready:${countNodes(scene)}`;
  ready.style.display = "none";
  document.body.appendChild(ready);
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
  pre.textContent = `${String(error)}\n${(error as Error)?.stack ?? ""}`;
  document.body.appendChild(pre);
});
