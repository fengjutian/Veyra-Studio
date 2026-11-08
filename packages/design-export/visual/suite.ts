/**
 * 视觉回归 suite：manifest 驱动的多用例比对 + HTML 报告。
 *
 *   npm run visual:suite:baseline   # 重新生成所有基线（明确执行才会覆盖）
 *   npm run visual:suite:check      # 渲染并与基线比较，任一用例超阈值退出 1
 *   npm run visual:suite:check -- --manifest=path/to/suite.json --require-browser
 *
 * 为什么要有 suite：单个 fixture 只能证明"这一张图没变"。desigma-diff 的
 * `suite` 子命令把多个 fixture 收进一个 manifest，跑完出一份 HTML 报告，
 * 于是"这次改动影响了哪几张图"一眼可见，而不是靠人肉翻 CI 日志。
 *
 * manifest 格式（JSON）：
 * ```json
 * {
 *   "cases": [
 *     {
 *       "name": "export-page",
 *       "html": "packages/design-export/test/golden/page.html",
 *       "baseline": "packages/design-export/test/golden/page.png",
 *       "width": 960,
 *       "height": 680,
 *       "threshold": 0.005,
 *       "tolerance": 0,
 *       "ignoreAntiAlias": true,
 *       "ignoreRegions": [{ "x": 0, "y": 0, "width": 100, "height": 40 }]
 *     }
 *   ]
 * }
 * ```
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, renderHtmlToPng } from "./browser";
import { decodePng, diffImages, encodePng, type IgnoreRegion } from "./png";

const here = dirname(fileURLToPath(import.meta.url));
/** 默认 manifest：仓库根的 visual-suite.json。 */
const DEFAULT_MANIFEST = join(here, "..", "..", "..", "visual-suite.json");
/** 默认报告输出目录（绝对路径锚到仓库根，避免相对路径随工作目录漂移）。 */
const DEFAULT_REPORT_DIR = join(here, "..", "..", "..", ".artifacts", "visual-suite");

export interface SuiteCase {
  /** 用例名，出现在报告里，必须唯一。 */
  name: string;
  /** 待渲染的 HTML（相对 manifest 所在目录）。 */
  html: string;
  /** 基线 PNG（相对 manifest 所在目录）。 */
  baseline: string;
  /** 差异图输出（相对 manifest 所在目录）。省略则写到报告目录。 */
  diff?: string;
  width?: number;
  height?: number;
  /** 允许的差异像素占比（0–1）。 */
  threshold?: number;
  /** 单通道允许差值。 */
  tolerance?: number;
  /** 是否豁免抗锯齿边缘像素，默认 true。 */
  ignoreAntiAlias?: boolean;
  /** 完全忽略的区域（CSS 像素坐标）。 */
  ignoreRegions?: IgnoreRegion[];
}

export interface SuiteManifest {
  cases: SuiteCase[];
}

export interface CaseResult {
  name: string;
  status: "passed" | "failed" | "error" | "updated";
  detail: string;
  ratio: number;
  differentPixels: number;
  antiAliasedPixels: number;
  ignoredPixels: number;
  totalPixels: number;
  /** 差异图路径（相对报告目录），没有则为空。 */
  diffFile?: string;
}

export interface SuiteResult {
  results: CaseResult[];
  passed: number;
  failed: number;
  errored: number;
}

interface Args {
  update: boolean;
  requireBrowser: boolean;
  manifestPath: string;
  reportDir: string;
  browserPath?: string;
}

function parseArgs(argv: string[]): Args {
  const value = (prefix: string): string | undefined =>
    argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return {
    update: argv.includes("--update"),
    requireBrowser: argv.includes("--require-browser"),
    manifestPath: value("--manifest=") ?? DEFAULT_MANIFEST,
    reportDir: value("--report=") ?? DEFAULT_REPORT_DIR,
    browserPath: value("--browser="),
  };
}

/** 相对 manifest 所在目录解析路径；已经是绝对路径的原样返回。 */
function resolveAgainst(base: string, target: string): string {
  return isAbsolute(target) ? target : resolve(base, target);
}

function parseManifest(content: string): SuiteManifest {
  const parsed = JSON.parse(content) as SuiteManifest;
  if (!parsed || !Array.isArray(parsed.cases)) {
    throw new Error("manifest 必须包含 cases 数组");
  }
  const names = new Set<string>();
  for (const testCase of parsed.cases) {
    if (!testCase?.name) throw new Error("每个用例都必须有 name");
    if (names.has(testCase.name)) throw new Error(`用例名重复：${testCase.name}`);
    names.add(testCase.name);
    if (!testCase.html) throw new Error(`用例 ${testCase.name} 缺少 html`);
    if (!testCase.baseline) throw new Error(`用例 ${testCase.name} 缺少 baseline`);
  }
  return parsed;
}

/**
 * 跑一个用例。返回结果而不抛异常——单个用例失败不应中断整批，
 * 否则报告里就只剩第一个坏掉的用例，看不出全貌。
 */
