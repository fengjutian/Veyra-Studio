import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

const PAGE_ID = "page:1";
const VIEWPORT = { width: 400, height: 300 };

function frame(id: string, parentId = PAGE_ID): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 100 }, appearance: defaultAppearance() };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo", PAGE_ID);
  document.pages[PAGE_ID]!.childIds = nodes.map(node => node.id);
  for (const node of nodes) document.nodes[node.id] = node;
  return document;
}

function html(nodes: DesignNode[]) {
  return exportPageToHtml(documentWith(nodes), { pageId: PAGE_ID, viewport: VIEWPORT });
}

function svg(nodes: DesignNode[]) {
  return exportPageToSvg(documentWith(nodes), { pageId: PAGE_ID, viewport: VIEWPORT });
}

test("混合模式在 HTML 导出里写成 mix-blend-mode", () => {
  const node = frame("card");
  node.appearance.blendMode = "multiply";
  const result = html([node]);
  assert.match(result.html, /mix-blend-mode:multiply/);
  // 页面里有混合模式时要隔离，否则会跟页面外的背景混在一起。
  assert.match(result.css, /isolation:isolate/);
});

test("normal 不写进 CSS，也不触发页面隔离", () => {
  const node = frame("card");
  node.appearance.blendMode = "normal";
  const result = html([node]);
  assert.doesNotMatch(result.html, /mix-blend-mode/);
  assert.doesNotMatch(result.css, /isolation:isolate/);
});

test("没有混合模式的旧文档导出产物逐字不变", () => {
  const node = frame("card");
  node.appearance.fills = [{ type: "solid", color: "#ffffff" }];
  const result = html([node]);
  assert.doesNotMatch(result.css, /isolation/);
  assert.doesNotMatch(result.html, /mix-blend-mode/);
});

test("混合模式在 SVG 导出里同样写成 mix-blend-mode", () => {
  const node = frame("card");
  node.appearance.blendMode = "screen";
  const result = svg([node]);
  assert.match(result.svg, /mix-blend-mode:screen/);
  assert.match(result.svg, /style="isolation:isolate"/);
});

test("椭圆渐变在 HTML 里是 radial-gradient(ellipse ...)", () => {
  const node = frame("card");
  node.appearance.fills = [{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }];
  const result = html([node]);
  // 盒子 200×100：横半轴 100px、纵半轴 25px。
  assert.match(result.html, /radial-gradient\(ellipse 100px 25px at 50% 50%/);
});

test("椭圆渐变在 SVG 里是带 gradientTransform 的 radialGradient", () => {
  const node = frame("card");
  node.appearance.fills = [{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.25, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }];
  const result = svg([node]);
  // 单位圆 + 缩放矩阵：中心 (100,50)，半轴 (100,25)。
  assert.match(result.svg, /<radialGradient[^>]*r="1"/);
  assert.match(result.svg, /gradientTransform="matrix\(100 0 0 25 100 50\)"/);
});

test("椭圆渐变在内联 svg 的矢量节点里同样带 gradientTransform", () => {
  const node = frame("vector");
  node.type = "vector";
  node.geometry = { kind: "path", d: "M 0 0 L 1 0 L 1 1 L 0 1 Z" };
  node.appearance.fills = [{ type: "elliptical", cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5, stops: [{ offset: 0, color: "#ffffff" }, { offset: 1, color: "#000000" }] }];
  const result = html([node]);
  assert.match(result.html, /gradientTransform="matrix\(/);
});

test("背景模糊在 HTML 里是 backdrop-filter", () => {
  const node = frame("glass");
  node.appearance.backgroundBlur = 8;
  const result = html([node]);
  assert.match(result.html, /backdrop-filter:blur\(8px\)/);
});

test("背景模糊在 SVG 里是背景副本 + 裁剪 + 模糊", () => {
  const backdrop = frame("backdrop");
  backdrop.appearance.fills = [{ type: "solid", color: "#ff0000" }];
  const glass = frame("glass");
  glass.appearance.backgroundBlur = 4;
  const result = svg([backdrop, glass]);
  // 裁剪 + 模糊各一份 defs；stdDeviation = 模糊半径 / 2。
  assert.match(result.svg, /<clipPath id="bgblur-clip-/);
  assert.match(result.svg, /<filter id="bgblur-[^"]+"[^>]*><feGaussianBlur stdDeviation="2" \/><\/filter>/);
  // 副本里要真的有背景节点的标记，否则等于没模糊。
  const layer = result.svg.slice(result.svg.indexOf('filter="url(#bgblur-'));
  assert.ok(layer.includes('data-node-id="backdrop"'), "背景副本里应包含前一个兄弟节点");
});

test("背景模糊是第一个兄弟时没有可模糊的背景，不产生空副本", () => {
  const glass = frame("glass");
  glass.appearance.backgroundBlur = 4;
  const result = svg([glass]);
  assert.doesNotMatch(result.svg, /bgblur-clip/);
});
