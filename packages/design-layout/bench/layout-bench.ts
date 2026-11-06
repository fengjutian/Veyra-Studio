/**
 * 布局性能基线。
 *
 * 用法：
 *   npm run bench:layout
 *   npm run bench:layout -- --json
 *   npm run bench:layout -- --budget      # 超出预算时以非零码退出
 *
 * 生成的文档是合成的：普通文本节点 + 自动布局容器。它不代表真实设计，但能稳定
 * 反映"节点数翻倍时布局耗时怎么走"，用来在换渲染器或改测量缓存之前先拿到可比
 * 数字。预算取得很宽松，只用于发现数量级退化，不做微基准比较。
 */
import { pathToFileURL } from "node:url";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { computePageLayout } from "../src/index";

interface Case {
  requestedNodes: number;
  nodes: number;
  medianMs: number;
  p95Ms: number;
}

const SIZES = [200, 500, 1000, 2000, 5000];
const ITERATIONS: Record<number, number> = { 200: 30, 500: 20, 1000: 10, 2000: 5, 5000: 3 };
/** 每档预算（毫秒，中位数）。超出说明有数量级退化，而不是几毫秒的波动。 */
const BUDGET_MS: Record<number, number> = { 200: 250, 500: 600, 1000: 1500, 2000: 4000, 5000: 12000 };

function base(id: string, parentId: string, options: { x?: number; y?: number; width?: number; height?: number } = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 120, height: options.height ?? 80 },
    appearance: defaultAppearance(),
  };
}

function textNode(id: string, index: number, x: number, y: number): DesignNode {
  return {
    ...base(id, "page:1", { x, y }),
    type: "text",
    text: `节点 ${index} 的示例文字内容`,
    fontFamily: "Inter",
    fontSize: 14,
    lineHeight: 20,
  } as DesignNode;
}

/** 构造一份目标规模的合成文档；导出给性能 smoke 测试复用。 */
export function documentWithNodes(target: number): DesignDocument {
  const document: DesignDocument = {
    schemaVersion: 2,
    id: "doc:bench",
    revision: 0,
    meta: { name: "Bench", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    pageOrder: ["page:1"],
    pages: { "page:1": { id: "page:1", name: "Page 1", childIds: [] } },
    nodes: {},
    components: {},
    tokens: {},
    assets: {},
  };

  const columns = Math.ceil(Math.sqrt(target));
  const roots: string[] = [];
  let created = 0;
  let index = 0;

  while (created < target) {
    const x = (index % columns) * 130;
    const y = Math.floor(index / columns) * 100;
    const id = `node:${index}`;
    // 每五个根节点里放一个自动布局容器（容器 + 两个 fill 文本子节点）。
    if (index % 5 === 0) {
      const container: DesignNode = {
        ...base(id, "page:1", { x, y, width: 120, height: 80 }),
        layout: { ...defaultLayout(), mode: "stack", direction: "vertical", x, y, width: 120, height: 80, gap: 4, widthMode: "fixed", heightMode: "hug" },
      };
      const firstChildId = `${id}:a`;
      const secondChildId = `${id}:b`;
      container.childIds = [firstChildId, secondChildId];
      document.nodes[id] = container;
      for (const [childIndex, childId] of [firstChildId, secondChildId].entries()) {
        document.nodes[childId] = {
          ...textNode(childId, index, x, y + childIndex * 20),
          parentId: id,
          layout: { ...defaultLayout(), width: 110, height: 16, widthMode: "fill", heightMode: "hug" },
        };
      }
      roots.push(id);
      created += 3;
    } else {
      const text = textNode(`${id}:text`, index, x, y);
      document.nodes[text.id] = text;
      roots.push(text.id);
      created += 1;
    }
    index += 1;
  }

  document.pages["page:1"].childIds = roots;
  return document;
}

function measureOnce(document: DesignDocument): number {
  const started = process.hrtime.bigint();
  computePageLayout(document, "page:1", { viewport: { width: 960, height: 680 } });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
}

function run(requestedNodes: number): Case {
  const document = documentWithNodes(requestedNodes);
  const samples: number[] = [];
  for (let iteration = 0; iteration < (ITERATIONS[requestedNodes] ?? 5); iteration += 1) samples.push(measureOnce(document));
  return {
    requestedNodes,
    nodes: Object.keys(document.nodes).length,
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
  };
}

function main(): void {
  const json = process.argv.includes("--json");
  const enforceBudget = process.argv.includes("--budget");
  const cases = SIZES.map(run);
  const failures = cases.filter(item => enforceBudget && item.medianMs > (BUDGET_MS[item.requestedNodes] ?? Infinity));

  if (json) {
    console.log(JSON.stringify({ cases, budget: BUDGET_MS, failed: failures.map(item => item.requestedNodes) }, null, 2));
  } else {
    console.log("目标节点\t实际节点\t中位数(ms)\tp95(ms)\t预算(ms)");
    for (const item of cases) {
      console.log(`${item.requestedNodes}\t\t${item.nodes}\t\t${item.medianMs.toFixed(1)}\t\t${item.p95Ms.toFixed(1)}\t\t${BUDGET_MS[item.requestedNodes] ?? "-"}`);
    }
  }

  if (failures.length) {
    console.error(`超出预算：${failures.map(item => `${item.requestedNodes} 节点 ${item.medianMs.toFixed(1)}ms`).join("，")}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
