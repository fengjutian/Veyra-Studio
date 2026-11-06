import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { ImportVersionError, prepareImportedDocument } from "../src/project-import";

test("validates and isolates imported documents as new projects", () => {
  const source = createDocument("project:source", "Source", "page:1");
  source.revision = 12;

  const { document: imported, migratedFrom } = prepareImportedDocument(source, {
    id: "project:imported",
    now: "2026-11-05T00:00:00.000Z",
  });

  assert.equal(imported.id, "project:imported");
  assert.equal(imported.revision, 0);
  assert.equal(imported.meta.name, "Source（导入）");
  assert.equal(imported.meta.createdAt, "2026-11-05T00:00:00.000Z");
  assert.equal(migratedFrom, undefined);
  assert.equal(source.id, "project:source");
  assert.equal(source.revision, 12);
});

test("rejects malformed imported documents before persistence", () => {
  assert.throws(() => prepareImportedDocument({ id: "broken" }), ImportVersionError);
});

test("upgrades an imported file from an older format version", () => {
  const legacy = createDocument("project:source", "Legacy", "page:1") as unknown as Record<string, unknown>;
  legacy.schemaVersion = 1;

  const { document, migratedFrom } = prepareImportedDocument(legacy, { now: "2026-11-05T00:00:00.000Z" });
  assert.equal(migratedFrom, 1);
  assert.equal(document.schemaVersion, 2);
  assert.deepEqual(document.migrations, [{ from: 1, to: 2, at: document.migrations?.[0]?.at }]);
});

test("refuses an imported file from a newer format version", () => {
  const future = { ...createDocument("project:source", "Future", "page:1"), schemaVersion: 99 };
  assert.throws(() => prepareImportedDocument(future), /高于当前支持的版本/);
});
