/**
 * 设计 → 代码产物的端到端探针。
 *
 *   npm run visual:react:probe
 *   npm run visual:react:probe -- --require-browser
 *
 * 回答一个问题：**导出的 React 组件，长得跟设计稿一样吗？**
 *
 * 单元测试只能断言「生成的代码里有这几条声明」。但设计 → 代码真正的验收标准是
 * **像素一致**：把导出的组件渲染出来，跟同一份设计的 HTML 导出逐像素比对。
 *
 * 做法：同一台机器、同一个浏览器、同一份 fixture——
 *  ① 走 HTML 导出，得到一份静态页面；
 *  ② 走 React 导出，得到一段 TSX，用 esbuild 现场编译并渲染；
 *  ③ 两张截图逐像素比。
 *
 * 两个坑记在这里：
 *  - **必须用同一套导出**：React 导出复用 HTML 导出的样式计算（`nodeStyle`），
 *    两边只差序列化。所以这个比对真正验的是「序列化有没有改语义」。
 *  - **图片要真图**：fixture 里的图片资源换成真的 PNG 字节，否则两边都画占位框，
 *    比对会通过但什么也没验到。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { exportPageToHtml, exportPageToReact } from "@ufira/design-export";
import { findBrowser, renderHtmlToPng } from "../../design-export/visual/browser";
import { decodePng, diffImages, encodePng, type RgbaImage } from "../../design-export/visual/png";
import { fixtureDocument } from "../harness/fixture";

const here = dirname(fileURLToPath(import.meta.url));
const WORK = join(here, ".cache", "react-probe");

const VIEWPORT = { width: 960, height: 680 };

/** 允许的差异像素比例：两边是同一浏览器同一份 CSS，正常应该是 0。 */
const MAX_DIFF_RATIO = 0.005;

const failures: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

/** 一张真的 PNG：双色方块 + 白圆。 */
function samplePngDataUrl(): string {
  const width = 40;
  const height = 40;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const dx = x - 20;
      const dy = y - 20;
      const inCircle = dx * dx + dy * dy <= 12 * 12;
      data[offset] = inCircle ? 255 : y < 20 ? 14 : 245;
      data[offset + 1] = inCircle ? 255 : y < 20 ? 165 : 158;
      data[offset + 2] = inCircle ? 255 : y < 20 ? 233 : 11;
      data[offset + 3] = 255;
    }
  }
  const png: RgbaImage = { width, height, data };
  return `data:image/png;base64,${encodePng(png).toString("base64")}`;
}

/** 把生成的 TSX 编译成能直接跑的 IIFE，并内联进一个页面。 */
async function buildReactPage(componentCode: string, componentName: string): Promise<string> {
  mkdirSync(WORK, { recursive: true });
  const componentPath = join(WORK, "component.tsx");
  const entryPath = join(WORK, "entry.tsx");
  writeFileSync(componentPath, componentCode, "utf8");
  writeFileSync(
    entryPath,
    [
      `import { createRoot } from "react-dom/client";`,
      `import { ${componentName} } from "./component";`,
      `const host = document.getElementById("root");`,
      `if (host) createRoot(host).render(<${componentName} />);`,
    ].join("\n"),
    "utf8",
  );

  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    write: false,
    logLevel: "silent",
  });
  const js = result.outputFiles[0]?.text ?? "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>React export probe</title>
<style>html,body{margin:0;padding:0;min-height:100%;background:#fff}</style>
</head>
<body>
<div id="root"></div>
<script>${js.replace(/<\/script>/gi, "<\\/script>")}</script>
</body>
</html>`;
  const htmlPath = join(WORK, "react.html");
  writeFileSync(htmlPath, html, "utf8");
  return htmlPath;
}

async function main(): Promise<void> {
  const requireBrowser = process.argv.slice(2).includes("--require-browser");
  const browserPath = findBrowser();
  if (!browserPath) {
    const message = "未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）";
    if (requireBrowser) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(`${message}，跳过设计→代码探针。`);
    }
    return;
  }

  const document = fixtureDocument();
  const imageUrl = samplePngDataUrl();
  const resolveAsset = (asset: { hash: string }) => (asset.hash === "hash-sample" ? imageUrl : undefined);

  // ── 两份产物 ──────────────────────────────────────────────────────
  const html = exportPageToHtml(document, { pageId: "page:1", viewport: VIEWPORT, resolveAsset });
  const react = exportPageToReact(document, {
    pageId: "page:1",
    viewport: VIEWPORT,
    componentName: "CanvasFixture",
    resolveAsset,
  });

  mkdirSync(WORK, { recursive: true });
  const htmlPath = join(WORK, "html.html");
  writeFileSync(htmlPath, html.document, "utf8");
  const reactPath = await buildReactPage(react.code, react.componentName);

  // ── 两张截图 ──────────────────────────────────────────────────────
  const htmlPng = join(WORK, "html.png");
  const reactPng = join(WORK, "react.png");
  await renderHtmlToPng({ htmlPath, outPath: htmlPng, width: VIEWPORT.width, height: VIEWPORT.height, browserPath });
  await renderHtmlToPng({ htmlPath: reactPath, outPath: reactPng, width: VIEWPORT.width, height: VIEWPORT.height, browserPath });
  expect(existsSync(htmlPng) && existsSync(reactPng), "截图没有生成出来");

  const { readFile } = await import("node:fs/promises");
  const htmlImage = decodePng(await readFile(htmlPng));
  const reactImage = decodePng(await readFile(reactPng));
  expect(htmlImage.width === VIEWPORT.width && htmlImage.height === VIEWPORT.height, `HTML 截图尺寸不对：${htmlImage.width}×${htmlImage.height}`);
  expect(reactImage.width === VIEWPORT.width && reactImage.height === VIEWPORT.height, `React 截图尺寸不对：${reactImage.width}×${reactImage.height}`);

  const diff = diffImages(htmlImage, reactImage);
  writeFileSync(join(WORK, "diff.png"), encodePng(diff.image), "utf8");
  console.log(`差异像素：${diff.differentPixels}/${diff.totalPixels}（${(diff.ratio * 100).toFixed(3)}%），最大通道差 ${diff.maxChannelDelta}`);
  expect(
    diff.ratio <= MAX_DIFF_RATIO,
    `导出的 React 组件与 HTML 导出长得不一样：差异 ${(diff.ratio * 100).toFixed(3)}%（上限 ${(MAX_DIFF_RATIO * 100).toFixed(3)}%）`,
  );

  // ── 产物本身也要说得清 ────────────────────────────────────────────
  expect(react.props.length > 0, "文字与图片地址应该被提成 prop，实际一个都没有");
  expect(react.code.includes("export function CanvasFixture"), "产物里没有组件函数");
  expect(
    react.diagnostics.every(item => item.support !== "unsupported" || item.feature !== "text-prop"),
    "不该出现 text-prop 的 unsupported 诊断",
  );

  console.log(`props：${react.props.map(prop => prop.name).join(", ")}`);
  console.log(`差异图：${join(WORK, "diff.png")}`);

  if (failures.length) {
    console.error(`\n设计→代码探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n设计→代码探针通过：导出的 React 组件与 HTML 导出渲染结果一致，文字与图片地址提成了 props。");
}

// 只在直接运行这个脚本时执行。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
