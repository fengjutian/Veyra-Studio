/**
 * 编排循环的端到端探针。
 *
 *   npm run visual:loop:probe
 *   npm run visual:loop:probe -- --require-browser
 *
 * 回答一个问题：**「自主运行」这个入口真的把循环跑起来了吗？**
 *
 * 单元测试（`ai-orchestrator/test/autonomous-loop.test.ts`）覆盖的是编排层本身：
 * 停止条件、指纹、震荡判定、回喂通道。它们跑在内存仓库上，不经过界面。
 *
 * 这个探针补的是**接线**：按钮 → 循环 → 提交 → 轮次日志 → 停止原因。
 * 纯逻辑测得再对，界面上按钮没接上、轮次日志没渲染，一样是废的。
 *
 * 这里没有真实模型，所以探针自己**接管 fetch**，拦下模型请求、回一份固定的计划：
 * 每轮在当前页面新建一张蓝卡片，完全不看体检清单。这正合适：这份计划修不好任何问题，
 * 循环就该一路跑到停止条件，然后**如实**报出停止原因，而不是假装收敛。所以断言是
 * 「跑了几轮、每轮都落地了命令、画布上的节点真的变多了、最后说了为什么停」。
 *
 * 为什么不用演示规划器：产品已经改成「AI 功能必须配真实模型」（提交 089c63a），
 * 没配模型时「自主运行」按钮是禁用的，演示规划器在界面上已经点不到。
 * 自己接管 fetch 反而更接近真实——走的是完整的 OpenAI 兼容协议（SSE 流式）。
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
 * 装一个假的模型端点。
 *
 * 两件事一起做：
 * 1. 把 AI 设置写进 localStorage（`enabled: true` + 一个本地地址）——产品要求配了
 *    真实模型才让用 AI 功能，不写这段「自主运行」按钮是禁用的。
 * 2. 接管 `window.fetch`：拦下 `/chat/completions`，按 OpenAI 兼容协议回一份 SSE 流，
 *    正文是一份「在当前页面新建一张蓝卡片」的计划。
 *
 * 用 `Page.addScriptToEvaluateOnNewDocument` 注入：它在页面任何脚本之前跑，
 * 刷新页面也不会丢——设置和补丁都不用等到应用加载后再补。
 */
async function installMockModel(page: CdpPage): Promise<void> {
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
  try {
    localStorage.setItem("studio:ai-settings", JSON.stringify({
      enabled: true,
      baseUrl: "http://localhost:11434/v1",
      model: "mock-planner",
      timeoutMs: 30000,
      maxTokens: 8192,
      thinkingMode: "off"
    }));
  } catch (error) {
    // about:blank 上没有 localStorage，忽略。
  }
  const original = window.fetch.bind(window);
  window.__veyraMock = { requests: 0 };
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!url.includes("/chat/completions")) return original(input, init);
    window.__veyraMock.requests += 1;
    const plan = buildMockPlan(init && init.body);
    const sse = "data: " + JSON.stringify({ choices: [{ delta: { content: JSON.stringify(plan) } }] }) + "\\n\\ndata: [DONE]\\n\\n";
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  function buildMockPlan(body) {
    let prompt = "";
    try {
      const parsed = JSON.parse(String(body || ""));
      const user = (parsed.messages || []).find(message => message.role === "user");
      const content = user && user.content;
      prompt = typeof content === "string" ? content : (content || []).map(part => part.text || "").join("\\n");
    } catch (error) {
      // 请求体读不出来：下面的节点就没有父级，dry-run 会拦下来。
    }
    // 页面 id 从提示词里的「可用页面」段取——模型就是这么知道该往哪放节点的。
    const section = (prompt.split("可用页面：")[1] || "").split("节点树：")[0];
    const match = /- (\\S+) 名称="/.exec(section);
    const pageId = match ? match[1] : "";
    return {
      summary: "探针模型：在当前页面新建一张蓝色卡片",
      assumptions: ["卡片放在当前页面下"],
      commands: [{
        type: "node.create",
        payload: {
          node: {
            id: "frame:mock-card-" + window.__veyraMock.requests,
            type: "frame",
            name: "AI 卡片",
            parentId: pageId,
            childIds: [],
            visible: true,
            locked: false,
            layout: { mode: "absolute", x: 340, y: 120, width: 280, height: 180, widthMode: "fixed", heightMode: "fixed" },
            appearance: { opacity: 1, fills: [{ type: "solid", color: "#2563eb" }], cornerRadius: 20 }
          }
        }
      }]
    };
  }
})();`,
  });
}

/** 展开「高级：自主运行」折叠区。按钮默认收在折叠区里，不展开就点不到。 */
async function openAdvancedSection(page: CdpPage): Promise<void> {
  const state = await page.evaluate<{ found: boolean; open: boolean }>(
    `(() => {
       const details = document.querySelector("details.ai-advanced");
       if (!details) return { found: false, open: false };
       if (!details.open) {
         const summary = details.querySelector("summary");
         if (summary) summary.setAttribute("data-probe-summary", "1");
       }
       return { found: true, open: details.open };
     })()`,
  );
  if (!state.found) throw new Error("AI 分段里没有「高级：自主运行」折叠区");
  if (state.open) return;
  await clickSelector(page, '[data-probe-summary="1"]');
  await sleep(300);
}

/** 用真实的「导入 JSON」入口灌一份 fixture 文档。 */
async function seedDocument(page: CdpPage): Promise<void> {
  const file = join(mkdtempSync(join(tmpdir(), "design-ai-loop-seed-")), "fixture.json");
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

/**
 * 用真实鼠标点一个元素（按选择器）。
 *
 * 先把元素滚进视口：检查器面板是可滚动的，「自主运行」在 AI 分段底部，
 * 不滚的话算出来的坐标落在视口外，鼠标事件就点空了。
 */
async function clickSelector(page: CdpPage, selector: string): Promise<boolean> {
  const found = await page.evaluate<boolean>(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: "center", inline: "center" }); return true; })()`,
  );
  if (!found) return false;
  await sleep(250);
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

