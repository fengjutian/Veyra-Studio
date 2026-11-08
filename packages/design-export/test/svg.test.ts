import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToSvg } from "../src/index";

function frame(id: string, parentId = "page:1"): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.pages["page:1"].childIds = nodes.map(node => node.id);
  for (const node of nodes) document.nodes[node.id] = node;
  return document;
}

/**
 * Builds a document whose top-level nodes are the given roots, keeping any
 * children referenced by `childIds` attached to their parent.
 */
function documentWithTree(roots: DesignNode[], children: DesignNode[] = []): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.pages["page:1"].childIds = roots.map(node => node.id);
  for (const node of [...roots, ...children]) document.nodes[node.id] = node;
  return document;
}

test("exports a page as an SVG document with the right viewport", () => {
  const root = frame("root");
  const result = exportPageToSvg(documentWith([root]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(result.svg, /width="800" height="600"/);
  assert.match(result.svg, /viewBox="0 0 800 600"/);
});

test("escapes XML special characters in text", () => {
  const text: DesignNode = { ...frame("text"), type: "text", text: '<script>alert("x")</script>', fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  const result = exportPageToSvg(documentWith([text]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /&lt;script&gt;/);
  assert.doesNotMatch(result.svg, /<script>/);
});

test("preserves token bindings as CSS variables", () => {
  const root = frame("root");
  root.appearance.fills = [{ type: "solid", color: "#000000" }];
  root.bindings = { fill: "Color/Primary" };
  const document = documentWith([root]);
  document.tokens["Color/Primary"] = { type: "color", value: "#3366ff" };
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.equal(result.tokenVariables["Color/Primary"], "--color-primary");
  assert.match(result.svg, /--color-primary: #3366ff/);
  assert.match(result.svg, /fill:var\(--color-primary\)/);
});

test("resolves stack layout geometry through the layout engine", () => {
  const root = frame("root");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 10, padding: { top: 8, right: 8, bottom: 8, left: 8 }, width: 200, height: 160 };
  const child = frame("child", "root");
  child.layout = { ...defaultLayout(), width: 50, height: 30 };
  root.childIds = [child.id];
  const result = exportPageToSvg(documentWithTree([root], [child]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  // The child is offset by the stack padding.
  assert.match(result.svg, /x="8" y="8"/);
});

test("rejects unsafe image URLs and reports the degradation", () => {
  const image: DesignNode = { ...frame("image"), type: "image", assetId: "asset:1", fit: "cover" };
  const document = documentWith([image]);
  document.assets["asset:1"] = { id: "asset:1", hash: "a".repeat(64), mimeType: "image/png", byteLength: 10 };
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 800, height: 600 }, resolveAsset: () => "javascript:alert(1)" });
  assert.doesNotMatch(result.svg, /javascript:/);
  assert.equal(result.diagnostics[0]?.support, "unsupported");
});

test("skips hidden nodes", () => {
  const root = frame("root");
  const hidden = frame("hidden", "root");
  hidden.visible = false;
  root.childIds = [hidden.id];
  const result = exportPageToSvg(documentWithTree([root], [hidden]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.doesNotMatch(result.svg, /data-node-id="hidden"/);
});

test("throws for a missing page", () => {
  assert.throws(() => exportPageToSvg(documentWith([]), { pageId: "page:missing", viewport: { width: 800, height: 600 } }), /does not exist/);
});

test("rejects a non-finite viewport", () => {
  assert.throws(() => exportPageToSvg(documentWith([]), { pageId: "page:1", viewport: { width: Number.NaN, height: 600 } }), /Viewport dimensions/);
});

test("exports the text style and the box alignment", () => {
  const text: DesignNode = { ...frame("text"), type: "text", text: "Hello", fontFamily: "Inter", fontSize: 16, lineHeight: 24, fontWeight: 700, fontStyle: "italic", letterSpacing: 2, textAlign: "center" };
  const result = exportPageToSvg(documentWith([text]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /font-weight:700/);
  assert.match(result.svg, /font-style:italic/);
  assert.match(result.svg, /letter-spacing:2/);
  assert.match(result.svg, /text-anchor="middle"/);
});

test("keeps left aligned text on the default anchor", () => {
  const text: DesignNode = { ...frame("text"), type: "text", text: "Hello", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  const result = exportPageToSvg(documentWith([text]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.doesNotMatch(result.svg, /text-anchor/);
  assert.doesNotMatch(result.svg, /font-weight/);
});

test("exports a vector node as an absolute path", () => {
  const vector: DesignNode = {
    ...frame("logo"),
    type: "vector",
    layout: { ...defaultLayout(), x: 100, y: 50, width: 200, height: 100 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#8b5cf6" }] },
    geometry: { kind: "path", d: "M 0 0 L 1 0 L 1 1 Z" },
  };
  const result = exportPageToSvg(documentWith([vector]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  // 归一化坐标在导出前换算成绝对坐标，和画布/命中共用同一套几何。
  assert.match(result.svg, /<path d="M 100 50 L 300 50 L 300 150 Z"/);
  assert.doesNotMatch(result.svg, /<rect[^>]*data-node-id="logo"/);
  assert.equal(result.diagnostics.length, 0);
});

test("a vector without geometry keeps the legacy unsupported diagnostic", () => {
  const vector: DesignNode = { ...frame("logo"), type: "vector" };
  const result = exportPageToSvg(documentWith([vector]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.equal(result.diagnostics[0]?.feature, "vector");
  assert.equal(result.diagnostics[0]?.support, "unsupported");
});

test("exports a non-default stroke width", () => {
  const root = frame("root");
  root.appearance.stroke = "#000000";
  root.appearance.strokeWidth = 4;
  const result = exportPageToSvg(documentWith([root]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /stroke-width:4/);
});
test("exports per-corner radii as a path with arcs", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    layout: { ...defaultLayout(), x: 100, y: 50, width: 200, height: 100 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ffffff" }], cornerRadii: [10, 20, 30, 40] },
  };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  // <rect rx> 只有单值，四角不同只能用路径；圆弧是导出产物，不是文档格式。
  assert.match(result.svg, /<path d="M 110 50 L 280 50 A 20 20 0 0 1 300 70/);
  assert.match(result.svg, /A 30 30 0 0 1 270 150/);
  assert.match(result.svg, /A 40 40 0 0 1 100 110/);
  assert.match(result.svg, /A 10 10 0 0 1 110 50 Z"/);
  assert.doesNotMatch(result.svg, /<rect[^>]*data-node-id="card"/);
});

test("a uniform cornerRadii keeps the rect output", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    appearance: { ...defaultAppearance(), cornerRadii: [8, 8, 8, 8] },
  };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /<rect[^>]*rx="8"/);
  assert.doesNotMatch(result.svg, /<path/);
});
test("exports a mask as a clipPath and hides the mask shape itself", () => {
  const mask: DesignNode = {
    ...frame("mask"),
    type: "ellipse",
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    mask: true,
  };
  const photo: DesignNode = { ...frame("photo"), type: "rectangle", layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 100 } };
  const result = exportPageToSvg(documentWith([mask, photo]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /<clipPath id="mask-1" clipPathUnits="userSpaceOnUse">/);
  assert.match(result.svg, /<g clip-path="url\(#mask-1\)">/);
  // 蒙版自身不渲染成图形。
  assert.doesNotMatch(result.svg, /data-node-id="mask"/);
});
test("exports rotation as a transform around the node center", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    layout: { ...defaultLayout(), x: 100, y: 50, width: 200, height: 100, rotation: 30 },
  };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /transform="rotate\(30 200 100\)"/);
});

test("keeps the element untouched when rotation is absent", () => {
  const box: DesignNode = { ...frame("card"), type: "rectangle" };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.doesNotMatch(result.svg, /transform=/);
});
test("exports shadow and blur as a filter", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    appearance: { ...defaultAppearance(), shadow: { x: 4, y: 8, blur: 12, color: "#00000080" }, blur: 6 },
  };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /<filter id="effect-1"/);
  // stdDeviation 是 CSS 模糊半径的一半。
  assert.match(result.svg, /<feGaussianBlur stdDeviation="3" \/>/);
  assert.match(result.svg, /<feDropShadow dx="4" dy="8" stdDeviation="6" flood-color="#00000080" \/>/);
  assert.match(result.svg, /filter="url\(#effect-1\)"/);
});
test("exports a linear gradient as defs and a paint reference", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    appearance: { ...defaultAppearance(), fills: [{ type: "linear", angle: 90, stops: [{ offset: 0, color: "#111111" }, { offset: 1, color: "#ffffff" }] }] },
  };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /<linearGradient id="paint-1" gradientUnits="userSpaceOnUse"/);
  assert.match(result.svg, /<stop offset="0" stop-color="#111111" \/>/);
  assert.match(result.svg, /fill:url\(#paint-1\)/);
});
test("exports every fill layer as its own shape", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ff0000" }, { type: "solid", color: "#00ff00" }] },
  };
  const result = exportPageToSvg(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  // 底层先画，上层后画：两个独立的 rect，各自带 fill。
  assert.match(result.svg, /<rect [^>]*fill="#ff0000"/);
  assert.match(result.svg, /<rect [^>]*fill="#00ff00"/);
});