/**
 * 视觉上下文的端到端探针。
 *
 *   npm run visual:vision:probe
 *   npm run visual:vision:probe -- --require-browser
 *
 * 回答一个问题：**「把当前页面截图发给模型」这件事，截出来的真的是用户看到的那张图吗？**
 *
 * 纯函数（`src/ai-vision.ts` 的降级分支）测不出这件事。真正的风险有三个：
 *
 *  ① **截的是不是同一套渲染**。走「导出 HTML → 浏览器截图」那条路会得到另一套
 *     渲染结果，模型照着那张图提建议，改出来的却不是它看到的东西。
 *  ② **图片节点有没有真的画出来**。没画出来模型看到的就是一个空框，它会以为
 *     「这里应该放张图」——于是凭空加一张图。
 *  ③ **一张图读不到会不会整张截图报废**。报废了这条功能对有资源的项目就完全不可用。
 *
 * 做法是在真实浏览器里跑 `capturePageScreenshot`，把 PNG 拿回 Node 逐像素核对：
 * 形状的颜色对不对、图片的资源字节有没有被画上去、缺图的那格是不是占位框、
 * 限长之后是不是等比缩小了。
 *
 * ## 为什么走 http:// 而不是 file://
 *
 * 资源字节走 blob: URL。`file://` 页面的源是不透明的，blob: 图跟它不同源 →
 * 画布被污染 → `toDataURL()` 直接抛 SecurityError。生产环境跑在 http(s) 上，
 * 所以探针也用 http——不然测的是另一套环境。
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrowser } from "../../design-export/visual/browser";
import { decodePng, type RgbaImage } from "../../design-export/visual/png";
import { buildHarness } from "./build-harness";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache");

/** 画布尺寸（见 `src/canvas-zoom.ts`）。 */
const CANVAS = { width: 960, height: 680 };

/** 拼页时每页上方留给页名的标题条高度（见 `src/ai-vision.ts`）。 */
const PAGE_LABEL_HEIGHT = 22;

/** 探针的失败项：收集完一次性报出来，而不是撞到第一个问题就停。 */
const failures: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

interface Rgb { r: number; g: number; b: number; a: number }

/** 取一个像素（PNG 是 RGBA，内存里按 4 字节一个通道存放）。 */
function pixelAt(image: RgbaImage, x: number, y: number): Rgb {
  const offset = (y * image.width + x) * 4;
  return {
    r: image.data[offset]!,
    g: image.data[offset + 1]!,
    b: image.data[offset + 2]!,
    a: image.data[offset + 3]!,
  };
}

/** 两个颜色的最大通道差。 */
function channelDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a));
}

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b, a: 255 };
}

/**
 * 在整张图里找第一个接近给定颜色的像素。
 *
 * 用来证明「某个颜色**不**在图里」——这类否定断言没法用固定采样点表达：
 * 选区外的节点可能漏在任意位置。
 */
function findColor(image: RgbaImage, expected: Rgb): { x: number; y: number } | undefined {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (channelDistance(pixelAt(image, x, y), expected) <= TOLERANCE) return { x, y };
    }
  }
  return undefined;
}

/** 期望颜色与实际颜色的最大通道差（超阈值就算不合格）。 */
const TOLERANCE = 6;

interface Sample {
  name: string;
  x: number;
  y: number;
  expected: Rgb;
}

/**
 * 逐点核对清单。
 *
 * 坐标来自 `harness/fixture.ts` 的 fixture（960×680 画布）：
 *  - accent 240×120 @ (460,40)  → #f87171
 *  - dot 椭圆 96×96 @ (560,196) → #8b5cf6
 *  - card 360×220 @ (40,40)     → 白色，右下角空白处
 *  - image 200×140 @ (460,320)  → cover 裁剪后的样图上蓝下橙
 *  - missing 140×90 @ (700,380) → 缺图占位（灰蓝半透明压在白底上）
 */
const SAMPLES: Sample[] = [
  { name: "accent 填充", x: 580, y: 100, expected: rgb(0xf8, 0x71, 0x71) },
  { name: "dot 椭圆填充", x: 608, y: 244, expected: rgb(0x8b, 0x5c, 0xf6) },
  { name: "card 空白处", x: 380, y: 240, expected: rgb(0xff, 0xff, 0xff) },
  { name: "样图上半（蓝色）", x: 560, y: 330, expected: rgb(0x0e, 0xa5, 0xe9) },
  { name: "样图下半（橙色）", x: 560, y: 450, expected: rgb(0xf5, 0x9e, 0x0b) },
  { name: "缺图占位框", x: 770, y: 425, expected: rgb(228, 232, 237) },
];

