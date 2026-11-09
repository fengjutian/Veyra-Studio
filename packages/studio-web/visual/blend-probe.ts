/**
 * 画布混合模式能力探针。
 *
 *   npx tsx packages/studio-web/visual/blend-probe.ts
 *
 * 回答一个问题：**Canvas 的 `globalCompositeOperation` 画出来的混合效果，
 * 和 CSS 的 `mix-blend-mode` 是不是同一个东西？**
 *
 * 做法是让浏览器自己当裁判：同一张图里，CSS 舞台用 `mix-blend-mode`，
 * 旁边的 canvas 用 `globalCompositeOperation`，截屏后逐像素比对重叠区域。
 * 两边颜色一致 → 这个模式在画布上可用且语义与 CSS 一致；
 * 不一致 → 要么浏览器忽略了那个值（退回 source-over），要么语义不同。
 *
 * 为什么要有这个探针：文档（MDN / HTML 规范）里 Canvas 的合成操作列表与
 * CSS 混合模式是**两套东西**，容易记混。渲染器的取舍必须建立在实测上，
 * 而不是「我记得 Canvas 不支持某某模式」。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtmlToPng } from "../../design-export/visual/browser";
import { decodePng, type RgbaImage } from "../../design-export/visual/png";

/** 与 CSS `mix-blend-mode` 同名的 16 种模式。 */
const MODES = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
] as const;

/** 舞台尺寸（CSS 像素）；左侧 CSS 舞台，右侧 canvas 舞台。 */
const STAGE = 200;
/** 源色块在舞台里的位置与大小。 */
const SOURCE = { x: 50, y: 50, size: 100 };
/** 底色与源色：刻意选成饱和度/明度都不同的两个颜色，否则某些模式的结果会与 source-over 撞色。 */
const BACKDROP = "rgb(255,128,0)";
const SOURCE_COLOR = "rgb(128,128,255)";

const here = dirname(fileURLToPath(import.meta.url));
const WORK = join(here, ".cache", "blend-probe");

interface Rgb { r: number; g: number; b: number; a: number }

function html(mode: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #ffffff; }
  .row { display: flex; }
  .stage { width: ${STAGE}px; height: ${STAGE}px; position: relative; isolation: isolate; }
  .backdrop { position: absolute; inset: 0; background: ${BACKDROP}; }
  .source { position: absolute; left: ${SOURCE.x}px; top: ${SOURCE.y}px; width: ${SOURCE.size}px; height: ${SOURCE.size}px; background: ${SOURCE_COLOR}; mix-blend-mode: ${mode}; }
  canvas { display: block; }
</style></head>
<body>
<div class="row">
  <div class="stage"><div class="backdrop"></div><div class="source"></div></div>
  <canvas id="stage" width="${STAGE}" height="${STAGE}"></canvas>
</div>
<script>
  const ctx = document.getElementById("stage").getContext("2d");
  ctx.fillStyle = ${JSON.stringify(BACKDROP)};
  ctx.fillRect(0, 0, ${STAGE}, ${STAGE});
  ctx.globalCompositeOperation = ${JSON.stringify(mode)};
  ctx.fillStyle = ${JSON.stringify(SOURCE_COLOR)};
  ctx.fillRect(${SOURCE.x}, ${SOURCE.y}, ${SOURCE.size}, ${SOURCE.size});
</script>
</body></html>`;
}

/** 取一个像素（PNG 是 RGBA，内存里按 4 字节一个通道存放）。 */
function pixelAt(image: RgbaImage, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4;
  return { r: image.data[offset]!, g: image.data[offset + 1]!, b: image.data[offset + 2]!, a: image.data[offset + 3]! };
}

function color(rgb: Rgb): string {
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${rgb.a})`;
}

async function probe(): Promise<void> {
  mkdirSync(WORK, { recursive: true });
  const rows: string[] = [];
  let mismatched = 0;
  for (const mode of MODES) {
    const htmlPath = join(WORK, `${mode}.html`);
    const pngPath = join(WORK, `${mode}.png`);
    writeFileSync(htmlPath, html(mode), "utf8");
    await renderHtmlToPng({ htmlPath, outPath: pngPath, width: STAGE * 2, height: STAGE });
    const image = decodePng(await readFile(pngPath));
    // 重叠区域的中心点：CSS 舞台在左，canvas 舞台在右。
    const cssPixel = pixelAt(image, SOURCE.x + SOURCE.size / 2, SOURCE.y + SOURCE.size / 2);
    const canvasPixel = pixelAt(image, STAGE + SOURCE.x + SOURCE.size / 2, SOURCE.y + SOURCE.size / 2);
    const same = cssPixel.r === canvasPixel.r && cssPixel.g === canvasPixel.g && cssPixel.b === canvasPixel.b;
    if (!same) mismatched += 1;
    rows.push(`${same ? "一致  " : "不一致"}  ${mode.padEnd(13)} CSS=${color(cssPixel).padEnd(22)} Canvas=${color(canvasPixel)}`);
  }
  console.log(rows.join("\n"));
  console.log(`\n${MODES.length - mismatched}/${MODES.length} 种模式在画布上与 CSS 一致。`);
}

async function readFile(path: string): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path);
}

void probe().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
