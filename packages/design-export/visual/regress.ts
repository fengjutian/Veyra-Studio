/**
 * 视觉回归 CLI。
 *
 *   npm run visual:baseline     # 重新生成基线（明确执行才会覆盖）
 *   npm run visual:check        # 渲染并与基线比较，超阈值退出 1
 *   npm run visual:check -- --threshold=0.001 --require-browser
 *
 * 基线是"本机浏览器 + 本机字体"的产物，跨机器直接比会因抗锯齿/字体回退产生
 * 差异。所以默认允许 0.5% 的像素差异，并把差异图写到基线旁边便于人工确认。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtmlToPng, findBrowser } from "./browser";
import { decodePng, diffImages, encodePng } from "./png";

const here = dirname(fileURLToPath(import.meta.url));
/** golden fixture 的 HTML 由 design-export 的基线测试生成，这里直接复用。 */
const GOLDEN_DIRECTORY = join(here, "..", "test", "golden");
const DEFAULT_HTML = join(GOLDEN_DIRECTORY, "page.html");
const DEFAULT_BASELINE = join(GOLDEN_DIRECTORY, "page.png");
const DEFAULT_DIFF = join(GOLDEN_DIRECTORY, "page.diff.png");

interface Args {
  update: boolean;
  threshold: number;
  requireBrowser: boolean;
  htmlPath: string;
  baselinePath: string;
  diffPath: string;
  width: number;
  height: number;
  browserPath?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    update: argv.includes("--update"),
    threshold: Number(value("--threshold=") ?? 0.005),
    requireBrowser: argv.includes("--require-browser"),
    htmlPath: value("--html=") ?? DEFAULT_HTML,
    baselinePath: value("--baseline=") ?? DEFAULT_BASELINE,
    diffPath: value("--diff=") ?? DEFAULT_DIFF,
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
      console.log(`${message}，跳过视觉回归。`);
    }
    return;
  }

  mkdirSync(dirname(args.baselinePath), { recursive: true });
  const renderedPath = join(dirname(args.baselinePath), "page.rendered.png");
  await renderHtmlToPng({ htmlPath: args.htmlPath, outPath: renderedPath, width: args.width, height: args.height, browserPath: args.browserPath });
  // 先解码一遍再落盘：提前暴露"浏览器输出格式不支持"的问题，而不是等到比较阶段。
  const rendered = decodePng(readFileSync(renderedPath));

  if (args.update) {
    writeFileSync(args.baselinePath, encodePng(rendered));
    console.log(`已更新视觉基线：${args.baselinePath}`);
    return;
  }

  let baseline: ReturnType<typeof decodePng>;
  try {
    baseline = decodePng(readFileSync(args.baselinePath));
  } catch (error) {
    console.error(`读取基线失败：${error instanceof Error ? error.message : String(error)}；先运行 npm run visual:baseline`);
    process.exitCode = 1;
    return;
  }

  const diff = diffImages(baseline, rendered);
  writeFileSync(args.diffPath, encodePng(diff.image));
  console.log(`差异像素：${diff.differentPixels}/${diff.totalPixels}（${(diff.ratio * 100).toFixed(3)}%），最大通道差 ${diff.maxChannelDelta}`);
  console.log(`差异图：${args.diffPath}`);
  if (diff.ratio > args.threshold) {
    console.error(`超过阈值 ${(args.threshold * 100).toFixed(3)}%：视觉回归失败`);
    process.exitCode = 1;
  }
}

void main();
