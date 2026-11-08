import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

function documentWithText(overrides: Partial<DesignNode> = {}): DesignDocument {
  const document = createDocument("doc:rich", "富文本");
  const node = {
    id: "text:1",
    type: "text",
    name: "text:1",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 10, width: 200, height: 40 },
    appearance: defaultAppearance(),
    text: "abcdef",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...overrides,
  } as DesignNode;
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

const VIEWPORT = { width: 400, height: 200 };

test("HTML wraps styled runs in spans and leaves plain text untouched", () => {
  const plain = exportPageToHtml(documentWithText(), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(plain.html, /<p [^>]*>abcdef<\/p>/);
  assert.doesNotMatch(plain.html, /<span/);

  const rich = exportPageToHtml(documentWithText({
    runs: [
      { from: 0, to: 2, style: { fontWeight: 700 } },
      { from: 3, to: 4, style: { color: "#ef4444" } },
      { from: 4, to: 6, style: { fontStyle: "italic" } },
    ],
  }), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(rich.html, /<span style="font-weight:700">ab<\/span>c<span style="color:#ef4444">d<\/span><span style="font-style:italic">ef<\/span>/);
});

test("SVG wraps styled runs in tspans", () => {
  const plain = exportPageToSvg(documentWithText(), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(plain.svg, />abcdef<\/text>/);
  assert.doesNotMatch(plain.svg, /<tspan/);

  const rich = exportPageToSvg(documentWithText({
    runs: [
      { from: 0, to: 2, style: { fontWeight: 700 } },
      { from: 3, to: 4, style: { color: "#ef4444" } },
    ],
  }), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(rich.svg, /<tspan font-weight="700">ab<\/tspan>c<tspan fill="#ef4444">d<\/tspan>ef/);
});

test("escapes rich text content before wrapping it", () => {
  const result = exportPageToHtml(documentWithText({
    text: "<b>ab</b>",
    runs: [{ from: 3, to: 5, style: { fontWeight: 700 } }],
  }), { pageId: "page:1", viewport: VIEWPORT });
  assert.match(result.html, /&lt;b&gt;<span style="font-weight:700">ab<\/span>&lt;\/b&gt;/);
});
