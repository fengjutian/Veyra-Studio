import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportNodeSet, exportPageToHtml, exportPageToSvg } from "../src/index";

function frame(id: string, parentId = "page:1", x = 0, y = 0): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width: 200, height: 100 },
    appearance: { ...defaultAppearance() },
  };
}

function buildDocument(): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  const root = frame("frame:a", "page:1", 48, 48);
  const child = frame("frame:b", "frame:a", 10, 10);
  const text: DesignNode = { ...frame("text:1", "frame:a", 20, 30), type: "text", text: "标题", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  const sibling = frame("frame:c", "page:1", 400, 48);
  root.childIds = [child.id, text.id];
  document.pages["page:1"].childIds = [root.id, sibling.id];
  document.nodes[root.id] = root;
  document.nodes[child.id] = child;
  document.nodes[text.id] = text;
  document.nodes[sibling.id] = sibling;
  return document;
}

test("the export set keeps the selection, its children and its ancestors", () => {
  const document = buildDocument();
  const keep = exportNodeSet(document, ["text:1"]);
  assert.deepEqual([...keep].sort(), ["frame:a", "text:1"]);
});

test("selecting a parent keeps its whole subtree", () => {
  const document = buildDocument();
  const keep = exportNodeSet(document, ["frame:a"]);
  assert.deepEqual([...keep].sort(), ["frame:a", "frame:b", "text:1"]);
});

test("the HTML export only renders the branch of the selection", () => {
  const document = buildDocument();
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 200, height: 100 }, nodeIds: ["text:1"] });
  assert.match(result.document, /data-node-id="frame:a"/);
  assert.match(result.document, /data-node-id="text:1"/);
  assert.doesNotMatch(result.document, /data-node-id="frame:b"/);
  assert.doesNotMatch(result.document, /data-node-id="frame:c"/);
});

test("the HTML export shifts page level nodes by the export origin", () => {
  const document = buildDocument();
  const result = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 200, height: 100 }, origin: { x: 48, y: 48 } });
  assert.match(result.document, /left:0px/);
  assert.match(result.document, /top:0px/);
});

test("the SVG export crops to the selection and moves the geometry", () => {
  const document = buildDocument();
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 200, height: 100 }, nodeIds: ["text:1"], origin: { x: 48, y: 48 } });
  assert.match(result.svg, /data-node-id="text:1"/);
  assert.doesNotMatch(result.svg, /data-node-id="frame:c"/);
  // 文本节点在父容器里的坐标是 20,30：父容器原点 48,48 加上自身偏移，
  // 再减去导出原点 48,48。
  assert.match(result.svg, /x="20"/);
  assert.match(result.svg, /y="30"/);
});

test("without a selection the whole page is exported", () => {
  const document = buildDocument();
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.svg, /data-node-id="frame:c"/);
  assert.match(result.svg, /data-node-id="frame:b"/);
});
