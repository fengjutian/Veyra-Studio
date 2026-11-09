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
  NO_NAME,
  type A11yBaseline,
  type A11yAuditInput,
  type AuditCode,
  type AxNode,
  type FocusVisit,
} from "../src/renderer/a11y-audit";
import { findBrowser } from "../../design-export/visual/browser";
import { AX_ELEMENT_FUNCTION, PAGE_HELPERS, domFocusableExpression, focusVisitExpression, styleSnapshotExpression } from "./a11y-page";
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
  nodeKey: string;
  contentKey: string;
  explicitId: string;
  ancestorKeys: string[];
  tag: string;
  role: string;
  tabIndex: number;
  text: string;
}

/** 把 AX 节点回查到 DOM 元素（拿节点身份与 tabIndex）。 */
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
  /** 遍历前的 DOM 扫描原始记录（诊断用）。 */
  domItems: RawElement[];
  /** 遍历结束后的可聚焦元素内容键（稳定状态，用于对账）。 */
  domFocusableAfter: string[];
}

/** 页面侧返回的原始事实。 */
interface RawElement {
  nodeKey: string;
  contentKey: string;
  explicitId: string;
  ancestorKeys: string[];
  tag: string;
  role: string;
  tabIndex: number;
  text: string;
  style: string;
  /** 采集时这个元素是否正处于聚焦状态（聚焦中的元素不能当「聚焦前」基准）。 */
  focused?: boolean;
  /** 可访问名（焦点落点才有；DOM 扫描那边用 contentKey 代替）。 */
  name?: string;
  /** 此刻是否有可见描边（正向证据）。 */
  outlineVisible?: boolean;
  /** 此刻是否有可见阴影（正向证据）。 */
  shadowVisible?: boolean;
}

/**
 * 标识：优先用作者写的显式标识，否则用内容键。
 *
 * 名称优先取 AX（浏览器算出来的可访问名，读屏念的就是它）——但**内容键**由
 * 页面侧统一计算，两边都拿它去认领元素，所以重渲染不会让两侧对不上。
 */
export function semanticId(explicitId: string, contentKey: string): string {
  const stable = (explicitId ?? "").trim();
  return stable || (contentKey ?? "").trim() || NO_NAME;
}

/** 把页面侧辅助函数注入全局——三处采集共用同一份实现。 */
export async function injectPageHelpers(page: CdpPage): Promise<void> {
  await page.evaluate(PAGE_HELPERS);
}

/**
 * 等界面稳定下来再采：连续两次扫描结果一致才算数。
 *
 * 真实界面会异步收敛——Radix 的 roving tabindex 会在重渲染后滞后一拍才把
 * `tabindex` 从 0 改成 -1。急着采会抓到中间态，然后报出一堆并不存在的缺陷。
 */
export async function waitForStableDom(page: CdpPage, options: { attempts?: number; intervalMs?: number } = {}): Promise<RawElement[]> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 120;
  let previous = "";
  let items: RawElement[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    items = await page.evaluate<RawElement[]>(domFocusableExpression());
    const signature = items.map(item => `${item.contentKey}#${item.tabIndex}`).join("|");
    if (signature === previous) return items;
    previous = signature;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return items;
}

/**
 * 等界面把焦点落定再读。
 *
 * Radix 的分段栏是「焦点代理」：Tab 落上去后它会把焦点转交给选中的标签页。
 * 这个转交发生在事件处理里，不一定在我们读 activeElement 之前完成——读早了
 * 就会把分段栏本身当成一个焦点落点，而它并不负责显示焦点环（真正显示的是标签
 * 页），于是报出一条并不存在的「聚焦时看不到变化」。
 */
export async function settleFocus(page: CdpPage): Promise<void> {
  await page.evaluate<boolean>(
    `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`,
  );
}

