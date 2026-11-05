import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, validateDocument } from "../src/index";

test("creates a valid empty document", () => {
  const document = createDocument("doc:1", "Demo");
  assert.deepEqual(validateDocument(document), document);
});

test("rejects orphan nodes", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Orphan",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  assert.throws(() => validateDocument(document), /orphaned/);
});

test("rejects missing and type-incompatible token bindings", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes["node:1"] = {
    id: "node:1",
    type: "frame",
    name: "Bound",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    bindings: { fill: "spacing.large" },
  };
  document.pages["page:1"].childIds.push("node:1");
  document.tokens["spacing.large"] = { type: "number", value: 24 };
  assert.throws(() => validateDocument(document), /fill binding cannot use number token/);
});

test("rejects children on leaf nodes", () => {
  const document = createDocument("doc:1", "Demo");
  document.nodes.parent = {
    id: "parent",
    type: "text",
    name: "Text",
    parentId: "page:1",
    childIds: ["child"],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "Parent",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  };
  document.nodes.child = {
    id: "child",
    type: "rectangle",
    name: "Child",
    parentId: "parent",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  document.pages["page:1"].childIds = ["parent"];
  assert.throws(() => validateDocument(document), /text cannot contain children/);
});
