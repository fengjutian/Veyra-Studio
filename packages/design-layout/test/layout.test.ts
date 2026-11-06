import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { computePageLayout } from "../src/index";

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

function documentWith(root: DesignNode, children: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Layout");
  root.childIds = children.map(child => child.id);
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  for (const child of children) document.nodes[child.id] = child;
  return document;
}

test("lays out a vertical stack with padding and gap", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", width: 200, height: 160, gap: 10, padding: { top: 10, right: 20, bottom: 10, left: 20 } };
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 50, height: 30 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 60, height: 40 };
  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.deepEqual(result.boxes.first, { x: 20, y: 10, width: 50, height: 30 });
  assert.deepEqual(result.boxes.second, { x: 20, y: 50, width: 60, height: 40 });
});

test("shares remaining main-axis space between fill children", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "horizontal", width: 300, height: 100, gap: 10 };
  const fixed = node("fixed", "root");
  fixed.layout = { ...defaultLayout(), width: 100, height: 20 };
  const fillA = node("fill-a", "root");
  fillA.layout = { ...defaultLayout(), widthMode: "fill", heightMode: "fill" };
  const fillB = node("fill-b", "root");
  fillB.layout = { ...defaultLayout(), widthMode: "fill", heightMode: "fill" };
  const result = computePageLayout(documentWith(root, [fixed, fillA, fillB]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes["fill-a"].width, 90);
  assert.equal(result.boxes["fill-b"].width, 90);
  assert.equal(result.boxes["fill-b"].x, 210);
  assert.equal(result.boxes["fill-a"].height, 100);
});

test("derives hug dimensions from stack children", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "vertical", widthMode: "hug", heightMode: "hug", gap: 5, padding: { top: 4, right: 4, bottom: 4, left: 4 } };
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 80, height: 20 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 60, height: 30 };
  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.boxes.root.width, 88);
  assert.equal(result.boxes.root.height, 63);
});

test("uses an injected text measurer for hug text", () => {
  const text = node("text", "page:1", {
    type: "text",
    text: "Hello",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  } as Partial<DesignNode>);
  text.layout = { ...defaultLayout(), widthMode: "hug", heightMode: "hug" };
  const document = createDocument("doc:1", "Layout");
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = computePageLayout(document, "page:1", {
    viewport: { width: 800, height: 600 },
    textMeasurer: { measure: () => ({ width: 42, height: 24 }) },
  });
  assert.deepEqual(result.boxes.text, { x: 0, y: 0, width: 42, height: 24 });
});

test("reports overflow without rejecting the layout", () => {
  const root = node("root", "page:1");
  root.layout = { ...defaultLayout(), mode: "stack", direction: "horizontal", width: 100, height: 100, gap: 10 };
  const first = node("first", "root");
  first.layout = { ...defaultLayout(), width: 80 };
  const second = node("second", "root");
  second.layout = { ...defaultLayout(), width: 80 };
  const result = computePageLayout(documentWith(root, [first, second]), "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.warnings[0].code, "overflow");
});

function textNode(id: string, text: string, layout: Partial<ReturnType<typeof defaultLayout>>): DesignNode {
  return node(id, "page:1", {
    type: "text",
    text,
    fontFamily: "Inter",
    fontSize: 20,
    lineHeight: 24,
    layout: { ...defaultLayout(), ...layout },
  } as Partial<DesignNode>);
}

test("reports text that needs more lines than its fixed height allows", () => {
  const text = textNode("text", "AAAAA", { width: 40, height: 24 });
  const document = createDocument("doc:1", "Layout");
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = computePageLayout(document, "page:1", { viewport: { width: 800, height: 600 } });
  const warning = result.warnings.find(item => item.code === "text-overflow");
  assert.ok(warning, "expected a text-overflow warning");
  assert.equal(warning!.nodeId, "text");
  // The box keeps its declared size — the warning reports the problem, it does not resize it.
  assert.deepEqual(result.boxes.text, { x: 0, y: 0, width: 40, height: 24 });
});

test("does not report text overflow when the height hugs the content", () => {
  const text = textNode("text", "AAAAA", { width: 40, heightMode: "hug" });
  const document = createDocument("doc:1", "Layout");
  document.pages["page:1"].childIds = [text.id];
  document.nodes[text.id] = text;
  const result = computePageLayout(document, "page:1", { viewport: { width: 800, height: 600 } });
  assert.equal(result.warnings.find(item => item.code === "text-overflow"), undefined);
  // "AAAAA" at 20px needs 11px per glyph, so 40px of width fits two lines.
  assert.equal(result.boxes.text.height, 48);
});
