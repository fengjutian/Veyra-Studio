import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { flattenNodeTrees } from "../src/node-tree";

test("flattens nested node trees in visual depth-first order", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes.parent = frame("parent", "page:1", ["first", "second"]);
  document.nodes.first = frame("first", "parent", ["grandchild"]);
  document.nodes.second = frame("second", "parent");
  document.nodes.grandchild = frame("grandchild", "first");
  document.pages["page:1"]!.childIds = ["parent"];
  assert.deepEqual(flattenNodeTrees(document, ["parent"]).map(node => node.id), ["parent", "first", "grandchild", "second"]);
});

test("ignores missing and repeated roots", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes.node = frame("node", "page:1");
  assert.deepEqual(flattenNodeTrees(document, ["missing", "node", "node"]).map(node => node.id), ["node"]);
});

function frame(id: string, parentId: string, childIds: string[] = []): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds, visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
}