/** 采集一页的键盘遍历与可访问性树。 */
export async function collectPage(page: CdpPage): Promise<Collection> {
  await injectPageHelpers(page);
  const userAgent = await page.evaluate<string>("navigator.userAgent");

  // ① 可访问性树先采：可访问名与角色以它为准。
  const axNodes: AxNode[] = [];
  for (const node of await page.axTree()) {
    if (node.ignored) continue;
    if (node.backendDOMNodeId === undefined) continue;
    const info = await resolveElement(page, node.backendDOMNodeId);
    if (!info) continue;
    axNodes.push({
      role: node.role,
      name: node.name,
      auditId: semanticId(info.explicitId, info.contentKey),
      key: info.contentKey,
      nodeKey: info.nodeKey,
      ancestorKeys: info.ancestorKeys,
      tag: info.tag,
      // AX 的 focusable 包含 tabindex=-1 的元素（能 focus、不能 Tab）。
      // 只有 tabIndex>=0 的才算「键盘能到」，否则 roving tabindex 会误报。
      focusable: node.focusable && info.tabIndex >= 0,
    });
  }

  // ② DOM 扫描：哪些元素可以 Tab 到（先扫一遍拿「聚焦前」的样式签名，也拿对账基准）。
  //    对账必须用**遍历前**的状态：遍历本身会改变界面——Tab 聚焦到画布节点就会
  //    选中它，属性面板随之启用一批控件，用遍历后的状态对账会凭空多出一堆
  //    「键盘到不了」的假缺陷。
  const domItems = await waitForStableDom(page);

  // 焦点落点的角色以 **AX** 为准（读屏念的就是它）：DOM 的 role 属性对原生控件
  //   是空的（<button> 没有 role="button"），只看它会把按钮记成「无角色」。
  //   先按节点身份找（最准），找不到再按内容键找（重渲染后节点换了还能认领）。
  const axRoleByNodeKey = new Map<string, string>();
  const axRoleByKey = new Map<string, string>();
  for (const node of axNodes) {
    if (!node.role) continue;
    if (!axRoleByNodeKey.has(node.nodeKey)) axRoleByNodeKey.set(node.nodeKey, node.role);
    if (!axRoleByKey.has(node.key)) axRoleByKey.set(node.key, node.role);
  }

  // 基准只取「此刻没有聚焦」的元素：聚焦中的元素采到的是聚焦后的样式，
  // 拿它当「聚焦前」基准会把有焦点环误判成没变化。
  const styleByNodeKey = new Map(
    domItems.filter(item => !item.focused).map(item => [item.nodeKey, item.style] as const),
  );
  const styleByKey = new Map<string, string>();
  for (const item of domItems) {
    if (item.focused) continue;
    if (!styleByKey.has(item.contentKey)) styleByKey.set(item.contentKey, item.style);
  }
  const domFocusableOrder = domItems.map(item => item.contentKey);

  /**
   * 补采「刚变得可 Tab 的元素」的聚焦前样式。
   *
   * 界面在遍历途中会变：选中画布节点后属性面板才渲染出输入框，画布的隐藏
   * listbox 也会把 roving tabindex 挪到当前选项上。这些元素在初始扫描时还
   * 不存在（或还不可 Tab），没有「聚焦前」的基准就判不出焦点指示——只能
   * 报出并不存在的缺陷。所以在每次按 Tab 之前补一次。
   */
  const captureNewStyles = async (): Promise<void> => {
    const fresh = await page.evaluate<{ nodeKey: string; contentKey: string; style: string }[]>(
      styleSnapshotExpression(),
    );
    for (const item of fresh) {
      if (!styleByNodeKey.has(item.nodeKey)) styleByNodeKey.set(item.nodeKey, item.style);
      if (!styleByKey.has(item.contentKey)) styleByKey.set(item.contentKey, item.style);
    }
  };

  // ③ 真实 Tab 遍历：按到底为止（焦点回到 body）或超过 DOM 里的可聚焦元素数就停。
  //    起点必须显式摆正：Chrome 的「顺序焦点起点」不会因为 blur 重置，上一轮
  //    遍历停在哪儿，下一轮就从哪儿继续——后面几个面板于是只覆盖了半张界面。
  //    所以先聚焦第一个可聚焦元素，再往后 Tab，序列才是完整的。
  const focusSequence: FocusVisit[] = [];
  const limit = Math.max(domItems.length + 4, 8);
  const readVisit = async (): Promise<FocusVisit | undefined> => {
    const visit = await page.evaluate<RawElement | null>(focusVisitExpression());
    if (!visit) return undefined;
    const viaNode = styleByNodeKey.get(visit.nodeKey);
    const baseline = viaNode ?? styleByKey.get(visit.contentKey);
    if (process.env.A11Y_DEBUG_FOCUS && baseline === visit.style) {
      console.log(
        `  [focus-debug] key="${visit.contentKey}" tag=${visit.tag} 来源=${viaNode !== undefined ? "节点身份" : "内容键回退"} 签名=${visit.style}`,
      );
    }
    return {
      order: focusSequence.length + 1,
      tag: visit.tag,
      // 角色以 AX 为准（读屏念的），回退到 DOM 的 role 属性。
      role: axRoleByNodeKey.get(visit.nodeKey) ?? axRoleByKey.get(visit.contentKey) ?? visit.role ?? "",
      // 名称用页面侧的近似算法（aria-label → aria-labelledby → label → 文字 → 标题
      // → 占位符）。它是标准算法、且不依赖任何跨时刻的关联，所以稳定。
      name: visit.name ?? "",
      auditId: semanticId(visit.explicitId, visit.contentKey),
      key: visit.contentKey,
      nodeKey: visit.nodeKey,
      ancestorKeys: visit.ancestorKeys,
      tabIndex: visit.tabIndex,
      // 拿不到「聚焦前」基准时是**未知**，不是「没变化」——把未知当成缺陷，
      // 就会把属性面板那批刚渲染出来的输入框全报一遍（实测的假阳性）。
      // 但若此刻能看到描边或阴影，那是**正向证据**：至少看得见一个环。
      focusIndicator: baseline === undefined
        ? (visit.outlineVisible || visit.shadowVisible ? true : undefined)
        : baseline !== visit.style,
    };
  };

  await page.evaluate(
    `(() => { const el = firstInTabOrder(); if (el) { el.focus(); return true; } return false; })()`,
  );
  await settleFocus(page);
  const first = await readVisit();
  if (first) focusSequence.push(first);
  for (let step = 0; step < limit; step += 1) {
    await captureNewStyles();
    await page.pressKey("Tab");
    await settleFocus(page);
    const visit = await readVisit();
    if (!visit) break;
    focusSequence.push(visit);
  }

  // ④ 遍历之后再扫一次 DOM：拿**稳定状态**来对账。界面在遍历途中会变（选中节点
  //    会让属性面板启用一批控件，Radix 的分段控件重渲染后 tabindex 会变），
  //    只有「遍历前后都在」的控件才配谈「键盘到不了」。
  const domAfter = await waitForStableDom(page);
  const domFocusableAfter = domAfter.map(item => item.contentKey);

  // ⑤ 复合控件内的方向键遍历（画布的隐藏 listbox）。
  const expected = await page.evaluate<string[]>(
    `Array.from(document.querySelectorAll('.canvas-a11y [role="option"]')).map(el => el.getAttribute("data-node-id") || "")`,
  );
  let arrowTraversal: { visited: string[]; expected: string[] } | undefined;
  if (expected.length) {
    await page.evaluate(`(() => { const el = document.querySelector('.canvas-a11y [role="option"]'); if (el) el.focus(); return true; })()`);
    const visited: string[] = [];
    for (let step = 0; step < expected.length; step += 1) {
      const nodeId = await page.evaluate<string | null>(
        `(() => { const el = document.activeElement; return el ? (el.getAttribute("data-node-id") || "") : null; })()`,
      );
      if (nodeId !== null) visited.push(nodeId);
      if (step < expected.length - 1) await page.pressKey("ArrowDown");
    }
    arrowTraversal = { visited, expected };
  }

  return {
    focusSequence,
    axNodes,
    domFocusableOrder,
    ...(arrowTraversal ? { arrowTraversal } : {}),
    userAgent,
    domItems,
    domFocusableAfter,
  };
}

