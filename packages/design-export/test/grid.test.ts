import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";
import { supportFor } from "../src/support";

/**
 * Grid 布局的导出用例。
 *
 * Grid 的语义对齐 Penpot，见 `docs/figma-gap-roadmap.md`。
 */

const PAGE_ID = "page:1";
const VIEWPORT = { width: 960, height: 680 };

function node(id: string, parentId: string, overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

function gridDocument(): DesignDocument {
  const document = createDocument("doc:grid", "Grid", PAGE_ID);
  const root = node("root", PAGE_ID);
  root.layout = {
    ...defaultLayout(),
    mode: "grid",
    width: 400,
    height: 200,
    grid: {
      columns: [{ type: "fixed", size: 100 }, { type: "fraction", weight: 1 }],
      rows: [{ type: "fixed", size: 60 }],
      columnGap: 10,
      rowGap: 0,
      cells: {
        first: { row: 1, column: 1 },
        second: { row: 1, column: 2 },
      },
    },
  };
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 40, height: 20 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 40, height: 20 };

  root.childIds = [first.id, second.id];
  document.pages[PAGE_ID]!.childIds = [root.id];
  document.nodes[root.id] = root;
  document.nodes[first.id] = first;
  document.nodes[second.id] = second;
  return document;
}

test("grid: HTML 导出输出 CSS Grid", () => {
  const result = exportPageToHtml(gridDocument(), { pageId: PAGE_ID, viewport: VIEWPORT });
  assert.match(result.html, /display:grid/);
  // 轨道：固定 100px + 比例 1fr。
  assert.match(result.html, /grid-template-columns:100px 1fr/);
  assert.match(result.html, /column-gap:10px/);
});

test("grid: HTML 导出把子节点放进指定格子", () => {
  const result = exportPageToHtml(gridDocument(), { pageId: PAGE_ID, viewport: VIEWPORT });
  assert.match(result.html, /grid-column:1 \/ span 1/);
  assert.match(result.html, /grid-column:2 \/ span 1/);
  assert.match(result.html, /grid-row:1 \/ span 1/);
});

test("grid: HTML 导出对 fraction 轨道输出 fr 单位", () => {
  const result = exportPageToHtml(gridDocument(), { pageId: PAGE_ID, viewport: VIEWPORT });
  assert.match(result.html, /1fr/);
});

test("grid: SVG 导出用布局引擎解出的绝对坐标", () => {
  const result = exportPageToSvg(gridDocument(), { pageId: PAGE_ID, viewport: VIEWPORT });
  // 第一列起点 x=0（容器在页面左上），第二列起点 x=100+gap10=110。
  assert.match(result.svg, /data-node-id="first"[\s\S]*?<rect x="0" y="0" width="40"/);
  assert.match(result.svg, /data-node-id="second"[\s\S]*?<rect x="110" y="0" width="40"/);
});

test("grid: 导出支持矩阵登记了 grid 特性", () => {
  assert.equal(supportFor("layout-grid", "html"), "exact");
  assert.equal(supportFor("layout-grid", "svg"), "exact");
  assert.equal(supportFor("layout-grid", "png"), "exact");
});

test("grid: 导出没有产生诊断", () => {
  const result = exportPageToHtml(gridDocument(), { pageId: PAGE_ID, viewport: VIEWPORT });
  assert.deepEqual(result.diagnostics, []);
});

/** 把根容器的定位方式换成命名区域。 */
function withAreas(areas: string[]): DesignDocument {
  const document = gridDocument();
  const root = document.nodes.root!;
  root.layout.grid = {
    ...root.layout.grid!,
    areas,
    cells: { first: { area: "first" }, second: { area: "second" } },
  };
  return document;
}

test("grid: 命名区域导出成 grid-template-areas 与 grid-area", () => {
  const html = exportPageToHtml(withAreas(["first second"]), { pageId: PAGE_ID, viewport: VIEWPORT }).html;
  // style 属性整体按 HTML 转义，引号在产物里是 &quot;，浏览器读到的仍是合法 CSS。
  assert.match(html, /grid-template-areas:&quot;first second&quot;/);
  // 用区域定位时不再写死行列号——否则改模板在导出物里不会生效。
  assert.match(html, /grid-area:first/);
  assert.match(html, /grid-area:second/);
  assert.doesNotMatch(html, /grid-column:1 \/ span 1/);
});

test("grid: 命名区域导出时空白被归一化，名字保持不变", () => {
  const html = exportPageToHtml(withAreas(["  first   second  "]), { pageId: PAGE_ID, viewport: VIEWPORT }).html;
  assert.match(html, /grid-template-areas:&quot;first second&quot;/);
});

test("grid: SVG 导出对命名区域的定位与行列号一致", () => {
  const svg = exportPageToSvg(withAreas(["first second"]), { pageId: PAGE_ID, viewport: VIEWPORT }).svg;
  assert.match(svg, /data-node-id="first"[\s\S]*?<rect x="0" y="0" width="40"/);
  assert.match(svg, /data-node-id="second"[\s\S]*?<rect x="110" y="0" width="40"/);
});

test("grid: 自动重复轨道导出成 CSS repeat()", () => {
  const document = gridDocument();
  document.nodes.root!.layout.grid = {
    columns: [{ type: "repeat", mode: "auto-fill", min: 120, grow: true }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 10,
    rowGap: 0,
  };
  const html = exportPageToHtml(document, { pageId: PAGE_ID, viewport: VIEWPORT }).html;
  // grow → minmax(min, 1fr)；条数交给浏览器按同一公式展开。
  assert.match(html, /grid-template-columns:repeat\(auto-fill, minmax\(120px, 1fr\)\)/);
});

test("grid: auto-fit 与固定最小宽度导出成对应的 CSS 写法", () => {
  const document = gridDocument();
  document.nodes.root!.layout.grid = {
    columns: [{ type: "repeat", mode: "auto-fit", min: 80 }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 0,
    rowGap: 0,
  };
  const html = exportPageToHtml(document, { pageId: PAGE_ID, viewport: VIEWPORT }).html;
  assert.match(html, /grid-template-columns:repeat\(auto-fit, 80px\)/);
});

test("grid: 自动重复轨道导出没有诊断", () => {
  const document = gridDocument();
  document.nodes.root!.layout.grid = {
    columns: [{ type: "repeat", mode: "auto-fill", min: 120, grow: true }],
    rows: [{ type: "fixed", size: 50 }],
    columnGap: 10,
    rowGap: 0,
  };
  const result = exportPageToHtml(document, { pageId: PAGE_ID, viewport: VIEWPORT });
  assert.deepEqual(result.diagnostics, []);
});
