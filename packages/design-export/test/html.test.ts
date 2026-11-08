import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml } from "../src/index";

function frame(id: string, parentId = "page:1"): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.pages["page:1"].childIds = nodes.map(node => node.id);
  for (const node of nodes) document.nodes[node.id] = node;
  return document;
}

test("exports escaped text inside a structural stack", () => {
  const document = createDocument("doc:1", "Demo");
  const root = frame("root");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 12, padding: { top: 8, right: 8, bottom: 8, left: 8 } };
  const text: DesignNode = { ...frame("text", root.id), type: "text", text: "<script>alert(1)</script>", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  root.childIds = [text.id];
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  document.nodes[text.id] = text;
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.document, /display:flex/);
  assert.match(result.document, /flex-direction:column/);
  assert.match(result.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(result.html, /<script>alert/);
});

test("preserves design token bindings as CSS variables", () => {
  const document = createDocument("doc:1", "Demo");
  const root = frame("root");
  root.appearance.fill = "#000000";
  root.bindings = { fill: "Color/Primary" };
  document.tokens["Color/Primary"] = { type: "color", value: "#3366ff" };
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.equal(result.tokenVariables["Color/Primary"], "--color-primary");
  assert.match(result.css, /--color-primary: #3366ff/);
  assert.match(result.html, /background:var\(--color-primary\)/);
});

test("rejects unsafe image URLs and reports the degradation", () => {
  const document = createDocument("doc:1", "Demo");
  const image: DesignNode = { ...frame("image"), type: "image", assetId: "asset:1", fit: "cover" };
  document.assets["asset:1"] = { id: "asset:1", hash: "a".repeat(64), mimeType: "image/png", byteLength: 10 };
  document.pages["page:1"].childIds = [image.id];
  document.nodes[image.id] = image;
  const result = exportPageToHtml(document, {
    pageId: "page:1",
    viewport: { width: 800, height: 600 },
    resolveAsset: () => "javascript:alert(1)",
  });
  assert.doesNotMatch(result.html, /javascript:/);
  assert.equal(result.diagnostics[0].support, "unsupported");
});

test("reports unsupported vectors and approximated instances", () => {
  const document = createDocument("doc:1", "Demo");
  const component = frame("component");
  component.type = "component";
  const vector = frame("vector");
  vector.type = "vector";
  const instance: DesignNode = { ...frame("instance"), type: "instance", componentId: "button", overrides: {} };
  document.components.button = { id: "button", name: "Button", rootNodeId: component.id };
  document.pages["page:1"].childIds = [component.id, vector.id, instance.id];
  document.nodes[component.id] = component;
  document.nodes[vector.id] = vector;
  document.nodes[instance.id] = instance;
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.deepEqual(result.diagnostics.map(item => item.support).sort(), ["approximated", "unsupported"]);
});

test("exports the text style as CSS", () => {
  const document = createDocument("doc:1", "Demo");
  const text: DesignNode = { ...frame("text"), type: "text", text: "Hello", fontFamily: "Inter", fontSize: 16, lineHeight: 24, fontWeight: 700, fontStyle: "italic", textAlign: "center", letterSpacing: 2 };
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /font-weight:700/);
  assert.match(result.html, /font-style:italic/);
  assert.match(result.html, /text-align:center/);
  assert.match(result.html, /letter-spacing:2px/);
});

test("keeps the default text style out of the exported CSS", () => {
  const document = createDocument("doc:1", "Demo");
  const text: DesignNode = { ...frame("text"), type: "text", text: "Hello", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.doesNotMatch(result.html, /font-weight/);
  assert.doesNotMatch(result.html, /font-style/);
  assert.doesNotMatch(result.html, /text-align/);
  assert.doesNotMatch(result.html, /letter-spacing/);
});

test("exports a vector node as an inline svg path", () => {
  const vector: DesignNode = {
    ...frame("logo"),
    type: "vector",
    layout: { ...defaultLayout(), x: 20, y: 30, width: 100, height: 50 },
    appearance: { ...defaultAppearance(), fill: "#8b5cf6", stroke: "#111111", strokeWidth: 2 },
    geometry: { kind: "path", d: "M 0 0 L 1 0 L 0.5 1 Z" },
  };
  const result = exportPageToHtml(documentWith([vector]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /<svg viewBox="0 0 100 50"/);
  assert.match(result.html, /<path d="M 0 0 L 100 0 L 50 50 Z" fill="#8b5cf6" stroke="#111111" stroke-width="2"/);
  // 矢量节点自己画路径，外层 div 不能再铺一块背景矩形。
  assert.doesNotMatch(result.html, /design-vector[^>]*background:/);
  assert.equal(result.diagnostics.length, 0);
});

test("exports a non-default border width for shapes", () => {
  const root = frame("root");
  root.appearance.stroke = "#000000";
  root.appearance.strokeWidth = 3;
  const result = exportPageToHtml(documentWith([root]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /border:3px solid #000000/);
});
test("exports per-corner radii as a four-value border-radius", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    appearance: { ...defaultAppearance(), cornerRadii: [10, 20, 30, 40] },
  };
  const result = exportPageToHtml(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  // CSS 顺序：左上 右上 右下 左下，与模型里的一致。
  assert.match(result.html, /border-radius:10px 20px 30px 40px/);
});

test("a uniform cornerRadii keeps the single-value border-radius", () => {
  const box: DesignNode = { ...frame("card"), type: "rectangle", appearance: { ...defaultAppearance(), cornerRadii: [8, 8, 8, 8] } };
  const result = exportPageToHtml(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /border-radius:8px/);
  assert.doesNotMatch(result.html, /border-radius:8px 8px/);
});
test("exports a mask as a css clip-path wrapper", () => {
  const mask: DesignNode = {
    ...frame("mask"),
    type: "ellipse",
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    mask: true,
  };
  const photo: DesignNode = { ...frame("photo"), type: "rectangle", layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 100 } };
  const result = exportPageToHtml(documentWith([mask, photo]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /clip-path:path\('M /);
  // 蒙版自身不渲染。
  assert.doesNotMatch(result.html, /data-node-id="mask"/);
});
test("exports rotation as a css transform", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    layout: { ...defaultLayout(), x: 100, y: 50, width: 200, height: 100, rotation: -45 },
  };
  const result = exportPageToHtml(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /transform:rotate\(-45deg\)/);
});
test("exports shadow and blur as css", () => {
  const box: DesignNode = {
    ...frame("card"),
    type: "rectangle",
    appearance: { ...defaultAppearance(), shadow: { x: 4, y: 8, blur: 12, color: "#00000080" }, blur: 6 },
  };
  const result = exportPageToHtml(documentWith([box]), { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.html, /box-shadow:4px 8px 12px #00000080/);
  assert.match(result.html, /filter:blur\(6px\)/);
});