export function toAuditInput(collection: Collection): A11yAuditInput {
  return {
    focusSequence: collection.focusSequence,
    axNodes: collection.axNodes,
    domFocusableOrder: collection.domFocusableOrder,
    domFocusableAfter: collection.domFocusableAfter,
    domItems: collection.domItems.map(item => ({
      nodeKey: item.nodeKey,
      key: item.contentKey,
      role: item.role,
      ancestorKeys: item.ancestorKeys,
    })),
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
    if (process.env.A11Y_DEBUG_FOCUS) {
      for (const visit of collection.focusSequence) {
        console.log(`    ${visit.order}. [${visit.auditId}] tag=${visit.tag} role=${visit.role || "（无）"} name="${visit.name}" key="${visit.key}"`);
      }
    }
    for (const issue of issues) console.log(`  ${formatIssue(issue)}`);
    if (summary.errors) {
      failures.push(`正常样本报出 ${summary.errors} 个错误（应当是 0）`);
    }

    // ── 阴性对照 ────────────────────────────────────────────────
    const defectPage = await browser.newPage(pathToFileURL(defectsHtml).href);
    await waitForReady(defectPage);
    const defectCollection = await collectPage(defectPage);
    const defectIssues = auditA11y(toAuditInput(defectCollection));
    if (process.env.A11Y_DEBUG_FOCUS) {
      console.log("  ── 阴性对照的 Tab 落点 ──");
      for (const visit of defectCollection.focusSequence) {
        console.log(`    ${visit.order}. [${visit.auditId}] tag=${visit.tag} role=${visit.role || "（无）"} tabIndex=${visit.tabIndex} key="${visit.key}"`);
      }
      console.log("  ── 阴性对照的 DOM 顺序 ──");
      defectCollection.domFocusableOrder.forEach((key, index) => console.log(`    ${index + 1}. ${key}`));
      console.log("  ── 阴性对照遍历后的 DOM 顺序 ──");
      defectCollection.domFocusableAfter?.forEach((key, index) => console.log(`    ${index + 1}. ${key}`));
    }
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
