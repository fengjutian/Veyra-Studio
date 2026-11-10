/**
 * PDF 导出的端到端探针。
 *
 *   npm run visual:pdf:probe
 *   npm run visual:pdf:probe -- --require-browser
 *
 * 回答一个问题：**工作台导出的 PDF 里，装的是不是设计稿本身？**
 *
 * 单元测试管的是「PDF 写得对不对」（文件头、xref、页数、图像样本往返）。这个
 * 探针管的是另一头：**真实界面点一下「导出 PDF」，下载下来的文件里有没有那张图**。
 *
 * 做法是走真实应用：导入 fixture → 点「导出 PDF」→ 等下载完成 → 把 PDF 里的
 * 图像流解出来，看里面有没有设计稿上的颜色（accent 的 #f87171）。
 *
 * 一个坑：默认 headless 会把下载丢掉，要显式设置下载目录。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { findBrowser } from "../../design-export/visual/browser";
import { fixtureDocument } from "../harness/fixture";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const DIST = join(root, "packages", "studio-web", "dist");

/** 设计稿里的 accent 填充色；PDF 的图像流里应该能读到它。 */
const ACCENT = [0xf8, 0x71, 0x71];

const failures: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 等工作台渲染出来。 */
async function waitForApp(page: CdpPage, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate<boolean>(
      `Boolean(document.querySelector(".topbar") && document.querySelector(".canvas") && document.querySelector(".status"))`,
    );
    if (ready) {
      await sleep(500);
      return;
    }
    await sleep(100);
  }
  throw new Error("工作台没有渲染出来");
}

/** 用真实的「导入 JSON」入口灌一份 fixture 文档。 */
async function seedDocument(page: CdpPage): Promise<void> {
  const file = join(mkdtempSync(join(tmpdir(), "design-ai-seed-")), "fixture.json");
  writeFileSync(file, JSON.stringify(fixtureDocument()), "utf8");
  const rootNode = await page.send<any>("DOM.getDocument", { depth: 1 });
  const input = await page.send<any>("DOM.querySelector", {
    nodeId: rootNode.root.nodeId,
    selector: 'input[accept*="application/json"]',
  });
  if (!input?.nodeId) throw new Error("页面里没有「导入 JSON」的文件输入框");
  await page.send("DOM.setFileInputFiles", { files: [file], nodeId: input.nodeId });
  await page.evaluate(
    `(() => { const node = document.querySelector('input[accept*="application/json"]'); if (node) node.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  await sleep(1500);
}

/** 用真实鼠标点一个元素（按选择器）。 */
async function clickSelector(page: CdpPage, selector: string): Promise<boolean> {
  const point = await page.evaluate<{ x: number; y: number } | null>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!point) return false;
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
  return true;
}

/** 切到「导出」分段（必须用真实鼠标：Radix 的 Tabs 在 mousedown 上激活）。 */
async function switchPanel(page: CdpPage, label: string): Promise<void> {
  const ok = await page.evaluate<boolean>(
    `(() => {
       const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
       const target = tabs.find(tab => (tab.textContent || "").trim().startsWith(${JSON.stringify(label)}));
       if (!target) return false;
       target.setAttribute("data-probe-tab", "1");
       return true;
     })()`,
  );
  if (!ok) throw new Error(`找不到检查器分段「${label}」`);
  await clickSelector(page, '[data-probe-tab="1"]');
  await sleep(600);
}

/** 等下载目录里出现一个下载完成的 PDF（进行中的文件带 .crdownload 后缀）。 */
async function waitForDownload(directory: string, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(directory).filter(name => name.endsWith(".pdf"));
    if (files.length) return join(directory, files[0]!);
    await sleep(200);
  }
  throw new Error(`没有等到下载完成的 PDF（目录：${directory}）`);
}

/** 从 PDF 里把第一张图的样本解出来。 */
function firstImageSamples(pdf: Uint8Array): Uint8Array {
  const text = Buffer.from(pdf).toString("latin1");
  const imageAt = text.indexOf("/Subtype /Image");
  if (imageAt < 0) throw new Error("PDF 里没有图像对象");
  const streamAt = text.indexOf("stream\n", imageAt);
  if (streamAt < 0) throw new Error("图像对象里没有 stream");
  const lengthMatch = /\/Length (\d+)/.exec(text.slice(imageAt, streamAt));
  if (!lengthMatch) throw new Error("图像对象里没有 /Length");
  const start = streamAt + "stream\n".length;
  const raw = pdf.subarray(start, start + Number(lengthMatch[1]));
  return text.slice(imageAt, streamAt).includes("/FlateDecode") ? inflateSync(raw) : raw;
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
      console.log(`${message}，跳过 PDF 导出探针。`);
    }
    return;
  }
  if (!existsSync(join(DIST, "index.html"))) {
    console.error(`没有找到构建产物：${DIST}；先运行 npm run build:studio-web`);
    process.exitCode = 1;
    return;
  }

  const downloadDirectory = mkdtempSync(join(tmpdir(), "design-ai-pdf-"));
  const server = await serveDirectory(DIST);
  const browser = await launchHeadlessBrowser(browserPath);
  try {
    await browser.connection.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDirectory,
      eventsEnabled: true,
    });
    const page = await browser.newPage(server.url);
    await waitForApp(page);
    await seedDocument(page);

    await switchPanel(page, "导出");
    const clicked = await page.evaluate<boolean>(
      `(() => {
         const button = Array.from(document.querySelectorAll("button")).find(el => (el.textContent || "").includes("导出 PDF"));
         if (!button) return false;
         button.setAttribute("data-probe-pdf", "1");
         return true;
       })()`,
    );
    expect(clicked, "导出分段里没有「导出 PDF」按钮");
    if (!clicked) throw new Error("导出分段里没有「导出 PDF」按钮");
    await clickSelector(page, '[data-probe-pdf="1"]');

    const pdfPath = await waitForDownload(downloadDirectory);
    const pdf = new Uint8Array(readFileSync(pdfPath));
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-"), "下载下来的文件不是 PDF");
    const count = /\/Count (\d+)/.exec(text);
    expect(count?.[1] === "1", `PDF 应该有一页，实际 ${count?.[1] ?? "(读不到页数)"}`);
    expect(/\/MediaBox \[0 0 720 510\]/.test(text), "PDF 页面尺寸应该是 720×510 点（960×680 像素按 96dpi→72dpi 换算）");

    // 关键：PDF 里那张图得是设计稿，不能是一张白纸。
    const samples = firstImageSamples(pdf);
    let found = false;
    for (let index = 0; index + 2 < samples.length; index += 3) {
      if (
        Math.abs(samples[index]! - ACCENT[0]!) <= 2
        && Math.abs(samples[index + 1]! - ACCENT[1]!) <= 2
        && Math.abs(samples[index + 2]! - ACCENT[2]!) <= 2
      ) {
        found = true;
        break;
      }
    }
    expect(found, "PDF 的图像里找不到设计稿的 accent 颜色（#f87171）——导出的是空白页？");
    console.log(`PDF 大小：${pdf.length} 字节，图像样本 ${samples.length / 3} 像素，accent 颜色${found ? "在" : "不在"}`);
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error(`\nPDF 导出探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nPDF 导出探针通过：下载到的 PDF 里装的就是设计稿那一页。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
