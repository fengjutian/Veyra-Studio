/**
 * 跨平台字体度量基线。
 *
 *   npm run visual:font:baseline        # 采集当前机器的度量并写入基线
 *   npm run visual:font:check            # 与基线比较，超容差即失败
 *   npm run visual:font:check -- --require-browser
 *
 * 流程：esbuild 打包 harness → Chrome/Edge headless 抓 DOM → 页面里的
 * `createBrowserTextMeasurer()` 量一遍固定样例 → 与基线比较。
 *
 * 基线**绑定平台**：文件里记着系统、浏览器与采样时间。换台机器跑 check 会有
 * 差异，这时输出会先说清「基线来自哪个平台、当前是哪个平台」，再报差异——
 * 让人能判断这是预期的平台差异还是真的漂移。
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compareFontBaseline, describeEnvironmentDifference, type FontBaseline, type FontBaselineEnvironment } from "@ufira/design-layout";
import { findBrowser } from "../../design-export/visual/browser";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const BASELINE = join(here, "font-metrics.json");
const PAGE = join(here, ".cache", "font-baseline.html");
const REPORT_ID = "font-baseline-report";

interface Args {
  update: boolean;
  requireBrowser: boolean;
  widthTolerance?: number;
  browserPath?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string) => argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    update: argv.includes("--update"),
    requireBrowser: argv.includes("--require-browser"),
    widthTolerance: value("--width-tolerance=") === undefined ? undefined : Number(value("--width-tolerance=")),
    browserPath: value("--browser="),
  };
}

/** 打包 harness 并生成一个内联脚本的 HTML 页面。 */
async function buildPage(): Promise<string> {
  const result = await build({
    entryPoints: [join(root, "packages", "studio-web", "harness", "font-baseline.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "silent",
  });
  const js = result.outputFiles[0]?.text ?? "";
  const html = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><title>Font baseline</title>
<style>html,body{margin:0;padding:0;background:#fff}</style>
</head>
<body>
<script>${js.replace(/<\/script>/gi, "<\\/script>")}</script>
</body>
</html>`;
  mkdirSync(dirname(PAGE), { recursive: true });
  writeFileSync(PAGE, html, "utf8");
  return PAGE;
}

/** 用 headless 浏览器抓回页面渲染后的 DOM。 */
function dumpDom(htmlPath: string, browserPath?: string): Promise<string> {
  const browser = browserPath ?? findBrowser();
  if (!browser) return Promise.reject(new Error("找不到 Chrome/Edge；设置 CHROME_PATH 或传入 --browser"));
  const args = ["--headless=new", "--disable-gpu", "--virtual-time-budget=5000", "--dump-dom", `file:///${htmlPath.replace(/\\/g, "/")}`];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`浏览器抓取失败：${error.message}`));
      else resolve(stdout);
    });
  });
}

/** 从 DOM 里取出报告 JSON（内容是 textContent，HTML 实体要先还原）。 */
export function extractReport(dom: string): { userAgent?: string; platform?: string; cases: FontBaseline["cases"] } {
  const match = new RegExp(`<pre id="${REPORT_ID}">([\\s\\S]*?)</pre>`).exec(dom);
  if (!match) throw new Error("页面里没有字体基线报告（harness 没跑起来？）");
  const json = match[1]!
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return JSON.parse(json) as { userAgent?: string; platform?: string; cases: FontBaseline["cases"] };
}

/** 从 user agent 里取浏览器与版本。 */
export function parseBrowserVersion(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
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
  if (!findBrowser() && !args.browserPath) {
    const message = "未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）";
    if (args.requireBrowser) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(`${message}，跳过字体度量基线。`);
    }
    return;
  }

  const page = await buildPage();
  const dom = await dumpDom(page, args.browserPath);
  const report = extractReport(dom);
  const environment: FontBaselineEnvironment = {
    os: process.platform,
    osRelease: `${process.platform} ${release()}`,
    browser: parseBrowserVersion(report.userAgent),
    userAgent: report.userAgent,
    generatedAt: new Date().toISOString(),
  };
  const current: FontBaseline = { environment, cases: report.cases };

  // 数值必须有限：字体没加载好或行高缺失时，高度会算成 NaN。
  // 这样的基线写进去毫无意义（比较时 NaN 也「等于」NaN），必须在采集阶段就拒绝。
  const invalid = current.cases.filter(entry =>
    !Number.isFinite(entry.width) || !Number.isFinite(entry.height) || !Number.isFinite(entry.lines));
  if (invalid.length) {
    console.error(`测量结果非法（${invalid.map(entry => entry.id).join("、")}）：字体或行高没准备好，基线不可信。`);
    process.exitCode = 1;
    return;
  }

  if (args.update) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(`已更新字体度量基线：${BASELINE}（${current.environment.browser ?? "未知浏览器"} · ${current.environment.os}）`);
    return;
  }

  let baseline: FontBaseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as FontBaseline;
  } catch (error) {
    console.error(`读取字体度量基线失败：${error instanceof Error ? error.message : String(error)}；先运行 npm run visual:font:baseline`);
    process.exitCode = 1;
    return;
  }

  const environmentNote = describeEnvironmentDifference(baseline, current);
  if (environmentNote) {
    console.log(`平台不同（${environmentNote}）：基线来自 ${baseline.environment.browser ?? "未知浏览器"} / ${baseline.environment.os}，当前是 ${current.environment.browser ?? "未知浏览器"} / ${current.environment.os}。`);
  }

  const { diffs, missing } = compareFontBaseline(baseline, current, {
    ...(args.widthTolerance === undefined ? {} : { width: args.widthTolerance }),
  });
  for (const item of missing) console.log(`样例缺失：${item.id}（只在${item.where === "baseline" ? "基线" : "实测"}里）`);
  for (const diff of diffs) {
    const kind = diff.lineBreakChanged ? "换行点变了" : "宽度漂移";
    console.log(
      `${diff.id}：${kind}，宽度 ${diff.expectedWidth} → ${diff.actualWidth}（Δ${diff.widthDelta.toFixed(3)}），`
      + `高度 ${diff.expectedHeight} → ${diff.actualHeight}（行数 ${diff.expectedLines} → ${diff.actualLines}）`,
    );
  }
  if (diffs.length || missing.length) {
    console.error(
      `字体度量基线不一致：${diffs.length} 处差异、${missing.length} 处缺失。`
      + (environmentNote ? "平台不同可能是原因——确认后用 npm run visual:font:baseline 更新基线。" : "同一平台上出现差异说明度量漂移，需要排查。"),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`字体度量基线一致（${current.cases.length} 个样例，${current.environment.browser ?? "未知浏览器"} / ${current.environment.os}）。`);
}

// 只在直接运行这个脚本时采集。测试会 import 本模块里的纯函数——顶层就执行
// main() 会在测试导入时就去开浏览器，副作用直接炸掉整个测试文件。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
