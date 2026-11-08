/**
 * 导出物字体内联的能力探针。
 *
 *   npm run visual:font-inline-probe
 *
 * 回答一个问题：**导出的 HTML 真的自带字体吗？**
 *
 * 光检查「HTML 里有 `@font-face`」是不够的——那只是一段文本。
 * 硬证据是：打开导出的 HTML，浏览器**真的加载并应用了**这个字体。
 *
 * 做法：生成两份只差「有没有内联字体」的页面，都用 Chrome 打开，
 * 页面自己量出文字宽度：
 * - 内联了字体 → `document.fonts.check()` 为真，且文字宽度与没有字体的页面**不同**；
 * - 宽度相同 → 说明字体没被应用（回退字形），内联等于没做。
 *
 * 顺带证明「导出物在别的机器上也能显示这个字形」：字体就在 HTML 里，
 * 不依赖本机装没装这个字体。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fontFaceCss } from "@ufira/design-export";
import { dumpHtml, findBrowser } from "../../design-export/visual/browser";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache", "font-inline");
const FONT_PATH = join(here, "..", "..", "design-export", "test", "fixtures", "PressStart2P-Regular.ttf");
const FAMILY = "Press Start 2P";
const SAMPLE = "Handgloves 0123 ABC";

interface Report {
  /** 装上 @font-face 之前的文字宽度（回退字体）。 */
  before: number;
  /** 字体加载之后的文字宽度。 */
  after: number;
  loaded: boolean;
  /** 每个 `@font-face` 的加载状态。 */
  faces: Array<{ family: string; status: string }>;
  /** `document.fonts.status`：loading / loaded / error。 */
  status: string;
}

function html(fontFace: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>font inline probe</title>
<style>
html,body{margin:0;padding:0;background:#fff}
#sample{font-family:"${FAMILY}",monospace;font-size:32px;white-space:nowrap}
</style>
</head>
<body>
<div id="sample">${SAMPLE}</div>
<pre id="report"></pre>
<script>
  var element = document.getElementById("sample");
  function width() { return element.getBoundingClientRect().width; }
  function write(report) { document.getElementById("report").textContent = JSON.stringify(report); }
  // 先量一次：此时没有 @font-face，用的是回退字体。
  var before = width();
  // 再把内联的 @font-face 装上，等它加载完量第二次。
  var style = document.createElement("style");
  style.textContent = ${JSON.stringify(fontFace)};
  document.head.appendChild(style);
  document.fonts.load('32px "${FAMILY}"').then(function () {
    var faces = [];
    document.fonts.forEach(function (face) { faces.push({ family: face.family, status: face.status }); });
    write({
      before: before,
      after: width(),
      loaded: document.fonts.check('32px "${FAMILY}"'),
      faces: faces,
      status: document.fonts.status
    });
  });
</script>
</body></html>`;
}

function extractReport(dom: string): Report {
  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dom);
  if (!match || !match[1]!.trim()) throw new Error("页面里没有报告（字体加载回调可能没跑到）");
  const raw = match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(raw) as Report;
}

async function main(): Promise<void> {
  if (!findBrowser()) {
    console.log("未找到 Chrome/Edge；设置 CHROME_PATH 后重试。跳过字体内联探针。");
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  const bytes = new Uint8Array(readFileSync(FONT_PATH));
  const face = fontFaceCss({ family: FAMILY, weight: 400, style: "normal", bytes, mime: "font/ttf" });

  const withFontPath = join(CACHE, "with-font.html");
  const withoutFontPath = join(CACHE, "without-font.html");
  writeFileSync(withFontPath, html(face), "utf8");
  writeFileSync(withoutFontPath, html(""), "utf8");

  const withFont = extractReport(await dumpHtml({ htmlPath: withFontPath }));
  const withoutFont = extractReport(await dumpHtml({ htmlPath: withoutFontPath }));

  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };

  check(withFont.loaded === true, `内联字体的页面里字体没有加载成功（document.fonts.check 为假）`);
  check(
    Math.abs(withFont.width - withoutFont.width) > 0.5,
    `内联字体与没有字体时文字宽度相同（${withFont.width}px）——字体其实没被应用`,
  );

  if (failures.length) {
    console.error(`字体内联探针失败（${failures.length} 项）：`);
    for (const failure of failures) console.error(`  · ${failure}`);
    console.error(`内联页报告：${JSON.stringify(withFont)}`);
    console.error(`无字体页报告：${JSON.stringify(withoutFont)}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `字体内联探针通过：导出的 HTML 自带字体（加载成功，文字宽度 ${withFont.width}px ≠ 回退字体 ${withoutFont.width}px）。`,
  );
  void failures;
}

async function debug(): Promise<void> {
  const bytes = new Uint8Array(readFileSync(FONT_PATH));
  const face = fontFaceCss({ family: FAMILY, weight: 400, style: "normal", bytes, mime: "font/ttf" });
  console.log("faces =", JSON.stringify(face).slice(0, 160));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
