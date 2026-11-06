import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { buildSortableGroups, flattenLayers } from "../src/layer-tree";
import { arrayMove, canContainChildren, childIdsOf, planReparent, resolveDropPosition } from "../src/layer-reorder";
import { findFirstTextNode, listComponents, makeInstanceNode } from "../src/components";

function frame(id: string, parentId = "page:1"): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
}

function build(): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  const root = frame("root");
  const childA = frame("a", "root");
  const childB = frame("b", "root");
  const grandChild = frame("a1", "a");
  root.childIds = [childA.id, childB.id];
  childA.childIds = [grandChild.id];
  document.pages["page:1"].childIds = [root.id];
  document.nodes[root.id] = root;
  document.nodes[childA.id] = childA;
  document.nodes[childB.id] = childB;
  document.nodes[grandChild.id] = grandChild;
  return document;
}

test("flattens the node tree into ordered rows with depth", () => {
  const rows = flattenLayers(build(), ["root"], new Set());
  assert.deepEqual(rows.map(row => row.id), ["root", "a", "a1", "b"]);
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 2, 1]);
});

test("hides descendants of a collapsed node", () => {
  const rows = flattenLayers(build(), ["root"], new Set(["a"]));
  assert.deepEqual(rows.map(row => row.id), ["root", "a", "b"]);
});

test("groups children by parent for sorting", () => {
  const groups = buildSortableGroups(build(), ["root"]);
  assert.deepEqual(groups.__root__, ["root"]);
  assert.deepEqual(groups.root, ["a", "b"]);
});

test("moves a node into the slot of its former sibling", () => {
  // Dragging "a" onto "b" takes b's slot, so the order becomes b, a.
  const plan = planReparent(build(), "a", "b", "after");
  assert.deepEqual(plan, { parentId: "root", index: 1 });
});

test("moves a node backwards when dropped before a later sibling", () => {
  const plan = planReparent(build(), "b", "a", "before");
  assert.deepEqual(plan, { parentId: "root", index: 0 });
});

test("reparents a node into a container", () => {
  const plan = planReparent(build(), "b", "a", "inside");
  assert.deepEqual(plan, { parentId: "a", index: 1 });
});

test("resolves the drop position from the pointer offset", () => {
  const frame = { type: "frame" };
  assert.equal(resolveDropPosition(frame, 10, 100), "before");
  assert.equal(resolveDropPosition(frame, 50, 100), "inside");
  assert.equal(resolveDropPosition(frame, 90, 100), "after");
  assert.equal(resolveDropPosition({ type: "text" }, 50, 100), "after");
});

test("moves items in a list by swapping their slots", () => {
  assert.deepEqual(arrayMove(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(arrayMove(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
});

test("refuses to move a node into its own descendant", () => {
  assert.equal(planReparent(build(), "a", "a1", "inside"), undefined);
});

test("refuses to drop a node onto itself", () => {
  assert.equal(planReparent(build(), "a", "a", "inside"), undefined);
});

test("refuses to drop a node into a leaf that cannot contain children", () => {
  const document = build();
  // A text node is a leaf and cannot own children.
  document.nodes["a1"] = { ...frame("a1", "a"), type: "text", text: "Hi", fontFamily: "Inter", fontSize: 16, lineHeight: 24 } as DesignNode;
  assert.equal(planReparent(document, "b", "a1", "inside"), undefined);
});

test("reports the child list of pages and nodes", () => {
  const document = build();
  assert.deepEqual(childIdsOf(document, "page:1"), ["root"]);
  assert.deepEqual(childIdsOf(document, "root"), ["a", "b"]);
  assert.deepEqual(childIdsOf(document, "missing"), []);
});

test("only frames and components accept children", () => {
  assert.equal(canContainChildren({ type: "frame" }), true);
  assert.equal(canContainChildren({ type: "component" }), true);
  assert.equal(canContainChildren({ type: "rectangle" }), false);
});

test("lists components with their instance counts", () => {
  const document = build();
  document.components["component:button"] = { id: "component:button", name: "Button", rootNodeId: "root" };
  document.nodes["instance:1"] = { ...frame("instance:1"), type: "instance", componentId: "component:button", overrides: {} } as DesignNode;
  const components = listComponents(document);
  assert.equal(components.length, 1);
  assert.equal(components[0].name, "Button");
  assert.equal(components[0].instanceCount, 1);
});

test("builds an instance node bound to its component", () => {
  const node = makeInstanceNode("component:button", "page:1", { id: "instance:1", name: "Button", x: 10, y: 20, width: 200, height: 120 });
  assert.equal(node.type, "instance");
  assert.equal(node.componentId, "component:button");
  assert.equal(node.parentId, "page:1");
  assert.equal(node.layout.x, 10);
});

test("finds the first text node inside a component", () => {
  const document = build();
  const text: DesignNode = { ...frame("t", "a1"), type: "text", text: "Hi", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  document.nodes["t"] = text;
  document.nodes["a1"]!.childIds = ["t"];
  assert.equal(findFirstTextNode(document, "root"), "t");
});
