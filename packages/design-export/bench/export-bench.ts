/**
 * 导出的规模基线。
 *
 *   npm run bench:export
 *   npm run bench:export -- --budget
 *
 * 和布局基线共用同一份合成文档，测 HTML 与 SVG 交付物在 1000 / 5000 节点下的
 * 生成耗时。预算同样只拦数量级退化。
 */
import { documentWithNodes } from "../../design-layout/bench/layout-bench";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

interface Case {
  requestedNodes: number;
  nodes: number;
  htmlMs: number;
  svgMs: number;
}

const SIZES = [1000, 5000];
const ITERATIONS: Record<number, number> = { 1000: 5, 5000: 2 };
const BUDGET_MS: Record<number, { html: number; svg: number }> = {
  1000: { html: 1500, svg: 3000 },
  5000: { html: 6000, svg: 12000 },
};

function time(run: () => unknown): number {
  const started = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function run(size: number): Case {
  const document = documentWithNodes(size);
  const iterations = ITERATIONS[size] ?? 2;
  const htmlSamples: number[] = [];
  const svgSamples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    htmlSamples.push(time(() => exportPageToHtml(document, { pageId: "page:1", viewport: { width: 960, height: 680 } })));
    svgSamples.push(time(() => exportPageToSvg(document, { pageId: "page:1", viewport: { width: 960, height: 680 } })));
  }
  return {
    requestedNodes: size,
    nodes: Object.keys(document.nodes).length,
    htmlMs: Math.min(...htmlSamples),
    svgMs: Math.min(...svgSamples),
  };
}

const cases = SIZES.map(run);
const enforceBudget = process.argv.includes("--budget");
const json = process.argv.includes("--json");
const failures = cases.filter(item => {
  const budget = BUDGET_MS[item.requestedNodes];
  return budget ? item.htmlMs > budget.html || item.svgMs > budget.svg : false;
});

if (json) {
  console.log(JSON.stringify({ cases, budget: BUDGET_MS, failed: failures.map(item => item.requestedNodes) }, null, 2));
} else {
  console.log("目标节点\t实际节点\tHTML(ms)\tSVG(ms)\t预算 HTML/SVG(ms)");
  for (const item of cases) {
    const budget = BUDGET_MS[item.requestedNodes];
    console.log(`${item.requestedNodes}\t\t${item.nodes}\t\t${item.htmlMs.toFixed(1)}\t\t${item.svgMs.toFixed(1)}\t\t${budget ? `${budget.html}/${budget.svg}` : "-"}`);
  }
}

if (enforceBudget && failures.length) {
  console.error(`导出超预算：${failures.map(item => `${item.requestedNodes} 节点`).join("，")}`);
  process.exitCode = 1;
}
