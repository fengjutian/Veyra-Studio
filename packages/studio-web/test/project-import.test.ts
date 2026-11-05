import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { prepareImportedDocument } from "../src/project-import";

test("validates and isolates imported documents as new projects", () => {
  const source = createDocument("project:source", "Source", "page:1");
  source.revision = 12;

  const imported = prepareImportedDocument(source, {
    id: "project:imported",
    now: "2026-11-05T00:00:00.000Z",
  });

  assert.equal(imported.id, "project:imported");
  assert.equal(imported.revision, 0);
  assert.equal(imported.meta.name, "Source（导入）");
  assert.equal(imported.meta.createdAt, "2026-11-05T00:00:00.000Z");
  assert.equal(source.id, "project:source");
  assert.equal(source.revision, 12);
});

test("rejects malformed imported documents before persistence", () => {
  assert.throws(() => prepareImportedDocument({ id: "broken" }), /document/i);
});
