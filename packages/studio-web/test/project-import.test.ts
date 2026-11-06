import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { detectImportConflict, prepareImportedDocument, uniqueProjectName } from "../src/project-import";

test("validates and isolates imported documents as new projects", () => {
  const source = createDocument("project:source", "Source", "page:1");
  source.revision = 12;

  const { document: imported, migratedFrom, mode, sourceName } = prepareImportedDocument(source, {
    id: "project:imported",
    now: "2026-11-05T00:00:00.000Z",
  });

  assert.equal(imported.id, "project:imported");
  assert.equal(imported.revision, 0);
  assert.equal(imported.meta.name, "Source（导入）");
  assert.equal(imported.meta.createdAt, "2026-11-05T00:00:00.000Z");
  assert.equal(migratedFrom, undefined);
  assert.equal(mode, "copy");
  assert.equal(sourceName, "Source");
  assert.equal(source.id, "project:source");
  assert.equal(source.revision, 12);
});

test("rejects malformed imported documents before persistence", () => {
  assert.throws(() => prepareImportedDocument({ id: "broken" }), /schemaVersion/);
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

test("copy mode gives the imported project a new id and marks the name", () => {
  const source = createDocument("project:source", "Source", "page:1");
  const prepared = prepareImportedDocument(source);

  assert.equal(prepared.mode, "copy");
  assert.notEqual(prepared.document.id, source.id);
  assert.match(prepared.document.id, /^project:/);
  assert.equal(prepared.document.meta.name, "Source（导入）");
});

test("replace mode keeps the target id and the original name", () => {
  const source = createDocument("project:source", "Source", "page:1");
  const prepared = prepareImportedDocument(source, { mode: "replace", id: "project:source" });

  assert.equal(prepared.mode, "replace");
  assert.equal(prepared.document.id, "project:source");
  assert.equal(prepared.document.meta.name, "Source");
  assert.equal(prepared.document.revision, 0);
});

test("detects a conflict when the imported file is the same project", () => {
  const source = createDocument("project:1", "首页", "page:1");
  const conflict = detectImportConflict({ id: source.id, name: source.meta.name }, [
    { id: "project:1", name: "首页" },
    { id: "project:2", name: "其他" },
  ]);

  assert.deepEqual(conflict, { kind: "id", projectId: "project:1", projectName: "首页" });
});

test("reports a name-only conflict for a different project and suggests a free name", () => {
  const source = createDocument("project:1", "首页（导入）", "page:1");
  const conflict = detectImportConflict({ id: source.id, name: source.meta.name }, [
    { id: "project:2", name: "首页（导入）" },
  ]);

  assert.equal(conflict?.kind, "name");
  assert.equal(conflict?.projectId, "project:2");
  assert.equal(conflict?.suggestedName, "首页（导入）（2）");
});

test("no conflict when both id and name are new", () => {
  const conflict = detectImportConflict({ id: "project:9", name: "全新" }, [{ id: "project:1", name: "首页" }]);
  assert.equal(conflict, undefined);
});

test("uniqueProjectName counts up until the name is free", () => {
  assert.equal(uniqueProjectName("首页", []), "首页");
  assert.equal(uniqueProjectName("首页", ["首页"]), "首页（2）");
  assert.equal(uniqueProjectName("首页", ["首页", "首页（2）"]), "首页（3）");
  assert.equal(uniqueProjectName("   ", []), "未命名设计");
});

test("an explicit name overrides the copy-mode suffix", () => {
  const source = createDocument("project:source", "Source", "page:1");
  const prepared = prepareImportedDocument(source, { mode: "copy", name: "Source（2）" });
  assert.equal(prepared.document.meta.name, "Source（2）");
});

test("the conflict check uses the imported file's own id, not the rewritten one", () => {
  const source = createDocument("project:1", "首页", "page:1");
  const prepared = prepareImportedDocument(source);
  const conflict = detectImportConflict({ id: prepared.sourceId, name: prepared.document.meta.name }, [{ id: "project:1", name: "首页" }]);

  assert.notEqual(prepared.document.id, "project:1");
  assert.equal(prepared.sourceId, "project:1");
  assert.equal(conflict?.kind, "id");
  assert.equal(conflict?.projectId, "project:1");
});

test("a previously imported copy collides by its stored name, not the source name", () => {
  const source = createDocument("project:1", "首页", "page:1");
  const prepared = prepareImportedDocument(source);
  // 上一次导入存下来的名字是「首页（导入）」，再用原名导入会直接撞上它。
  const conflict = detectImportConflict({ id: prepared.sourceId, name: prepared.document.meta.name }, [
    { id: "project:2", name: "首页（导入）" },
  ]);
  assert.equal(conflict?.kind, "name");
  assert.equal(conflict?.suggestedName, "首页（导入）（2）");
});