interface HarnessResult {
  ok: boolean;
  error?: string;
  full?: { dataUrl: string; width: number; height: number };
  small?: { dataUrl: string; width: number; height: number };
  selection?: { dataUrl: string; width: number; height: number };
  pages?: { dataUrl: string; width: number; height: number };
}

/** 等 harness 把结果写进 DOM。 */
async function waitForResult(page: CdpPage, timeoutMs = 30_000): Promise<HarnessResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await page.evaluate<string>(
      `(() => { const el = document.getElementById("vision-result") || document.getElementById("vision-error"); return el ? (el.textContent || "") : ""; })()`,
    );
    if (raw) return JSON.parse(raw) as HarnessResult;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("harness 没有在超时前产出结果");
}

/** data URL → PNG 像素。 */
function decodeDataUrl(dataUrl: string): RgbaImage {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return decodePng(Buffer.from(base64, "base64"));
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
      console.log(`${message}，跳过视觉上下文探针。`);
    }
    return;
  }

  const htmlPath = await buildHarness("vision");
  if (!existsSync(htmlPath)) {
    console.error(`harness 没生成出来：${htmlPath}`);
    process.exitCode = 1;
    return;
  }

  const server = await serveDirectory(CACHE);
  const browser = await launchHeadlessBrowser(browserPath);
  try {
    // `server.url` 自带结尾斜杠：再拼一个 `/` 会变成 `//harness-vision.html`，
    // 那是个协议相对 URL，`new URL()` 会把 `harness-vision.html` 当成主机名。
    const page = await browser.newPage(`${server.url}harness-vision.html`);
    const result = await waitForResult(page);
    if (!result.ok || !result.full || !result.small) {
      throw new Error(`harness 报错了：${result.error ?? "（没有说明）"}`);
    }

    // ── 尺寸 ───────────────────────────────────────────────────────────
    expect(result.full.width === CANVAS.width, `截图宽度应该是 ${CANVAS.width}，实际 ${result.full.width}`);
    expect(result.full.height === CANVAS.height, `截图高度应该是 ${CANVAS.height}，实际 ${result.full.height}`);

    // ── 逐点核对像素 ───────────────────────────────────────────────────
    const image = decodeDataUrl(result.full.dataUrl);
    expect(image.width === result.full.width, `PNG 解码宽度 ${image.width} 与上报的 ${result.full.width} 对不上`);
    expect(image.height === result.full.height, `PNG 解码高度 ${image.height} 与上报的 ${result.full.height} 对不上`);
    for (const sample of SAMPLES) {
      const actual = pixelAt(image, sample.x, sample.y);
      const distance = channelDistance(actual, sample.expected);
      expect(
        distance <= TOLERANCE,
        `${sample.name}（${sample.x},${sample.y}）应该是 rgb(${sample.expected.r},${sample.expected.g},${sample.expected.b})，实际 rgb(${actual.r},${actual.g},${actual.b})`,
      );
      console.log(`  ${distance <= TOLERANCE ? "✔" : "✗"} ${sample.name.padEnd(18)} rgb(${actual.r},${actual.g},${actual.b})`);
    }

    // ── 限长之后等比缩小，内容还在 ─────────────────────────────────────
    expect(result.small.width === 480, `限长 480 之后宽度应该是 480，实际 ${result.small.width}`);
    expect(result.small.height === 340, `限长 480 之后高度应该是 340，实际 ${result.small.height}`);
    const small = decodeDataUrl(result.small.dataUrl);
    const scaled = pixelAt(small, 290, 50);
    const distance = channelDistance(scaled, rgb(0xf8, 0x71, 0x71));
    expect(distance <= TOLERANCE, `缩小后的图里 accent 的颜色应该是 rgb(248,113,113)，实际 rgb(${scaled.r},${scaled.g},${scaled.b})`);
    console.log(`  ${distance <= TOLERANCE ? "✔" : "✗"} 限长后内容保留      rgb(${scaled.r},${scaled.g},${scaled.b})`);

    // ── 截选区：相机对准选中的包围盒 ──────────────────────────────────
    // card 在页面坐标 (40,40) 360×220；选区图里它应该正好铺满 (0,0)-(360,220)。
    expect(Boolean(result.selection), "harness 没有产出选区截图");
    if (result.selection) {
      expect(result.selection.width === 360, `选区截图宽度应该是 360，实际 ${result.selection.width}`);
      expect(result.selection.height === 220, `选区截图高度应该是 220，实际 ${result.selection.height}`);
      const selection = decodeDataUrl(result.selection.dataUrl);
      // card 的空白区：页面坐标 (380,240) → 选区坐标 (340,200)。
      const blank = pixelAt(selection, 340, 200);
      const blankDistance = channelDistance(blank, rgb(0xff, 0xff, 0xff));
      expect(blankDistance <= TOLERANCE, `选区里 card 的空白处应该是白色，实际 rgb(${blank.r},${blank.g},${blank.b})`);
      console.log(`  ${blankDistance <= TOLERANCE ? "✔" : "✗"} 选区内容对位      rgb(${blank.r},${blank.g},${blank.b})`);
      // 选区外的东西不该出现：accent 是 #f87171，在 card 之外。
      const accent = findColor(selection, rgb(0xf8, 0x71, 0x71));
      expect(accent === undefined, `选区截图里出现了 accent 的颜色（选区外的节点漏进来了）：${accent ? `(${accent.x},${accent.y})` : ""}`);
      console.log(`  ${accent === undefined ? "✔" : "✗"} 选区外节点没漏进来`);
      // 仪表自检：同一套 findColor 在**整页**图里必须能找到 accent。少了这条，
      // 「没找到」既可能是真的没漏进来，也可能是 findColor 坏了——两种情况都显示 ✔。
      const accentInFull = findColor(image, rgb(0xf8, 0x71, 0x71));
      expect(accentInFull !== undefined, "findColor 在整页图里都找不到 accent，说明这个检查本身坏了");
      console.log(`  ${accentInFull !== undefined ? "✔" : "✗"} 查找器本身有效      (${accentInFull?.x},${accentInFull?.y})`);
    }

    // ── 多页拼接：左右顺序对，页与页不串 ──────────────────────────────
    // 两页各一块 240×120 的纯色：page:1 红、page:2 蓝。
    // 拼接宽度 = 240 + 16 + 240 + 16×2 = 528；高度 = 120 + 22（页名条）。
    expect(Boolean(result.pages), "harness 没有产出拼接截图");
    if (result.pages) {
      expect(result.pages.width === 528, `拼接图宽度应该是 528，实际 ${result.pages.width}`);
      expect(result.pages.height === 142, `拼接图高度应该是 142，实际 ${result.pages.height}`);
      const pages = decodeDataUrl(result.pages.dataUrl);
      const left = pixelAt(pages, 100, 80);
      const leftDistance = channelDistance(left, rgb(0xff, 0x00, 0x00));
      expect(leftDistance <= TOLERANCE, `拼接图左边应该是第一页的红色，实际 rgb(${left.r},${left.g},${left.b})`);
      console.log(`  ${leftDistance <= TOLERANCE ? "✔" : "✗"} 左页在左          rgb(${left.r},${left.g},${left.b})`);
      const right = pixelAt(pages, 400, 80);
      const rightDistance = channelDistance(right, rgb(0x00, 0x00, 0xff));
      expect(rightDistance <= TOLERANCE, `拼接图右边应该是第二页的蓝色，实际 rgb(${right.r},${right.g},${right.b})`);
      console.log(`  ${rightDistance <= TOLERANCE ? "✔" : "✗"} 右页在右          rgb(${right.r},${right.g},${right.b})`);
      // 两页之间的间隙是白的（页名条区域除外）。
      const gap = pixelAt(pages, 264, 80);
      const gapDistance = channelDistance(gap, rgb(0xff, 0xff, 0xff));
      expect(gapDistance <= TOLERANCE, `两页之间的间隙应该是白色，实际 rgb(${gap.r},${gap.g},${gap.b})`);
      console.log(`  ${gapDistance <= TOLERANCE ? "✔" : "✗"} 页间隙没串页      rgb(${gap.r},${gap.g},${gap.b})`);
      // 页名：模型看到的是一张长图，不写页名它分不清哪块是哪页。页名画在顶部
      // 标题条里（y < 22），那一条应该找得到深色文字像素。
      const labelPixel = findColor(pages, rgb(0x11, 0x11, 0x11));
      expect(labelPixel !== undefined && labelPixel.y < PAGE_LABEL_HEIGHT, `拼接图顶部没有页名文字（找到的第一个深色像素在 ${labelPixel ? `(${labelPixel.x},${labelPixel.y})` : "无"}）`);
      console.log(`  ${labelPixel && labelPixel.y < PAGE_LABEL_HEIGHT ? "✔" : "✗"} 页名画在顶部      (${labelPixel?.x},${labelPixel?.y})`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error(`\n视觉上下文探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n视觉上下文探针通过：截出来的就是画布上的那张图——形状颜色、图片资源、缺图占位都对。");
}

// 只在直接运行这个脚本时执行；测试会 import 本模块里的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
