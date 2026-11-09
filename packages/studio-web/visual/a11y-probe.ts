/**
 * 可访问性自动化：键盘遍历 + 屏幕阅读器语义。
 *
 *   npm run visual:a11y:baseline      # 采集当前语义并写入基线
 *   npm run visual:a11y:check         # 与基线比较 + 跑规则，出错即失败
 *   npm run visual:a11y:check -- --require-browser
 *   npm run visual:a11y:check -- --url=http://127.0.0.1:5173/   # 临时查任意页面
 *
 * 做两件事：
 *
 * ① **键盘遍历**：用 CDP 派发真实的 Tab 键，记录焦点落在哪些元素上——不是模拟
 *    「如果用户按 Tab 会怎样」，而是浏览器真的按了 Tab。
 * ② **屏幕阅读器语义**：读 Chrome 的可访问性树（AX tree）。读屏器看到的就是这棵树，
 *    所以「角色 + 可访问名 + 能不能聚焦」直接来自它，不用我们猜语义。
 *
 * 两边**互相交叉验证**：AX 说能聚焦、Tab 却到不了，和 Tab 能到、AX 里却没有名字，
 * 都是缺陷。单看一边都会漏。
 *
 * 另外有一个**阴性对照页面**（harness/a11y-defects.tsx），里面故意留了缺陷。
 * 探针会断言这些缺陷确实被报出来——否则「检查通过」只是因为规则根本没生效。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  auditA11y,
  buildA11yBaseline,
  compareA11yBaseline,
  formatIssue,
  summarizeIssues,
  type A11yBaseline,
  type A11yAuditInput,
  type AuditCode,
  type AxNode,
  type FocusVisit,
} from "../src/renderer/a11y-audit";
import { findBrowser } from "../../design-export/visual/browser";
import { AX_ELEMENT_FUNCTION, domFocusableExpression, focusVisitExpression } from "./a11y-page";
import { launchHeadlessBrowser, type CdpPage } from "./cdp";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const BASELINE = join(here, "a11y-baseline.json");
const CACHE = join(here, ".cache", "a11y");

/** 阴性对照页面必须报出来的缺陷。少一条就说明规则（或采集）坏了。 */
const EXPECTED_DEFECT_CODES: AuditCode[] = [
  "missing-accessible-name",
  "ax-name-missing",
  "positive-tabindex",
  "focus-order-mismatch",
  "no-focus-indicator",
];

interface Args {
  update: boolean;
  requireBrowser: boolean;
  /** 只跑规则，不与基线比对（CI 里用：基线可能随 Chrome 版本漂移，规则不会）。 */
  noBaseline: boolean;
  browserPath?: string;
  url?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    update: argv.includes("--update"),
    requireBrowser: argv.includes("--require-browser"),
    noBaseline: argv.includes("--no-baseline"),
    browserPath: value("--browser="),
    url: value("--url="),
  };
}

