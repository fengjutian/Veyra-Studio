/**
 * 版本并排对比的端到端探针。
 *
 *   npm run visual:compare:probe
 *   npm run visual:compare:probe -- --require-browser
 *
 * 回答一个问题：**「并排对比历史版本」这件事，在真实应用里真的成立吗？**
 *
 * 纯函数（`src/version-compare.ts`）能算出「两侧该导出哪一页、哪一批节点」，
 * 但它答不了三个只有真实界面才答得出的问题：
 *
 *  ① 两栏里真的是**同一份交付物**的两个版本吗？（导出路径要和真正下载的一致）
 *  ② 两栏的内容**真的不同**吗？（左旧右新，不是左右都渲染成当前版本）
 *  ③ 历史版本里没有当前这一页时，应用会**说清楚没法比**，而不是摆出两幅
 *     毫不相干的画面？
 *
 * 做法是走真实应用：导入 fixture → 用真实按键挪动一个节点（产生第二个版本）
 * → 点「和当前版本并排对比」→ 读回两个 iframe 的 srcdoc 逐点比对。
 *
 * 两个坑记在这里：
 *  - **按键必须是真的**。应用的全局快捷键处理器第一行就调 `target.matches(...)`，
 *    合成 KeyboardEvent 的 target 是 document（没有 matches）→ 处理器直接抛错，
 *    看起来像「按键没生效」。真实按键的 target 是聚焦元素。
 *  - **两侧内容长度相同不代表内容相同**：挪 10px 是 40 → 50，位数一样、长度一样，
 *    但内容确实变了。所以这里比对的是内容本身，不是长度。
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrowser } from "../../design-export/visual/browser";
import { fixtureDocument } from "../harness/fixture";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const DIST = join(root, "packages", "studio-web", "dist");

/** fixture 里 card 的初始 x；挪动 10px 之后应该是 40 + 10。 */
const CARD_LEFT_BEFORE = 40;
const CARD_LEFT_AFTER = 50;

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

/**
 * 用真实的「导入 JSON」入口灌一份 fixture 文档。
 *
 * 走应用自己的导入流程（文件输入框 → change 事件），不往 IndexedDB 里塞记录——
 * 后者要照抄 Dexie 的内部格式，换个版本就悄悄失效。
 */
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
  await sleep(1200);
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

/**
 * 切到某个检查器分段。
 *
 * 必须用**真实的鼠标事件**：Radix 的 Tabs.Trigger 在 `mousedown` 上激活，
 * 脚本调用 `.click()` 只派发 click，React 收不到——分段根本没切换。
 */
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

/** 发一个真实按键（CDP 虚拟键码）。modifiers: 1=Alt 2=Ctrl 4=Meta 8=Shift。 */
async function pressKey(page: CdpPage, key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** 等自动保存落盘：快照进库之后，历史列表才会多出可对比的版本。 */
async function waitForAutosave(page: CdpPage, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.evaluate<string>(
      `(() => { const el = document.querySelector(".autosave-status"); return el ? (el.className + "|" + (el.textContent || "").trim()) : ""; })()`,
    );
    if (last.includes("autosave-saved")) return last;
    await sleep(200);
  }
  throw new Error(`自动保存没有落盘（最后状态：${last}）`);
}

/** 读回状态栏文字。 */
async function readStatus(page: CdpPage): Promise<string> {
  return page.evaluate<string>(`(document.querySelector(".status")?.textContent || "").trim()`);
}

/** 选中画布上的一个节点：隐藏 listbox 靠 focus 选中（onFocus → onSelect）。 */
async function selectCanvasNode(page: CdpPage, nodeId: string): Promise<boolean> {
  const selected = await page.evaluate<string>(
    `(() => {
       const option = document.querySelector('.canvas-a11y [role="option"][data-node-id=${JSON.stringify(nodeId)}]');
       if (!option) return "";
       option.focus();
       return document.activeElement === option ? ${JSON.stringify(nodeId)} : "";
     })()`,
  );
  await sleep(300);
  return selected === nodeId;
}

/** 从导出的 HTML 里取出 card 的 left 值（用来核对两栏确实是不同版本）。 */
function cardLeftOf(html: string): number | undefined {
  const match = /id="card"[^>]*left:(\d+(?:\.\d+)?)px/.exec(html);
  return match ? Number(match[1]) : undefined;
}

interface ComparePane {
  title: string;
  html: string;
}

async function readComparePanes(page: CdpPage): Promise<ComparePane[]> {
  return page.evaluate<ComparePane[]>(
    `(() => {
       const root = document.querySelector(".export-preview-compare");
       if (!root) return [];
       const frames = Array.from(root.querySelectorAll("iframe.export-preview-frame"));
       const titles = Array.from(root.querySelectorAll(".export-preview-pane-title")).map(el => (el.textContent || "").trim());
       return frames.map((frame, index) => ({
         title: titles[index] || "",
         html: frame.getAttribute("srcdoc") || "",
       }));
     })()`,
  );
}

/** 在「导出」分段里点第一个「和当前版本并排对比」按钮。 */
async function clickFirstCompareButton(page: CdpPage): Promise<string | undefined> {
  const label = await page.evaluate<string | undefined>(
    `(() => {
       const btn = document.querySelector('button[aria-label^="和当前版本并排对比"]');
       if (!btn) return undefined;
       btn.setAttribute("data-probe-compare", "1");
       return btn.getAttribute("aria-label") || "";
     })()`,
  );
  if (!label) return undefined;
  await clickSelector(page, '[data-probe-compare="1"]');
  await sleep(2500);
  return label;
}

