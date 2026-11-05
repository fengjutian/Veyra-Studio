import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DexieProjectRepository } from "../src/browser-repository";

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

function createRepository(): DexieProjectRepository { return new DexieProjectRepository({ databaseName: `test-${crypto.randomUUID()}`, indexedDB, IDBKeyRange }); }
function entry(documentId: string, revision: number) { return { commandId: `cmd:${revision}`, documentId, revision, committedAt: new Date(0).toISOString(), actor: { type: "human" as const, id: "test" }, commands: [], warnings: [] }; }
function frame(id: string): DesignNode { return { id, type: "frame", name: id, parentId: "page:1", childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() }; }
