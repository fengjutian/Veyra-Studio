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
  root.appearance.fill = "#000000";
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
