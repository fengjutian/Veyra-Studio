/**
 * 浏览器内的画布绘制耗时。
 *
 *   npm run visual:canvas:paint
 *   npm run visual:canvas:paint -- --budget
 *
 * harness 在真实 Chrome 里测 200/1000/5000 节点的绘制耗时（完整场景 vs 视口裁剪后），
 * 把结果写进 `#harness-metrics`；这里用 Chrome `--dump-dom` 读回来。比 Node 里的假
 * 上下文更接近真实：包含 Canvas 命令提交与浏览器光栅化。
 */
import { execFile } from "node:child_process";
import { findBrowser } from "../../design-export/visual/browser";
import { buildHarness } from "./build-harness";

interface PaintMetrics {
  dpr: number;
  fixtureMs: number;
  sizes: Array<{ nodes: number; fullMs: number; culledMs: number; culledNodes: number }>;
}

const BUDGET_MS: Record<number, { full: number; culled: number }> = {
  200: { full: 60, culled: 40 },
  1000: { full: 120, culled: 60 },
  5000: { full: 500, culled: 120 },
};

function runBrowser(browser: string, url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--virtual-time-budget=6000", "--dump-dom", url], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`浏览器读取失败：${error.message}`));
      else resolve(stdout);
    });
  });
}

function extractMetrics(dom: string): PaintMetrics {
  const match = /<pre id="harness-metrics"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) {
    const error = /<pre id="harness-error"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
    throw new Error(`harness 没有输出指标${error ? `：${error[1]}` : ""}`);
  }
  return JSON.parse(match[1]!.replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")) as PaintMetrics;
}

async function main(): Promise<void> {
  const browser = findBrowser();
  if (!browser) {
    console.log("未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）。");
    if (process.argv.includes("--require-browser")) process.exitCode = 1;
    return;
  }

  const html = await buildHarness();
  const url = `file:///${html.replace(/\\/g, "/")}`;
  const metrics = extractMetrics(await runBrowser(browser, url));

  console.log(`fixture 绘制：${metrics.fixtureMs} ms（dpr ${metrics.dpr}）`);
  console.log("节点数\t完整(ms)\t裁剪(ms)\t裁剪后节点\t预算 完整/裁剪(ms)");
  const failures: string[] = [];
  for (const entry of metrics.sizes) {
    const budget = BUDGET_MS[entry.nodes];
    console.log(`${entry.nodes}\t${entry.fullMs}\t\t${entry.culledMs}\t\t${entry.culledNodes}\t\t${budget ? `${budget.full}/${budget.culled}` : "-"}`);
    if (budget && (entry.fullMs > budget.full || entry.culledMs > budget.culled)) failures.push(`${entry.nodes} 节点`);
  }

  if (process.argv.includes("--budget") && failures.length) {
    console.error(`画布绘制超预算：${failures.join("，")}`);
    process.exitCode = 1;
  }
}

void main();
