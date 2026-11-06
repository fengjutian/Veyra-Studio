import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { computePageLayout, createEstimateTextMeasurer, createHostTextMeasurer, wrapTextLines, type TextMeasurementRequest } from "../src/index";

function textNode(id: string, parentId: string, text: string, overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text,
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...overrides,
  } as DesignNode;
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Text");
  document.pages["page:1"].childIds = nodes.map(node => node.id);
  for (const node of nodes) document.nodes[node.id] = node;
  return document;
}

test("estimator wraps CJK text at the available width", () => {
  const lines = wrapTextLines("你好世界", 16, 32);
  assert.equal(lines.length, 2);
  assert.equal(lines.join(""), "你好世界");
});

test("estimator treats latin text as narrower than CJK", () => {
  // 20px fits two latin glyphs (2 * 0.55 * 16 = 17.6) but not two CJK glyphs (2 * 1 * 16 = 32).
  assert.equal(wrapTextLines("ab", 16, 20).length, 1);
  assert.equal(wrapTextLines("你好", 16, 20).length, 2);
});

test("estimator honours explicit newlines", () => {
  const lines = wrapTextLines("a\nb\nc", 16);
  assert.deepEqual(lines, ["a", "b", "c"]);
});

test("estimator measures hugging text height from wrapped lines", () => {
  const measurer = createEstimateTextMeasurer();
  const node = textNode("text", "page:1", "你好世界");
  node.layout = { ...defaultLayout(), widthMode: "hug", heightMode: "hug" };
  const result = computePageLayout(documentWith([node]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.text.height, 24);
});

test("fixed width text hugs its height using the wrapped line count", () => {
  const measurer = createEstimateTextMeasurer();
  const node = textNode("text", "page:1", "你好世界");
  node.layout = { ...defaultLayout(), width: 32, heightMode: "hug" };
  const result = computePageLayout(documentWith([node]), "page:1", { viewport: { width: 800, height: 600 }, textMeasurer: measurer });
  assert.equal(result.boxes.text.height, 48);
  assert.equal(result.boxes.text.width, 32);
});

test("injected measurer controls the resolved text box", () => {
  const node = textNode("text", "page:1", "Hello");
  node.layout = { ...defaultLayout(), widthMode: "hug", heightMode: "hug" };
  const result = computePageLayout(documentWith([node]), "page:1", {
    viewport: { width: 800, height: 600 },
    textMeasurer: createHostTextMeasurer(() => ({ width: 42, height: 24 })),
  });
  assert.deepEqual(result.boxes.text, { x: 0, y: 0, width: 42, height: 24 });
});

test("host measurer receives font and width constraints", () => {
  const requests: TextMeasurementRequest[] = [];
  const node = textNode("text", "page:1", "Hello");
  node.layout = { ...defaultLayout(), width: 100, heightMode: "hug" };
  computePageLayout(documentWith([node]), "page:1", {
    viewport: { width: 800, height: 600 },
    textMeasurer: createHostTextMeasurer(request => {
      requests.push(request);
      return { width: 100, height: 24 };
    }),
  });
  assert.ok(requests.length > 0);
  assert.equal(requests[0].fontFamily, "Inter");
  assert.equal(requests[0].fontSize, 16);
  assert.equal(requests[0].availableWidth, 100);
});

test("host measurer rejects non-finite measurements", () => {
  const node = textNode("text", "page:1", "Hello");
  node.layout = { ...defaultLayout(), widthMode: "hug", heightMode: "hug" };
  const result = computePageLayout(documentWith([node]), "page:1", {
    viewport: { width: 800, height: 600 },
    textMeasurer: createHostTextMeasurer(() => ({ width: Number.NaN, height: Number.POSITIVE_INFINITY })),
  });
  assert.deepEqual(result.boxes.text, { x: 0, y: 0, width: 0, height: 0 });
});
