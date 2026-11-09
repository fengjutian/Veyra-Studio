/**
 * 整应用可访问性走查（不是组件级 harness）。
 *
 *   npm run visual:a11y:app
 *   npm run visual:a11y:app -- --require-browser
 *
 * 组件级 harness（`visual:a11y:check`）证明的是「这些组件本身没毛病」，但真实
 * 工作台还有大量没被 harness 覆盖的交互：顶栏、图层面板、五个检查器分段
 * （属性 / 导出 / 历史 / 数据 / AI）、弹窗。这一份检查把它们全走一遍。
 *
 * 做法：
 *  ① 用 http:// 打开**构建产物**（file:// 下浏览器禁掉 IndexedDB，项目仓库是
 *     Dexie + IndexedDB，file:// 打开只能看到空壳）；
 *  ② 用真实的「导入 JSON」入口灌一份 fixture 文档——这样画布的隐藏 listbox 里
 *     真的有节点，键盘/读屏那条路径才被覆盖到；
 *  ③ 逐个检查器分段各跑一遍键盘遍历 + 可访问性树采集。
 *
 * 报告的是**真实界面**的问题：控件没有可访问名、焦点顺序乱、键盘到不了、
 * 聚焦时看不到焦点在哪——这些在组件级 harness 里看不出来。
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditA11y, formatIssue, summarizeIssues, type AuditIssue } from "../src/renderer/a11y-audit";
import { findBrowser } from "../../design-export/visual/browser";
import { fixtureDocument } from "../harness/fixture";
import { collectPage, toAuditInput } from "./a11y-probe";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";
import { serveDirectory } from "./static-server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const DIST = join(root, "packages", "studio-web", "dist");

/** 检查器的五个分段。名字取自 `inspector-tabs.ts`。 */
const PANELS = [
  { id: "properties", label: "属性" },
  { id: "export", label: "导出" },
  { id: "history", label: "历史" },
  { id: "data", label: "数据" },
  { id: "ai", label: "AI" },
];

interface Args {
  requireBrowser: boolean;
  /** 打印 Tab 落点序列与 DOM 顺序：报告说「某个控件键盘到不了」时，用它看差在哪。 */
  verbose: boolean;
  /** 打印某个内容键对应的 DOM 元素（标签、角色、tabindex）。 */
  debugKey?: string;
  browserPath?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    requireBrowser: argv.includes("--require-browser"),
    verbose: argv.includes("--verbose"),
    debugKey: value("--debug-key="),
    browserPath: value("--browser="),
  };
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
      // 应用启动是异步的（开仓库、恢复项目），再等一小会儿让首屏稳定。
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
 * 走的是应用自己的导入流程（文件输入框 → change 事件），不是往 IndexedDB 里
 * 直接塞记录——后者要照抄 Dexie 的内部格式，换个版本就悄悄失效。
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
  // CDP 设文件不会触发 change，React 收不到——手动补一个。
  await page.evaluate(
    `(() => { const node = document.querySelector('input[accept*="application/json"]'); if (node) node.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`,
  );
}

/** 等导入生效：画布的隐藏 listbox 里出现节点。 */
async function waitForCanvasNodes(page: CdpPage, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.evaluate<number>(`document.querySelectorAll('.canvas-a11y [role="option"]').length`);
    if (count > 0) return count;
    await sleep(150);
  }
  throw new Error("导入之后画布结构里仍没有节点（导入没生效？）");
}

/**
 * 切到某个检查器分段。
 *
 * 必须用**真实的鼠标事件**：Radix 的 Tabs.Trigger 是在 `mousedown` 上激活的
 * （为了不让 Tab 焦点先跑掉），脚本调用 `.click()` 只派发 click，React 收不到
 * mousedown，分段根本没切换——上一轮五个分段的焦点落点数一模一样，等于只走查了
 * 属性面板。
 */
