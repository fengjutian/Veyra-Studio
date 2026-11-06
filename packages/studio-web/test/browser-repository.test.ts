import assert from "node:assert/strict";
import test from "node:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { legacyDocumentPayload, repositoryContractTests } from "@ufira/design-persistence/contract-suite";
import { DexieProjectRepository } from "../src/browser-repository";

repositoryContractTests("浏览器仓库", async () => {
  const repository = createRepository();
  return {
    repository,
    seed: async (projectId: string, payload: unknown) => {
      await repository.storage.snapshots.put({ projectId, revision: 0, document: payload as never });
    },
    cleanup: async () => { await repository.deleteDatabase(); },
  };
});

test("saves and opens an IndexedDB snapshot", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const document = createDocument("project:1", "Demo", "page:1");
  await repository.saveSnapshot(document);
  assert.deepEqual((await repository.open(document.id)).document, document);
});

test("replays journaled transactions after the snapshot", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const document = createDocument("project:1", "Demo", "page:1"); await repository.saveSnapshot(document);
  await repository.appendTransactions([{ ...entry(document.id, 1), commands: [{ type: "node.create", payload: { node: frame("frame:1") } }] }]);
  const recovered = await repository.open(document.id);
  assert.equal(recovered.document.revision, 1); assert.ok(recovered.document.nodes["frame:1"]); assert.equal(recovered.replayedTransactions, 1); assert.equal(recovered.degraded, false);
});

test("reports a revision gap as degraded recovery", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const document = createDocument("project:1", "Demo", "page:1"); await repository.saveSnapshot(document);
  await repository.appendTransactions([{ ...entry(document.id, 2), commands: [{ type: "node.create", payload: { node: frame("frame:2") } }] }]);
  const recovered = await repository.open(document.id);
  assert.equal(recovered.document.revision, 0); assert.equal(recovered.latestKnownRevision, 2); assert.equal(recovered.degraded, true);
});

test("replays a persisted undo without resurrecting the change", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const document = createDocument("project:1", "Demo", "page:1"); await repository.saveSnapshot(document);
  await repository.appendTransactions([
    { ...entry(document.id, 1), commands: [{ type: "node.create", payload: { node: frame("frame:1") } }] },
    { ...entry(document.id, 2), commandId: "undo:1", commands: [{ type: "history.restore", payload: { document } }] },
  ]);
  const recovered = await repository.open(document.id);
  assert.equal(recovered.document.revision, 2); assert.equal(recovered.document.nodes["frame:1"], undefined); assert.equal(recovered.replayedTransactions, 2);
});

test("stores verified binary assets", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const bytes = new TextEncoder().encode("asset"), hash = "d59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718";
  await repository.putAsset("project:1", { hash, bytes }); assert.deepEqual(await repository.getAsset("project:1", hash), bytes);
  await assert.rejects(repository.putAsset("project:1", { hash: "0".repeat(64), bytes }), /hash mismatch/);
});

test("rejects mixed projects and duplicate transaction revisions", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  await assert.rejects(repository.appendTransactions([entry("project:1", 1), entry("project:2", 2)]), /cannot mix projects/);
  await repository.appendTransactions([entry("project:1", 1)]); await assert.rejects(repository.appendTransactions([entry("project:1", 1)]));
});

test("lists and deletes complete projects", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const first = createDocument("project:1", "First", "page:1"), second = createDocument("project:2", "Second", "page:2");
  first.meta.updatedAt = "2026-01-01T00:00:00.000Z";
  second.meta.updatedAt = "2026-01-02T00:00:00.000Z";
  await repository.saveSnapshot(first); await repository.saveSnapshot(second);
  await repository.appendTransactions([entry(first.id, 1)]);
  assert.deepEqual((await repository.listProjects()).map(project => project.name), ["Second", "First"]);
  await repository.deleteProject(first.id);
  assert.deepEqual((await repository.listProjects()).map(project => project.id), [second.id]);
  assert.deepEqual(await repository.listTransactions(first.id), []);
  await assert.rejects(repository.open(first.id), /does not exist/);
});

test("migrates a legacy snapshot and keeps the upgraded copy", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  await repository.storage.snapshots.put({ projectId: "project:1", revision: 0, document: legacyDocumentPayload() as never });

  const recovered = await repository.open("project:1");
  assert.equal(recovered.migratedFrom, 1);
  assert.equal(recovered.document.schemaVersion, 2);
  const stored = await repository.storage.snapshots.where("projectId").equals("project:1").toArray();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.document.schemaVersion, 2);
});

test("keeps only the newest snapshots for a project", async t => {
  const repository = createRepository(); t.after(() => repository.deleteDatabase());
  const document = createDocument("project:1", "Demo", "page:1");
  for (let revision = 0; revision < 12; revision++) {
    document.revision = revision;
    await repository.saveSnapshot(document);
  }
  const current = await repository.storage.snapshots.get("project:1");
  assert.equal(current?.revision, 11);
  const history = await repository.storage.snapshotHistory.where("projectId").equals("project:1").toArray();
  // 保留 10 份快照：当前一份 + 历史九份，最早的 0、1 被裁掉。
  assert.deepEqual(history.map(item => item.revision).sort((left, right) => left - right), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("upgrades a version 1 database to the version 2 storage layout", async t => {
  const databaseName = `legacy-${crypto.randomUUID()}`;
  const legacy = new Dexie(databaseName, { indexedDB, IDBKeyRange });
  legacy.version(1).stores({ projects: "&id, updatedAt", snapshots: "&projectId, revision", transactions: "[documentId+revision], documentId, revision", assets: "[projectId+hash], projectId, hash" });
  await legacy.open();
  const document = createDocument("project:1", "Legacy", "page:1");
  await legacy.table("snapshots").put({ projectId: "project:1", revision: 0, document });
  await legacy.table("projects").put({ id: "project:1", revision: 0, updatedAt: document.meta.updatedAt });
  legacy.close();

  const repository = createRepository(databaseName);
  t.after(() => repository.deleteDatabase());
  const opened = await repository.open("project:1");
  assert.equal(opened.document.id, "project:1");
  assert.equal(opened.document.meta.name, "Legacy");

  const current = await repository.storage.snapshots.get("project:1");
  assert.equal(current?.revision, 0);
  assert.deepEqual((await repository.listProjects()).map(item => item.id), ["project:1"]);
});

function createRepository(databaseName = `test-${crypto.randomUUID()}`): DexieProjectRepository { return new DexieProjectRepository({ databaseName, indexedDB, IDBKeyRange }); }
function entry(documentId: string, revision: number) { return { commandId: `cmd:${revision}`, documentId, revision, committedAt: new Date(0).toISOString(), actor: { type: "human" as const, id: "test" }, commands: [], warnings: [] }; }
function frame(id: string): DesignNode { return { id, type: "frame", name: id, parentId: "page:1", childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() }; }
