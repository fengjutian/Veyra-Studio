import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml } from "../src/index";

function frame(id: string, parentId = "page:1"): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
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
