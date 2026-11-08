/**
 * 内联文本编辑器的浏览器能力探针。
 *
 *   npm run visual:inline-editor-probe
 *
 * 回答一个问题：**编辑态真的把样式显示出来了吗？**
 *
 * jsdom 里能断言 DOM 结构，但没有排版引擎，算不出字号、宽度与行高。
 * 所以这里让真实浏览器渲染编辑器，再把**计算样式**抓回来断言：
 *
 * - 段内加粗 → 计算出的 `font-weight` 是 700（不是「DOM 上写了 700」而是「浏览器认了」）；
 * - 段内颜色 → 计算出的 `color` 是 rgb(239, 68, 68)；
 * - 列表标记 → 可见、右对齐、宽度固定；
 * - **几何一致**：正文起点 = 级别缩进 + 标记区宽度，与画布的 `left` 完全一致；
 * - 真的能输入 → 插入一个字符后能从 DOM 还原出文本。
 *
 * 为什么要有这个探针：「编辑态显示样式」这句话很容易写成「我给 span 加了 style」，
 * 但浏览器是否认、几何是否真的与画布一致，只有实测才算数。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { dumpHtml, findBrowser } from "../../design-export/visual/browser";

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, ".cache", "inline-editor");

interface RunReport {
  text: string;
  fontWeight: string;
  fontStyle: string;
  fontSize: string;
  color: string;
}

interface ParagraphReport {
  text: string;
  paddingLeft: string;
  runs: RunReport[];
  marker: { text: string; width: string; marginRight: string; textAlign: string; display: string } | null;
  bodyLeft: number;
}

interface Report {
  contentEditable: boolean;
  paragraphs: ParagraphReport[];
  afterInsert: string;
}

/** 编辑器 CSS 与画布的几何常量（见 design-schema 的 paragraph-styles）。 */
const LIST_INDENT_STEP = 24;
const LIST_MARKER_WIDTH = 20;

async function buildHarness(): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  await build({
    entryPoints: [join(here, "inline-editor-harness.tsx")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    outdir: CACHE,
    logLevel: "silent",
    loader: { ".css": "css" },
  });
  const js = readFileSync(join(CACHE, "inline-editor-harness.js"), "utf8");
  const css = readFileSync(join(CACHE, "inline-editor-harness.css"), "utf8");
  const htmlPath = join(CACHE, "index.html");
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>inline editor probe</title>
<style>html,body{margin:0;padding:0;background:#fff}</style>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<pre id="report"></pre>
<script>${js.replace(/<\/script>/gi, "<\\/script>")}</script>
</body></html>`;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(htmlPath, html, "utf8");
  return htmlPath;
}

/** 从 dump 出来的 HTML 里取出报告 JSON。 */
function extractReport(dom: string): Report {
  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) throw new Error("页面里没有找到报告（harness 可能没跑起来）");
  const raw = match[1]!
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return JSON.parse(raw) as Report;
}

async function main(): Promise<void> {
  if (!findBrowser()) {
    console.log("未找到 Chrome/Edge；设置 CHROME_PATH 后重试。跳过内联编辑器探针。");
    return;
  }
  const htmlPath = await buildHarness();
  const dom = await dumpHtml({ htmlPath });
  const report = extractReport(dom);

  const failures: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };

  check(report.contentEditable === true, "编辑器不是 contenteditable（无法原生编辑）");
  check(report.paragraphs.length === 2, `段落数应为 2，实际 ${report.paragraphs.length}`);

  const list = report.paragraphs[0];
  const plain = report.paragraphs[1];
  if (list) {
    check(list.marker !== null, "列表段落没有标记");
    check(list.marker?.text === "•", `列表标记应为「•」，实际「${list.marker?.text}」`);
    check(list.marker?.display === "inline-block", `标记应是 inline-block，实际 ${list.marker?.display}`);
    check(list.marker?.textAlign === "right", `标记应右对齐，实际 ${list.marker?.textAlign}`);
    check(Number.parseFloat(list.paddingLeft) === LIST_INDENT_STEP, `缩进应为 ${LIST_INDENT_STEP}px，实际 ${list.paddingLeft}`);
    // 几何一致：正文起点 = 级别缩进 + 标记区宽度（与画布的 left 相同）。
    const expected = LIST_INDENT_STEP + LIST_MARKER_WIDTH;
    check(Math.abs(list.bodyLeft - expected) < 0.5, `正文起点应为 ${expected}px（与画布一致），实际 ${list.bodyLeft}`);
    // 段内加粗与颜色：浏览器必须真的认。
    const bold = list.runs.find(run => run.text.includes("第"));
    check(bold?.fontWeight === "700", `段内加粗的计算字重应为 700，实际 ${bold?.fontWeight}`);
    check(bold?.color === "rgb(239, 68, 68)", `段内颜色的计算值应为 rgb(239, 68, 68)，实际 ${bold?.color}`);
    check(bold?.fontSize === "16px", `段内字号应为 16px，实际 ${bold?.fontSize}`);
  }
  if (plain) {
    check(plain.marker === null, "普通段落不该有标记");
    check(Number.parseFloat(plain.paddingLeft) === 0, `普通段落不该有缩进，实际 ${plain.paddingLeft}`);
  }
  check(report.afterInsert === "第一段\n第二段!", `输入后还原的文本应为「第一段\\n第二段!」，实际「${report.afterInsert}」`);

  if (failures.length) {
    console.error(`内联编辑器探针失败（${failures.length} 项）：`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`内联编辑器探针通过：段内样式、列表标记与几何（正文起点 ${report.paragraphs[0]!.bodyLeft}px = 缩进 ${LIST_INDENT_STEP} + 标记区 ${LIST_MARKER_WIDTH}）都与画布一致。`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