/** 关掉还开着的弹窗：遮罩会挡住后续所有点击，不关掉下一步就全点不动。 */
async function closeDialog(page: CdpPage): Promise<void> {
  const closed = await page.evaluate<boolean>(
    `(() => {
       const button = document.querySelector(".export-preview-compare .dialog-actions button");
       if (!button) return false;
       button.setAttribute("data-probe-close", "1");
       return true;
     })()`,
  );
  if (!closed) return;
  await clickSelector(page, '[data-probe-close="1"]');
  await sleep(600);
  const stillOpen = await page.evaluate<boolean>(`Boolean(document.querySelector(".export-preview-compare"))`);
  if (stillOpen) throw new Error("对比弹窗关不掉，后续点击会被遮罩挡住");
}

/** 新建一页（走应用自己的「新增页面」对话框）。 */
async function createPage(page: CdpPage, name: string): Promise<boolean> {
  if (!(await clickSelector(page, 'button[aria-label="新增页面"]'))) return false;
  await sleep(600);
  const filled = await page.evaluate<boolean>(
    `(() => {
       const input = document.querySelector(".dialog-content input.dialog-input");
       if (!input) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
       setter.call(input, ${JSON.stringify(name)});
       input.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
  if (!filled) return false;
  await sleep(300);
  const submitted = await page.evaluate<boolean>(
    `(() => {
       const form = document.querySelector(".dialog-content form");
       if (!form) return false;
       form.requestSubmit();
       return true;
     })()`,
  );
  if (!submitted) return false;
  await sleep(2500);
  return true;
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
      console.log(`${message}，跳过版本并排对比探针。`);
    }
    return;
  }
  if (!existsSync(join(DIST, "index.html"))) {
    console.error(`没有找到构建产物：${DIST}；先运行 npm run build:studio-web`);
    process.exitCode = 1;
    return;
  }

  const server = await serveDirectory(DIST);
  const browser = await launchHeadlessBrowser(browserPath);
  try {
    const page = await browser.newPage(server.url);
    await waitForApp(page);
    await seedDocument(page);
    await waitForAutosave(page);
    console.log(`导入完成：${await readStatus(page)}`);

    // ── 场景 A：能比的两栏 ───────────────────────────────────────────
    // 挪动一个节点 = 一次真实改动，落盘后产生第二个版本（r1），r0 进历史表。
    expect(await selectCanvasNode(page, "card"), "画布上没能选中 card 节点");
    await pressKey(page, "ArrowRight", "ArrowRight", 39, 8);
    await sleep(3000);
    await waitForAutosave(page);
    console.log(`挪动之后：${await readStatus(page)}`);

    await switchPanel(page, "历史");
    const versions = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll(".snapshot-row .snapshot-label")).map(el => (el.textContent || "").trim())`,
    );
    expect(versions.length >= 2, `改动之后应该至少有两个版本，实际 ${JSON.stringify(versions)}`);
    console.log(`版本列表：${JSON.stringify(versions)}`);

    await switchPanel(page, "导出");
    const compareLabel = await clickFirstCompareButton(page);
    expect(Boolean(compareLabel), "导出分段里没有「和当前版本并排对比」按钮");
    const panes = await readComparePanes(page);
    expect(panes.length === 2, `并排对比应该有两栏，实际 ${panes.length} 栏`);
    if (panes.length === 2) {
      const [left, right] = panes;
      expect(Boolean(left.title) && Boolean(right.title), `两栏标题缺失：${JSON.stringify(panes.map(p => p.title))}`);
      expect(right.title.includes("当前"), `右栏标题应该标明是当前版本，实际「${right.title}」`);
      expect(!left.title.includes("当前"), `左栏标题不该写「当前」：「${left.title}」`);
      const leftX = cardLeftOf(left.html);
      const rightX = cardLeftOf(right.html);
      expect(leftX === CARD_LEFT_BEFORE, `左栏（历史）里 card 的 left 应该是 ${CARD_LEFT_BEFORE}，实际 ${leftX}`);
      expect(rightX === CARD_LEFT_AFTER, `右栏（当前）里 card 的 left 应该是 ${CARD_LEFT_AFTER}，实际 ${rightX}`);
      expect(left.html !== right.html, "两栏内容完全一样，对比没有意义");
      if (args.verbose) {
        console.log(`  左栏标题：${left.title}（card.left=${leftX}）`);
        console.log(`  右栏标题：${right.title}（card.left=${rightX}）`);
      }
    }

    // ── 场景 B：历史版本里没有当前这一页 → 说清楚没法比 ────────────
    await closeDialog(page);
    await switchPanel(page, "历史");
    await createPage(page, "对比测试页");
    const pageNames = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll(".page-row-name")).map(el => (el.textContent || "").trim())`,
    );
    expect(pageNames.includes("对比测试页"), `新建的页面没出现在页面列表里：${JSON.stringify(pageNames)}`);
    await waitForAutosave(page);

    await switchPanel(page, "导出");
    const secondLabel = await clickFirstCompareButton(page);
    expect(Boolean(secondLabel), "新建页面之后，导出分段里仍然没有可对比的版本");
    const panesAfter = await readComparePanes(page);
    expect(panesAfter.length === 0, `历史版本里没有当前这一页时不该摆出两栏，实际 ${panesAfter.length} 栏`);
    const status = await readStatus(page);
    expect(status.includes("没法并排对比"), `状态栏应该说明没法比，实际「${status}」`);
    console.log(`没法比时的状态栏：${status}`);
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error(`\n版本并排对比探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n版本并排对比探针通过：两栏确实是同一交付物的两个版本，历史缺页时也说清楚了没法比。");
}

// 只在直接运行这个脚本时执行；测试会 import 本模块里的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
