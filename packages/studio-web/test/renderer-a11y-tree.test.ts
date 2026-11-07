import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { buildA11yTree, deletionTarget, indexOfSelection, moveIndex } from "../src/renderer/a11y-tree";

function node(id: string, parentId: string, extra: Partial<DesignNode> = {}): DesignNode {
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
    ...extra,
  } as DesignNode;
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes = Object.fromEntries(nodes.map(item => [item.id, item]));
  document.pages["page:1"]!.childIds = nodes.filter(item => item.parentId === "page:1").map(item => item.id);
  return document;
}

test("builds a depth-first list with levels in paint order", () => {
  const card = node("card", "page:1");
  const title = node("title", "card", { type: "text" } as Partial<DesignNode>);
  const badge = node("badge", "card");
  const badgeText = node("badge-text", "badge", { type: "text" } as Partial<DesignNode>);
  card.childIds = ["title", "badge"];
  badge.childIds = ["badge-text"];
  const document = documentWith([card, title, badge, badgeText]);

  const items = buildA11yTree(document, "page:1");
  assert.deepEqual(items.map(item => [item.id, item.level]), [["card", 0], ["title", 1], ["badge", 1], ["badge-text", 2]]);
  assert.equal(items[1]?.kind, "text");
});

test("hidden nodes are skipped unless explicitly included", () => {
  const visible = node("visible", "page:1");
  const hidden = node("hidden", "page:1", { visible: false });
  const document = documentWith([visible, hidden]);
  assert.deepEqual(buildA11yTree(document, "page:1").map(item => item.id), ["visible"]);
  assert.deepEqual(buildA11yTree(document, "page:1", { includeHidden: true }).map(item => item.id), ["visible", "hidden"]);
});

test("locked nodes keep their flag for aria-disabled", () => {
  const document = documentWith([node("locked", "page:1", { locked: true })]);
  assert.equal(buildA11yTree(document, "page:1")[0]?.locked, true);
});

test("moveIndex clamps at both ends and handles empty lists", () => {
  assert.equal(moveIndex(0, 1, 3), 1);
  assert.equal(moveIndex(2, 1, 3), 2);
  assert.equal(moveIndex(0, -1, 3), 0);
  assert.equal(moveIndex(-1, 1, 3), 1);
  assert.equal(moveIndex(0, 1, 0), -1);
});

test("indexOfSelection finds the first selected item", () => {
  const items = buildA11yTree(documentWith([node("a", "page:1"), node("b", "page:1")]), "page:1");
  assert.equal(indexOfSelection(items, ["b"]), 1);
  assert.equal(indexOfSelection(items, ["missing"]), -1);
});

test("locked nodes are never offered as a delete target", () => {
  const items = buildA11yTree(documentWith([
    node("free", "page:1"),
    node("locked", "page:1", { locked: true }),
  ]), "page:1");
  assert.equal(deletionTarget(items, 0)?.id, "free");
  assert.equal(deletionTarget(items, 1), undefined);
  assert.equal(deletionTarget(items, -1), undefined);
});