/** 打包一个 harness 入口，产出可直接 file:// 打开的 HTML。 */
async function buildPage(entry: string, outName: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    loader: { ".css": "css" },
    // CSS 入口必须配 outdir（esbuild 要知道 CSS 产物写到哪里），但产物留在内存里，
    // 由我们自己内联进 HTML。
    outdir: CACHE,
    write: false,
    logLevel: "silent",
  });
  const js = result.outputFiles.find(file => file.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles.filter(file => file.path.endsWith(".css")).map(file => file.text).join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>${outName}</title>
<style>html,body{margin:0;padding:0;background:#111318}</style>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js.replace(/<\/script>/gi, "<\\/script>")}</script>
</body></html>`;
  mkdirSync(CACHE, { recursive: true });
  const htmlPath = join(CACHE, `${outName}.html`);
  writeFileSync(htmlPath, html, "utf8");
  return htmlPath;
}

async function waitForReady(page: CdpPage): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate<boolean>(`document.body?.dataset?.auditReady === "1"`);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("harness 页面没有就绪（auditReady 没有置位）");
}

interface ElementInfo {
  auditId: string;
  tag: string;
  role: string;
  tabIndex: number;
}

/** 把 AX 节点回查到 DOM 元素（拿稳定标识与 tabIndex）。 */
async function resolveElement(page: CdpPage, backendNodeId: number): Promise<ElementInfo | null> {
  try {
    const resolved = await page.send<any>("DOM.resolveNode", { backendNodeId });
    const objectId = resolved?.object?.objectId;
    if (!objectId) return null;
    const result = await page.send<any>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: AX_ELEMENT_FUNCTION,
      returnByValue: true,
    });
    await page.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    const value = result?.result?.value as ElementInfo | null | undefined;
    return value ?? null;
  } catch {
    return null;
  }
}

export interface Collection {
  focusSequence: FocusVisit[];
  axNodes: AxNode[];
  domFocusableOrder: string[];
  arrowTraversal?: { visited: string[]; expected: string[] };
  userAgent: string;
}

/** 采集一页的键盘遍历与可访问性树。 */
export async function collectPage(page: CdpPage): Promise<Collection> {
  const userAgent = await page.evaluate<string>("navigator.userAgent");
  const domItems = await page.evaluate<Array<{ auditId: string; tag: string; role: string; tabIndex: number; style: string }>>(
    domFocusableExpression(),
  );

  // 聚焦前的样式签名：用来判断「聚焦时有没有可见变化」。
  const baselineStyles = new Map(domItems.map(item => [item.auditId, item.style]));

  // 真实 Tab 遍历：按到底为止（焦点回到 body）或超过 DOM 里的可聚焦元素数就停。
  const focusSequence: FocusVisit[] = [];
  const limit = Math.max(domItems.length + 4, 8);
  for (let step = 0; step < limit; step += 1) {
    await page.pressKey("Tab");
    const visit = await page.evaluate<(FocusVisit & { style: string }) | null>(focusVisitExpression());
    if (!visit) break;
    const baseline = baselineStyles.get(visit.auditId);
    focusSequence.push({
      order: focusSequence.length + 1,
      tag: visit.tag,
      role: visit.role,
      name: visit.name,
      auditId: visit.auditId,
      tabIndex: visit.tabIndex,
      focusIndicator: baseline === undefined ? false : baseline !== visit.style,
    });
  }

  // 可访问性树：过滤 ignored，再回查 DOM 拿标识。
  const axNodes: AxNode[] = [];
  for (const node of await page.axTree()) {
    if (node.ignored) continue;
    if (node.backendDOMNodeId === undefined) continue;
    const info = await resolveElement(page, node.backendDOMNodeId);
    if (!info) continue;
    axNodes.push({
      role: node.role,
      name: node.name,
      auditId: info.auditId,
      tag: info.tag,
      // AX 的 focusable 包含 tabindex=-1 的元素（能 focus、不能 Tab）。
      // 只有 tabIndex>=0 的才算「键盘能到」，否则 roving tabindex 会误报。
      focusable: node.focusable && info.tabIndex >= 0,
    });
  }

  // 可访问名与角色以 AX 为准（浏览器算出来的名字、角色才是读屏念的那个）。
  const axNames = new Map<string, string>();
  const axRoles = new Map<string, string>();
  for (const node of axNodes) {
    if (node.name.trim() && !axNames.has(node.auditId)) axNames.set(node.auditId, node.name);
    if (node.role && !axRoles.has(node.auditId)) axRoles.set(node.auditId, node.role);
  }
  for (const visit of focusSequence) {
    const name = axNames.get(visit.auditId);
    if (name) visit.name = name;
    const role = axRoles.get(visit.auditId);
    if (role) visit.role = role;
  }

  // 复合控件内的方向键遍历（画布的隐藏 listbox）。
  const expected = await page.evaluate<string[]>(
    `Array.from(document.querySelectorAll('.canvas-a11y [role="option"]')).map(el => el.getAttribute("data-node-id") || "")`,
  );
  let arrowTraversal: { visited: string[]; expected: string[] } | undefined;
  if (expected.length) {
    await page.evaluate(`(() => { const el = document.querySelector('.canvas-a11y [role="option"]'); if (el) el.focus(); return true; })()`);
    const visited: string[] = [];
    for (let step = 0; step < expected.length; step += 1) {
      const visit = await page.evaluate<{ auditId: string } | null>(focusVisitExpression());
      if (visit) visited.push(visit.auditId);
      if (step < expected.length - 1) await page.pressKey("ArrowDown");
    }
    arrowTraversal = { visited, expected };
  }

  return {
    focusSequence,
    axNodes,
    domFocusableOrder: domItems.map(item => item.auditId),
    ...(arrowTraversal ? { arrowTraversal } : {}),
    userAgent,
  };
}

function toAuditInput(collection: Collection): A11yAuditInput {
  return {
    focusSequence: collection.focusSequence,
    axNodes: collection.axNodes,
    domFocusableOrder: collection.domFocusableOrder,
    ...(collection.arrowTraversal ? { arrowTraversal: collection.arrowTraversal } : {}),
  };
}

function parseBrowserVersion(userAgent: string): string | undefined {
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  if (edge) return `Edge ${edge[1]}`;
  const chrome = /Chrome\/([\d.]+)/.exec(userAgent);
  if (chrome) return `Chrome ${chrome[1]}`;
  const safari = /Version\/([\d.]+).*Safari/.exec(userAgent);
  if (safari) return `Safari ${safari[1]}`;
  const firefox = /Firefox\/([\d.]+)/.exec(userAgent);
  if (firefox) return `Firefox ${firefox[1]}`;
  return undefined;
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
      console.log(`${message}，跳过可访问性检查。`);
    }
    return;
  }

  const workbenchHtml = await buildPage(join(root, "packages", "studio-web", "harness", "a11y-workbench.tsx"), "a11y-workbench");
  const defectsHtml = await buildPage(join(root, "packages", "studio-web", "harness", "a11y-defects.tsx"), "a11y-defects");

  const browser = await launchHeadlessBrowser(browserPath);
  const failures: string[] = [];
  try {
    // ── 正常样本 ────────────────────────────────────────────────
    const page = await browser.newPage(pathToFileURL(workbenchHtml).href);
    await waitForReady(page);
    const collection = await collectPage(page);
    const issues = auditA11y(toAuditInput(collection));
    const summary = summarizeIssues(issues);

    console.log(`焦点落点 ${collection.focusSequence.length} 个，AX 交互节点 ${collection.axNodes.length} 个。`);
    for (const issue of issues) console.log(`  ${formatIssue(issue)}`);
    if (summary.errors) {
      failures.push(`正常样本报出 ${summary.errors} 个错误（应当是 0）`);
    }

    // ── 阴性对照 ────────────────────────────────────────────────
    const defectPage = await browser.newPage(pathToFileURL(defectsHtml).href);
    await waitForReady(defectPage);
    const defectCollection = await collectPage(defectPage);
    const defectIssues = auditA11y(toAuditInput(defectCollection));
    const defectCodes = new Set(defectIssues.map(issue => issue.code));
    const missing = EXPECTED_DEFECT_CODES.filter(code => !defectCodes.has(code));
    if (missing.length) {
      failures.push(`阴性对照页面没报出预期缺陷：${missing.join("、")}（规则可能没生效）`);
    }
    const unexpected = [...defectCodes].filter(code => !EXPECTED_DEFECT_CODES.includes(code));
    if (unexpected.length) {
      failures.push(`阴性对照页面报出了预期之外的缺陷：${unexpected.join("、")}`);
    }
    console.log(`阴性对照：预期缺陷 ${EXPECTED_DEFECT_CODES.length} 条，实报 ${defectCodes.size} 条。`);

    // ── 可选：额外查一个任意地址 ────────────────────────────────
    if (args.url) {
      const extraPage = await browser.newPage(args.url);
      await new Promise(resolve => setTimeout(resolve, 800));
      const extraCollection = await collectPage(extraPage);
      const extraIssues = auditA11y(toAuditInput(extraCollection));
      console.log(`额外目标 ${args.url}：焦点落点 ${extraCollection.focusSequence.length} 个，问题 ${extraIssues.length} 条。`);
      for (const issue of extraIssues) console.log(`  ${formatIssue(issue)}`);
    }

    // ── 基线 ────────────────────────────────────────────────────
    const environment = {
      os: process.platform,
      osRelease: `${process.platform} ${release()}`,
      browser: parseBrowserVersion(collection.userAgent),
      userAgent: collection.userAgent,
      generatedAt: new Date().toISOString(),
    };
    const current = buildA11yBaseline(environment, collection.focusSequence, collection.axNodes);

    if (args.update) {
      writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
      console.log(`已更新可访问性基线：${BASELINE}`);
    } else if (args.noBaseline) {
      console.log("已跳过基线比对（--no-baseline）：只判定规则。");
    } else {
      let baseline: A11yBaseline;
      try {
        baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as A11yBaseline;
      } catch (error) {
        failures.push(`读取可访问性基线失败：${error instanceof Error ? error.message : String(error)}；先运行 npm run visual:a11y:baseline`);
        baseline = { environment, focusOrder: [], announcements: [] };
      }
      const diff = compareA11yBaseline(baseline, current);
      for (const change of diff.focusChanges) console.log(`  焦点顺序变化：${change}`);
      for (const change of diff.announcementChanges) console.log(`  读屏脚本变化：${change}`);
      if (diff.focusChanges.length || diff.announcementChanges.length) {
        failures.push(
          `可访问性语义与基线不一致（焦点 ${diff.focusChanges.length} 处、读屏 ${diff.announcementChanges.length} 处）；`
          + "确认是有意改动后用 npm run visual:a11y:baseline 更新基线",
        );
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`可访问性检查失败（${failures.length} 项）：`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("可访问性检查通过：键盘遍历顺序、可访问名、可访问性树与焦点可见性均正常，阴性对照也如预期报出了缺陷。");
}

// 只在直接运行这个脚本时执行；测试会 import 本模块里的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