async function switchPanel(page: CdpPage, label: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number } | null>(
    `(() => {
       const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
       const target = tabs.find(tab => (tab.textContent || "").trim().startsWith(${JSON.stringify(label)}));
       if (!target) return null;
       const rect = target.getBoundingClientRect();
       return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
     })()`,
  );
  if (!point) throw new Error(`找不到检查器分段「${label}」`);
  const base = { x: point.x, y: point.y, button: "left", clickCount: 1 };
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
  await sleep(500);
}

/** 确认分段真的切过去了：选中项的文字要跟目标分段一致。 */
async function readActivePanel(page: CdpPage): Promise<string> {
  return page.evaluate<string>(
    `(() => {
       const tab = document.querySelector('[role="tab"][aria-selected="true"]');
       return tab ? (tab.textContent || "").trim() : "";
     })()`,
  );
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
      console.log(`${message}，跳过整应用可访问性走查。`);
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
  const issues: AuditIssue[] = [];
  try {
    const page = await browser.newPage(server.url);
    await waitForApp(page);
    await seedDocument(page);
    const nodes = await waitForCanvasNodes(page);
    console.log(`工作台已启动，导入的 fixture 在画布上有 ${nodes} 个节点。`);

    for (const panel of PANELS) {
      if (panel.id !== "properties") await switchPanel(page, panel.label);
      const active = await readActivePanel(page);
      if (!active.startsWith(panel.label)) {
        throw new Error(`分段没切到「${panel.label}」（当前是「${active}」）——不能拿没切换的界面凑合`);
      }
      const collection = await collectPage(page);
      const panelIssues = auditA11y(toAuditInput(collection));
      issues.push(...panelIssues);
      console.log(`\n[${panel.label}] 焦点落点 ${collection.focusSequence.length} 个，AX 交互节点 ${collection.axNodes.length} 个，问题 ${panelIssues.length} 条。`);
      for (const issue of panelIssues) console.log(`  ${formatIssue(issue)}`);
      if (args.verbose) {
        console.log(`  ── Tab 落点序列 ──`);
        for (const visit of collection.focusSequence) console.log(`    ${visit.order}. [${visit.auditId}] ${visit.role}:${visit.name}`);
        console.log(`  ── DOM 顺序（前 60）──`);
        collection.domFocusableOrder.slice(0, 60).forEach((id, index) => console.log(`    ${index + 1}. ${id}`));
      }
      if (args.debugKey) {
        const matches = await page.evaluate<any[]>(
          `(() => Array.from(document.querySelectorAll("*"))
             .filter(el => contentKeyOf(el) === ${JSON.stringify(args.debugKey)})
             .map(el => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", tabIndex: el.tabIndex, tabbable: isTabbable(el), html: el.outerHTML.slice(0, 120) })))()`,
        );
        console.log(`  ── 键「${args.debugKey}」对应的元素 ──`);
        for (const match of matches) console.log(`    ${match.tag} role=${match.role || "（无）"} tabIndex=${match.tabIndex} 可Tab=${match.tabbable} :: ${match.html}`);
        const scanned = collection.domItems.filter(item => item.contentKey === args.debugKey);
        console.log(`  ── 遍历前 DOM 扫描里命中该键的记录 ──`);
        for (const item of scanned) console.log(`    ${item.tag} role=${item.role || "（无）"} tabIndex=${item.tabIndex} nodeKey=${item.nodeKey}`);
        const reached = collection.focusSequence.filter(visit => visit.key === args.debugKey);
        console.log(`  ── Tab 落点里命中该键的记录（${reached.length} 个）──`);
        for (const visit of reached) console.log(`    ${visit.order}. ${visit.tag} role=${visit.role} nodeKey=${visit.nodeKey}`);
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const summary = summarizeIssues(issues);
  if (summary.errors) {
    console.error(`\n整应用可访问性走查失败：${summary.errors} 个错误、${summary.warnings} 个警告。`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n整应用可访问性走查通过（${summary.warnings} 个警告）。`);
}

// 只在直接运行这个脚本时执行；测试会 import 本模块里的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
