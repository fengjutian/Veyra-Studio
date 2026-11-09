/**
 * 资产打包的端到端探针。
 *
 *   npm run visual:package:probe
 *   npm run visual:package:probe -- --require-browser
 *
 * 回答一个问题：**「导出资源包」真的产出了一个能用的包吗？**
 *
 * 纯逻辑（`studio-application/src/asset-package.ts`）能算出「包里该有哪些文件」，
 * 但它答不了三件事：
 *
 *  ① 浏览器**真的下载**下来了吗（按钮接好了吗）？
 *  ② ZIP **真的能解开**，里面条目名与字节都对吗？
 *  ③ HTML 里的引用**真的指向包内的文件**（而不是还在用 data URL），
 *     而且包里的图片字节与仓库里存的是同一份？
 *
 * 做法：起服务 → 对着构建产物打开应用 → 用真实的「添加图片」入口插一张真 PNG
 * （fixture 里那两张图用的是假哈希，仓库里没有字节，打不出有资源的包）
 * → 在「导出」分段点「导出资源包」→ 把下载下来的 ZIP 读回来逐项核对。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrowser } from "../../design-export/visual/browser";
import { fixtureDocument } from "../harness/fixture";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";
import { serveDirectory } from "./static-server";
import { readZip } from "./zip-reader";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const DIST = join(root, "packages", "studio-web", "dist");
/** 真 PNG：插入后字节会进仓库，资源包里才有东西可打。 */
const SAMPLE_PNG = join(root, "packages", "design-export", "test", "golden", "page.png");

interface Args {
  requireBrowser: boolean;
  verbose: boolean;
  browserPath?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    requireBrowser: argv.includes("--require-browser"),
    verbose: argv.includes("--verbose"),
    browserPath: value("--browser="),
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 探针的失败项：收集完一次性报出来，而不是撞到第一个问题就停。 */
const failures: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

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
  throw new Error("工作台没有渲染出来（.topbar / .canvas / .status 都没出现）");
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

/** 用真实的「添加图片」入口插一张图。 */
async function insertImage(page: CdpPage, file: string): Promise<void> {
  const rootNode = await page.send<any>("DOM.getDocument", { depth: 1 });
  const input = await page.send<any>("DOM.querySelector", {
    nodeId: rootNode.root.nodeId,
    selector: 'input[accept="image/*"]',
  });
  if (!input?.nodeId) throw new Error("页面里没有「添加图片」的文件输入框");
  await page.send("DOM.setFileInputFiles", { files: [file], nodeId: input.nodeId });
  await page.evaluate(
    `(() => { const node = document.querySelector('input[accept="image/*"]'); if (node) node.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
  await sleep(2500);
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

/** 切到检查器的某个分段（真实鼠标事件：Radix 监听的是 mousedown）。 */
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

/** 等自动保存落盘。 */
async function waitForAutosave(page: CdpPage, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.evaluate<string>(
      `(() => { const el = document.querySelector(".autosave-status"); return el ? (el.className + "|" + (el.textContent || "").trim()) : ""; })()`,
    );
    if (last.includes("autosave-saved")) return;
    await sleep(200);
  }
  throw new Error(`自动保存没有落盘（最后状态：${last}）`);
}

/** 等下载目录里出现一个**下载完成**的 ZIP（进行中的文件带 .crdownload 后缀）。 */
async function waitForDownload(directory: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = readdirSync(directory).filter(name => name.endsWith(".zip"));
    if (files.length) return join(directory, files[0]!);
    await sleep(200);
  }
  throw new Error(`没有等到下载完成的 ZIP（目录：${directory}）`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const browserPath = args.browserPath ?? findBrowser();
  if (!browserPath) {
    const message = "未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）";
    if (args.requireBrowser) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(`${message}，跳过资产打包探针。`);
    }
    return;
  }
  if (!existsSync(join(DIST, "index.html"))) {
    console.error(`没有找到构建产物：${DIST}；先运行 npm run build:studio-web`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(SAMPLE_PNG)) {
    console.error(`没有找到样例图片：${SAMPLE_PNG}`);
    process.exitCode = 1;
    return;
  }

  const downloadDirectory = mkdtempSync(join(tmpdir(), "design-ai-download-"));
  const server = await serveDirectory(DIST);
  const browser = await launchHeadlessBrowser(browserPath);
  try {
    // 下载要落到磁盘上才读得到：默认 headless 会把下载丢掉。
    await browser.connection.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDirectory,
      eventsEnabled: true,
    });

    const page = await browser.newPage(server.url);
    await waitForApp(page);
    await seedDocument(page);
    await waitForAutosave(page);
    await insertImage(page, SAMPLE_PNG);
    await waitForAutosave(page);
    console.log(`插图之后：${await page.evaluate<string>(`(document.querySelector(".status")?.textContent || "").trim()`)}`);

    await switchPanel(page, "导出");
    const clicked = await page.evaluate<boolean>(
      `(() => {
         const button = Array.from(document.querySelectorAll("button")).find(el => (el.textContent || "").includes("导出资源包"));
         if (!button) return false;
         button.setAttribute("data-probe-package", "1");
         return true;
       })()`,
    );
    expect(clicked, "导出分段里没有「导出资源包」按钮");
    if (!clicked) throw new Error("导出分段里没有「导出资源包」按钮");
    await clickSelector(page, '[data-probe-package="1"]');

    const archivePath = await waitForDownload(downloadDirectory);
    const archive = new Uint8Array(readFileSync(archivePath));
    const entries = readZip(archive);
    const paths = entries.map(entry => entry.path);
    if (args.verbose) console.log(`包内条目：${JSON.stringify(paths)}`);

    const documentEntry = entries.find(entry => entry.path === "index.html");
    expect(Boolean(documentEntry), `包里应该有 index.html，实际条目：${JSON.stringify(paths)}`);
    const assetEntry = entries.find(entry => entry.path.startsWith("assets/"));
    expect(Boolean(assetEntry), `包里应该有 assets/ 下的图片，实际条目：${JSON.stringify(paths)}`);

    if (documentEntry) {
      const html = new TextDecoder().decode(documentEntry.bytes);
      // 关键：引用必须是包内相对路径，不能还是 data URL。
      expect(!html.includes("data:image/"), "HTML 里还有 data URL 内联图片，打包没生效");
      expect(/src="\.\/assets\/[^"]+"/.test(html), `HTML 应该引用 ./assets/ 下的文件：${html.match(/src="[^"]*"/)?.[0] ?? "(没有 img)"}`);
      expect(assetEntry ? html.includes(assetEntry.path.replace(/^\.\//, "./")) : false, "HTML 引用的文件不在包里");
    }
    if (assetEntry) {
      const original = new Uint8Array(readFileSync(SAMPLE_PNG));
      expect(assetEntry.bytes.byteLength === original.byteLength, `包里的图片大小与原文件不符：${assetEntry.bytes.byteLength} ≠ ${original.byteLength}`);
      expect(Buffer.from(assetEntry.bytes).equals(Buffer.from(original)), "包里的图片字节与原文件不一致");
      expect(assetEntry.path.endsWith(".png"), `包里的图片扩展名不对：${assetEntry.path}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error(`\n资产打包探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n资产打包探针通过：下载到了 ZIP，主文档引用包内相对路径，图片字节与仓库里的一致。");
}

// 只在直接运行这个脚本时执行；测试会 import 本模块里的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
