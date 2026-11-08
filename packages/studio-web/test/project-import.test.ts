import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import {
  detectImportConflict,
  planBatchImport,
  prepareImportedDocument,
  readImportSource,
  uniqueProjectName,
  validateBatchNames,
  validateImportName,
} from "../src/project-import";

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
  assert.equal(document.schemaVersion, 3);
  assert.deepEqual(document.migrations, [
    { from: 1, to: 2, at: document.migrations?.[0]?.at },
    { from: 2, to: 3, at: document.migrations?.[1]?.at },
  ]);
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

test("a user-provided name is accepted when it is free", () => {
  assert.equal(validateImportName("  我的新项目 ", ["首页"]), undefined);
});

test("an empty or duplicate user-provided name is rejected", () => {
  assert.match(validateImportName("   ", []) ?? "", /请输入项目名称/);
  assert.match(validateImportName("首页", ["首页"]) ?? "", /重名|已经有同名/);
  assert.match(validateImportName("首页", [" 首页 "]) ?? "", /重名|已经有同名/);
});

test("batch names are rejected when they clash with each other or with existing projects", () => {
  assert.equal(validateBatchNames(["A", "B"], ["首页"]), undefined);
  assert.match(validateBatchNames(["A", "A"], []) ?? "", /重名/);
  assert.match(validateBatchNames(["首页"], ["首页"]) ?? "", /重名/);
  assert.match(validateBatchNames(["A", ""], []) ?? "", /请输入项目名称/);
});

test("a malformed file becomes a failure instead of breaking the whole batch", () => {
  const parsed = readImportSource("broken.json", "{ 不是 json");
  assert.ok(parsed && "reason" in parsed);
  assert.match(parsed.reason, /不是合法的 JSON/);
});

test("a valid file becomes a batch source with its raw content", () => {
  const source = createDocument("project:1", "首页", "page:1");
  const parsed = readImportSource("ok.json", JSON.stringify(source));
  assert.ok(parsed && "raw" in parsed);
  assert.equal(parsed.fileName, "ok.json");
});

test("a batch import plans one new project per file and never overwrites", () => {
  const first = createDocument("project:1", "首页", "page:1");
  const second = createDocument("project:2", "详情页", "page:1");
  const result = planBatchImport(
    [{ fileName: "a.json", raw: first }, { fileName: "b.json", raw: second }],
    [{ id: "project:9", name: "其他" }],
  );

  assert.equal(result.failures.length, 0);
  assert.equal(result.plans.length, 2);
  for (const plan of result.plans) {
    assert.notEqual(plan.document.id, plan.sourceId, "批量导入必须换新 id，不能覆盖原项目");
    assert.equal(plan.document.revision, 0);
  }
  assert.deepEqual(result.plans.map(plan => plan.name), ["首页（导入）", "详情页（导入）"]);
});

test("a batch import de-duplicates names against existing projects and within the batch", () => {
  const first = createDocument("project:1", "首页", "page:1");
  const second = createDocument("project:2", "首页", "page:1");
  const result = planBatchImport(
    [{ fileName: "a.json", raw: first }, { fileName: "b.json", raw: second }],
    [{ id: "project:9", name: "首页（导入）" }],
  );

  assert.deepEqual(result.plans.map(plan => plan.name), ["首页（导入）（2）", "首页（导入）（3）"]);
  assert.equal(result.plans[0]?.renamed, true);
});

test("a batch import reports the files it cannot read", () => {
  const good = createDocument("project:1", "首页", "page:1");
  const result = planBatchImport(
    [{ fileName: "good.json", raw: good }, { fileName: "bad.json", raw: { id: "broken" } }],
    [],
  );

  assert.equal(result.plans.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.fileName, "bad.json");
  assert.match(result.failures[0]?.reason ?? "", /schemaVersion/);
});

test("a batch import flags a file that is another version of an existing project", () => {
  const source = createDocument("project:1", "首页", "page:1");
  const result = planBatchImport([{ fileName: "a.json", raw: source }], [{ id: "project:1", name: "首页" }]);

  assert.equal(result.plans[0]?.conflict?.kind, "id");
  assert.equal(result.plans[0]?.document.id !== "project:1", true);
});