/**
 * 往受控输入框里写值。
 *
 * React 受控组件盯的是 `input` 事件，直接设 `el.value` 会被它当成「用户没输入」
 * 而回滚，所以必须走原型上的 setter。
 */
async function setInputValue(page: CdpPage, selector: string, value: string): Promise<void> {
  const ok = await page.evaluate<boolean>(
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event("input", { bubbles: true }));
       return true;
     })()`,
  );
  if (!ok) throw new Error(`页面上找不到输入框 ${selector}`);
}

/** 画布上的节点数（可访问性图层给每个节点留了 data-node-id）。 */
async function canvasNodeCount(page: CdpPage): Promise<number> {
  return page.evaluate<number>(`document.querySelectorAll("[data-node-id]").length`);
}

/** 等轮次日志出现（循环跑完会写收尾结论）。 */
async function waitForLoopSummary(page: CdpPage, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = await page.evaluate<string>(
      `(() => { const el = document.querySelector(".loop-summary"); return el ? (el.textContent || "").trim() : ""; })()`,
    );
    if (last) return last;
    await sleep(200);
  }
  // 失败时把现场读出来：状态栏说什么、轮次日志有没有、按钮是不是被禁用了。
  const scene = await page.evaluate<string>(
    `(() => {
       const status = (document.querySelector(".status")?.textContent || "").trim();
       const rounds = document.querySelectorAll(".loop-round").length;
       const button = Array.from(document.querySelectorAll("button")).find(el => (el.textContent || "").includes("自主运行"));
       const value = document.querySelector('textarea[aria-label="AI 指令"]')?.value || "";
       return JSON.stringify({ status, rounds, disabled: button ? button.disabled : null, value });
     })()`,
  );
  throw new Error(`自主运行没有给出收尾结论（.loop-summary 一直是空的）。现场：${scene}`);
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
      console.log(`${message}，跳过编排循环探针。`);
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
    const page = await browser.newPage("");
    // 先装假的模型端点再导航：设置和 fetch 补丁都要在应用脚本之前就位。
    await installMockModel(page);
    await page.navigate(server.url);
    await waitForApp(page);
    await seedDocument(page);

    const before = await canvasNodeCount(page);
    if (args.verbose) console.log(`开跑前画布节点数：${before}`);

    await switchPanel(page, "AI");
    await setInputValue(page, 'textarea[aria-label="AI 指令"]', "把这份设计的可访问性问题修掉");
    await openAdvancedSection(page);

    const clicked = await page.evaluate<boolean>(
      `(() => {
         const button = Array.from(document.querySelectorAll("button")).find(el => (el.textContent || "").includes("自主运行"));
         if (!button) return false;
         button.setAttribute("data-probe-loop", "1");
         return true;
       })()`,
    );
    expect(clicked, "AI 分段里没有「自主运行」按钮");
    if (!clicked) throw new Error("AI 分段里没有「自主运行」按钮");
    await clickSelector(page, '[data-probe-loop="1"]');

    const summary = await waitForLoopSummary(page);
    const modelCalls = await page.evaluate<number>(`Number((window.__veyraMock && window.__veyraMock.requests) || 0)`);
    expect(modelCalls >= 1, `模型端点一次都没被调用（${modelCalls} 次）——循环没真的走模型`);
    if (args.verbose) console.log(`模型端点被调用 ${modelCalls} 次`);
    const rounds = await page.evaluate<string[]>(
      `Array.from(document.querySelectorAll(".loop-round")).map(el => (el.textContent || "").trim())`,
    );
    const after = await canvasNodeCount(page);
    if (args.verbose) console.log(`轮次日志：${JSON.stringify(rounds, null, 2)}`);

    // ① 循环真的跑了几轮（演示规划器修不好问题，所以不会一轮就收敛）。
    expect(rounds.length >= 1, `轮次日志里应该有轮次记录，实际 ${rounds.length} 条`);
    expect(rounds.length <= 6, `轮次不应该超过上限 6，实际 ${rounds.length} 条`);

    // ② 每轮都真的落地了命令（落地数是提交成功之后才写的）。
    for (const [index, round] of rounds.entries()) {
      expect(/落地\s*\d+\s*条命令/.test(round), `第 ${index + 1} 轮没有显示落地命令数：${round}`);
    }

    // ③ 收尾说清楚了为什么停，而不是默默消失。
    // 停止原因有好几种：收敛 / 轮次上限 / 震荡 / 修不动（待修项没减少）/ 结构审查阻断 /
    // 审批未通过 / 用户取消 / 模型没给命令 / 调用失败。
    expect(/(收敛|轮次上限|震荡|阻断|审批|取消|没有给出|失败|没有进展|没有减少|修不动)/.test(summary), `收尾结论没有说明停止原因：${summary}`);

    // ④ 画布上的节点真的变多了——命令落到了文档里，不只是日志好看。
    expect(after > before, `画布节点数没有变（开跑前 ${before}，跑完 ${after}）`);
    expect(after - before === rounds.length, `每轮应当新增 1 个节点（演示规划器建卡片）：多出 ${after - before} 个，跑了 ${rounds.length} 轮`);
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error(`\n编排循环探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n编排循环探针通过：按钮接好了，轮次日志逐轮显示落地命令，画布节点真的变多，最后如实说明了停止原因。");
}

// 只在直接运行这个脚本时执行；测试会 import 本模块里的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
