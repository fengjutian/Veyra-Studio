/**
 * 画布像素回归。
 *
 *   npm run visual:canvas:baseline
 *   npm run visual:canvas:check
 *   npm run visual:canvas:check -- --threshold=0.001 --require-browser
 *
 * 流程：esbuild 打包 harness → Chrome/Edge headless 截图 → 与
 * `packages/studio-web/visual/canvas.png` 逐像素比较。基线绑定本机字体，跨机器
 * 需要显式 `--update`。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, renderHtmlToPng } from "../../design-export/visual/browser";
import { decodePng, diffImages, encodePng } from "../../design-export/visual/png";
import { buildHarness } from "./build-harness";

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, "canvas.png");
const DIFF = join(here, "canvas.diff.png");
const RENDERED = join(here, ".cache", "canvas.rendered.png");

interface Args {
  update: boolean;
  threshold: number;
  requireBrowser: boolean;
  width: number;
  height: number;
  browserPath?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    update: argv.includes("--update"),
    threshold: Number(value("--threshold=") ?? 0.003),
    requireBrowser: argv.includes("--require-browser"),
    width: Number(value("--width=") ?? 960),
    height: Number(value("--height=") ?? 680),
    browserPath: value("--browser="),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!findBrowser()) {
    const message = "未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）";
    if (args.requireBrowser) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(`${message}，跳过画布像素回归。`);
    }
    return;
  }

  const html = await buildHarness();
  mkdirSync(dirname(RENDERED), { recursive: true });
  await renderHtmlToPng({ htmlPath: html, outPath: RENDERED, width: args.width, height: args.height, browserPath: args.browserPath });
  const rendered = decodePng(readFileSync(RENDERED));

  if (args.update) {
    writeFileSync(BASELINE, encodePng(rendered));
    console.log(`已更新画布基线：${BASELINE}`);
    return;
  }

  let baseline: ReturnType<typeof decodePng>;
  try {
    baseline = decodePng(readFileSync(BASELINE));
  } catch (error) {
    console.error(`读取画布基线失败：${error instanceof Error ? error.message : String(error)}；先运行 npm run visual:canvas:baseline`);
    process.exitCode = 1;
    return;
  }

  const diff = diffImages(baseline, rendered);
  writeFileSync(DIFF, encodePng(diff.image));
  console.log(`画布差异像素：${diff.differentPixels}/${diff.totalPixels}（${(diff.ratio * 100).toFixed(3)}%），最大通道差 ${diff.maxChannelDelta}`);
  console.log(`差异图：${DIFF}`);
  if (diff.ratio > args.threshold) {
    console.error(`超过阈值 ${(args.threshold * 100).toFixed(3)}%：画布像素回归失败`);
    process.exitCode = 1;
  }
}

void main();
