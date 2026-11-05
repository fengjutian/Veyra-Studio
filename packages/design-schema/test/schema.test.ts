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