async function runCase(
  testCase: SuiteCase,
  baseDir: string,
  reportDir: string,
  options: { update: boolean; browserPath?: string },
): Promise<CaseResult> {
  const htmlPath = resolveAgainst(baseDir, testCase.html);
  const baselinePath = resolveAgainst(baseDir, testCase.baseline);
  const diffPath = testCase.diff
    ? resolveAgainst(baseDir, testCase.diff)
    : join(reportDir, `${testCase.name}.diff.png`);
  const width = testCase.width ?? 960;
  const height = testCase.height ?? 680;

  const empty: CaseResult = {
    name: testCase.name,
    status: "error",
    detail: "",
    ratio: 0,
    differentPixels: 0,
    antiAliasedPixels: 0,
    ignoredPixels: 0,
    totalPixels: 0,
  };

  if (!existsSync(htmlPath)) {
    return { ...empty, detail: `找不到 HTML：${htmlPath}` };
  }

  mkdirSync(dirname(diffPath), { recursive: true });
  const renderedPath = join(reportDir, `${testCase.name}.rendered.png`);
  mkdirSync(dirname(renderedPath), { recursive: true });

  try {
    await renderHtmlToPng({ htmlPath, outPath: renderedPath, width, height, browserPath: options.browserPath });
  } catch (error) {
    return { ...empty, detail: `渲染失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const rendered = decodePng(readFileSync(renderedPath));

  if (options.update) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, encodePng(rendered));
    return { ...empty, status: "updated", detail: `已更新基线：${baselinePath}` };
  }

  if (!existsSync(baselinePath)) {
    return { ...empty, detail: `找不到基线：${baselinePath}；先运行 npm run visual:suite:baseline` };
  }

  let baseline: ReturnType<typeof decodePng>;
  try {
    baseline = decodePng(readFileSync(baselinePath));
  } catch (error) {
    return { ...empty, detail: `读取基线失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const diff = diffImages(baseline, rendered, {
    tolerance: testCase.tolerance ?? 0,
    ignoreAntiAlias: testCase.ignoreAntiAlias ?? true,
    ignoreRegions: testCase.ignoreRegions,
  });
  writeFileSync(diffPath, encodePng(diff.image));

  const threshold = testCase.threshold ?? 0.005;
  const passed = diff.ratio <= threshold;
  const diffFile = relative(reportDir, diffPath);
  const parts = [
    `差异 ${diff.differentPixels}/${diff.totalPixels}（${(diff.ratio * 100).toFixed(3)}%）`,
    `AA 豁免 ${diff.antiAliasedPixels}`,
    `忽略 ${diff.ignoredPixels}`,
    `阈值 ${(threshold * 100).toFixed(3)}%`,
  ];
  return {
    name: testCase.name,
    status: passed ? "passed" : "failed",
    detail: parts.join("，"),
    ratio: diff.ratio,
    differentPixels: diff.differentPixels,
    antiAliasedPixels: diff.antiAliasedPixels,
    ignoredPixels: diff.ignoredPixels,
    totalPixels: diff.totalPixels,
    diffFile,
  };
}

/** 生成 HTML 报告：一眼看清哪些用例挂了、差异长什么样。 */
export function renderReport(result: SuiteResult, title: string): string {
  const rows = result.results
    .map(item => {
      const status = item.status === "passed" ? "✅ 通过" : item.status === "failed" ? "❌ 失败" : item.status === "updated" ? "🔄 已更新" : "⚠️ 错误";
      const diff = item.diffFile ? `<td><img src="${item.diffFile}" alt="${item.name}" /></td>` : "<td>—</td>";
      return `<tr class="${item.status}">
  <td><strong>${item.name}</strong><div class="detail">${item.detail}</div></td>
  <td>${status}</td>
  <td>${(item.ratio * 100).toFixed(3)}%</td>
  ${diff}
</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font: 14px/1.6 system-ui, sans-serif; margin: 24px; color: #1f2328; }
  h1 { font-size: 20px; }
  .summary { margin: 12px 0 20px; padding: 10px 14px; background: #f6f8fa; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; }
  td.detail, .detail { color: #57606a; font-size: 12px; }
  tr.failed { background: #fff8f8; }
  tr.error { background: #fffaf0; }
  img { max-width: 320px; border: 1px solid #d0d7de; }
</style>
<h1>${title}</h1>
<div class="summary">
  共 ${result.results.length} 个用例：通过 ${result.passed}，失败 ${result.failed}，错误 ${result.errored}。
</div>
<table>
<thead><tr><th>用例</th><th>结果</th><th>差异占比</th><th>差异图</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</html>
`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolveAgainst(process.cwd(), args.manifestPath);
  const reportDir = resolveAgainst(process.cwd(), args.reportDir);

  if (!findBrowser() && !args.update) {
    const message = "未找到 Chrome/Edge；设置 CHROME_PATH 后重试（或加 --require-browser 让 CI 明确失败）";
    if (args.requireBrowser) {
      console.error(message);
      process.exitCode = 1;
    } else {
      console.log(`${message}，跳过视觉 suite。`);
    }
    return;
  }

  let manifest: SuiteManifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`读取 manifest 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const baseDir = dirname(manifestPath);
  mkdirSync(reportDir, { recursive: true });

  const results: CaseResult[] = [];
  for (const testCase of manifest.cases) {
    const outcome = await runCase(testCase, baseDir, reportDir, {
      update: args.update,
      browserPath: args.browserPath,
    });
    results.push(outcome);
    const marker = outcome.status === "passed" ? "✅" : outcome.status === "failed" ? "❌" : outcome.status === "updated" ? "🔄" : "⚠️";
    console.log(`${marker} ${outcome.name}：${outcome.detail}`);
  }

  const summary: SuiteResult = {
    results,
    passed: results.filter(item => item.status === "passed").length,
    failed: results.filter(item => item.status === "failed").length,
    errored: results.filter(item => item.status === "error").length,
  };

  const reportPath = join(reportDir, "report.html");
  writeFileSync(reportPath, renderReport(summary, "视觉回归报告"));
  console.log(`报告：${reportPath}`);

  if (summary.failed > 0 || summary.errored > 0) {
    console.error(`视觉 suite 失败：${summary.failed} 个用例超阈值，${summary.errored} 个用例出错`);
    process.exitCode = 1;
  }
}

void main();
