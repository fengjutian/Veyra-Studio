import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 外观与蒙版的新能力在导出端的落法。
 *
 * 三端语义必须一致：同一份文档在 HTML 与 SVG 里要表达同一件事；
 * 表达不了的（渐变文字、多层填充的文字）必须记诊断，而不是悄悄做一半。
 */

const PAGE_ID = "page:1";
const VIEWPORT = { width: 400, height: 300 };

function node(overrides: Partial<DesignNode> & { id: string }): DesignNode {
  return {
    type: "rectangle",
    name: overrides.id,
    parentId: PAGE_ID,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

/** 文本节点要补齐字体字段，否则文档校验过不去。 */
function textNode(id: string, fills?: DesignNode["appearance"]["fills"]): DesignNode {
  return node({
    id,
    type: "text",
    text: "标题",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 20,
    ...(fills ? { appearance: { ...defaultAppearance(), fills } } : {}),
  } as Partial<DesignNode> & { id: string }) as DesignNode;
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo", PAGE_ID);
  document.pages[PAGE_ID]!.childIds = nodes.map(item => item.id);
  for (const item of nodes) document.nodes[item.id] = item;
  return document;
}

function html(nodes: DesignNode[]) {
  return exportPageToHtml(documentWith(nodes), { pageId: PAGE_ID, viewport: VIEWPORT });
}

function svg(nodes: DesignNode[]) {
  return exportPageToSvg(documentWith(nodes), { pageId: PAGE_ID, viewport: VIEWPORT });
}

test("投影带扩散半径时 HTML 写成 box-shadow 的第 4 个值", () => {
  const card = node({ id: "card" });
  card.appearance.shadow = { x: 4, y: 8, blur: 12, color: "#00000080", spread: 6 };
  const result = html([card]);
  assert.match(result.html, /box-shadow:4px 8px 12px 6px #00000080/);
});

test("没有扩散半径的旧投影导出产物逐字不变", () => {
  const card = node({ id: "card" });
  card.appearance.shadow = { x: 4, y: 8, blur: 12, color: "#00000080" };
  const result = html([card]);
  assert.match(result.html, /box-shadow:4px 8px 12px #00000080/);
});

test("内阴影在 HTML 里是 box-shadow: inset", () => {
  const card = node({ id: "card" });
  card.appearance.shadow = { x: 0, y: 2, blur: 6, color: "#00000040", type: "inner" };
  const result = html([card]);
  assert.match(result.html, /box-shadow:inset 0px 2px 6px #00000040/);
});

test("带扩散半径的投影在 SVG 里用 feMorphology 膨胀", () => {
  const card = node({ id: "card" });
  card.appearance.shadow = { x: 4, y: 8, blur: 12, color: "#00000080", spread: 6 };
  const result = svg([card]);
  assert.match(result.svg, /<feMorphology in="SourceGraphic" operator="dilate" radius="6"/);
  assert.match(result.svg, /<feGaussianBlur in="shadow-dilated" stdDeviation="6"/);
  assert.match(result.svg, /<feOffset in="shadow-blurred" dx="4" dy="8"/);
  assert.match(result.svg, /flood-color="#00000080"/);
});

test("内阴影在 SVG 里用 SourceAlpha 与模糊偏移后的自身求差", () => {
  const card = node({ id: "card" });
  card.appearance.shadow = { x: 0, y: 2, blur: 6, color: "#00000040", type: "inner" };
  const result = svg([card]);
  assert.match(result.svg, /<feComposite in="SourceGraphic" in2="inner-offset" operator="out"/);
  assert.match(result.svg, /<feMerge><feMergeNode in="SourceGraphic" \/><feMergeNode in="inner-paint" \/><\/feMerge>/);
});

test("普通投影仍然走 feDropShadow（产物与升级前一致）", () => {
  const card = node({ id: "card" });
  card.appearance.shadow = { x: 4, y: 8, blur: 12, color: "#00000080" };
  const result = svg([card]);
  assert.match(result.svg, /<feDropShadow dx="4" dy="8" stdDeviation="6" flood-color="#00000080" \/>/);
});

test("文本节点在 HTML 里输出 color，而不是把填充当背景色", () => {
  const label = textNode("label", [{ type: "solid", color: "#ff0000" }]);
  const result = html([label]);
  assert.match(result.html, /color:#ff0000/);
  assert.doesNotMatch(result.html, /background:#ff0000/);
});

test("没有填充的文本用默认文字色（与画布一致，不再是 fill:none）", () => {
  const label = textNode("label");
  const htmlResult = html([label]);
  assert.match(htmlResult.html, /color:#111111/);
  const svgResult = svg([label]);
  assert.match(svgResult.svg, /fill:#111111/);
});

test("多层填充的文本按第一层上色，并记一条近似诊断", () => {
  const label = textNode("label", [{ type: "solid", color: "#ff0000" }, { type: "solid", color: "#00ff00" }]);
  const svgResult = svg([label]);
  assert.match(svgResult.svg, /fill:#ff0000/);
  const diagnostic = svgResult.diagnostics.find(item => item.feature === "text-fill-multi");
  assert.ok(diagnostic, "应给出多层填充的近似诊断");
  assert.equal(diagnostic.support, "approximated");
  const htmlResult = html([label]);
  assert.match(htmlResult.html, /color:#ff0000/);
  assert.ok(htmlResult.diagnostics.some(item => item.feature === "text-fill-multi"));
});

test("渐变文字在 HTML 里退化成首个色标，并记一条近似诊断", () => {
  const label = textNode("label", [{ type: "linear", angle: 0, stops: [{ offset: 0, color: "#123456" }, { offset: 1, color: "#654321" }] }]);
  const result = html([label]);
  assert.match(result.html, /color:#123456/);
  assert.ok(result.diagnostics.some(item => item.feature === "text-fill-gradient"));
});

test("圆角矩形的蒙版在 HTML 里也带圆角（与画布、SVG 对齐）", () => {
  const mask = node({ id: "mask", type: "rectangle", mask: true });
  mask.appearance.cornerRadius = 12;
  const photo = node({ id: "photo" });
  const result = html([mask, photo]);
  // 硬蒙版仍走 clip-path，但路径里要有圆角（用三次贝塞尔表达）。
  assert.match(result.html, /clip-path:path\('M 12 0 L/);
  assert.match(result.html, /C /);
});

test("半透明蒙版在 SVG 里用 <mask>，不再是硬裁剪", () => {
  const mask = node({ id: "mask", type: "ellipse", mask: true });
  mask.appearance.fills = [{ type: "solid", color: "#00000080" }];
  const photo = node({ id: "photo" });
  const result = svg([mask, photo]);
  assert.match(result.svg, /<mask id="mask-\d+"[^>]*>/);
  assert.match(result.svg, /fill-opacity="0\.50/);
  assert.match(result.svg, /mask="url\(#mask-\d+\)"/);
});

test("带羽化的蒙版在 SVG 里用 <mask> + feGaussianBlur", () => {
  const mask = node({ id: "mask", type: "ellipse", mask: true });
  (mask as DesignNode & { maskFeather?: number }).maskFeather = 8;
  const photo = node({ id: "photo" });
  const result = svg([mask, photo]);
  assert.match(result.svg, /<feGaussianBlur stdDeviation="4" \/>/);
  assert.match(result.svg, /filter="url\(#mask-\d+-blur\)"/);
});

test("半透明蒙版在 HTML 里用 mask-image（内联 SVG 遮罩）", () => {
  const mask = node({ id: "mask", type: "ellipse", mask: true });
  mask.appearance.fills = [{ type: "solid", color: "#00000080" }];
  const photo = node({ id: "photo" });
  const result = html([mask, photo]);
  assert.match(result.html, /mask-image:url\(data:image\/svg\+xml,/);
  assert.doesNotMatch(result.html, /clip-path:path\(/);
});

test("硬蒙版在 HTML 里仍然走 clip-path（产物与升级前一致）", () => {
  const mask = node({ id: "mask", type: "ellipse", mask: true });
  const photo = node({ id: "photo" });
  const result = html([mask, photo]);
  assert.match(result.html, /clip-path:path\(/);
  assert.doesNotMatch(result.html, /mask-image:/);
});
