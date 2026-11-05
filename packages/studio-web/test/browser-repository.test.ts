import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionEntry } from "@ufira/design-runtime";
import { createDocument } from "@ufira/design-schema";
import { BrowserProjectRepository } from "../src/browser-repository";

test("saves and opens a browser snapshot", async () => {
  const storage = new MemoryStorage();
  const repository = new BrowserProjectRepository(storage);
  const document = createDocument("project:1", "Demo", "page:1");
  await repository.saveSnapshot(document);
  assert.deepEqual((await repository.open(document.id)).document, document);
  assert.equal(storage.getItem("studio:project:1:document:pending"), null);
});

test("recovers a pending snapshot when the primary value is corrupt", async () => {
  const storage = new MemoryStorage();
  const document = createDocument("project:1", "Demo", "page:1");
  storage.setItem("studio:project:1:document", "not-json");
  storage.setItem("studio:project:1:document:pending", JSON.stringify(document));
  const recovered = await new BrowserProjectRepository(storage).open(document.id);
  assert.deepEqual(recovered.document, document);
});

test("rejects mixed projects and duplicate transaction revisions", async () => {
  const repository = new BrowserProjectRepository(new MemoryStorage());
  await assert.rejects(repository.appendTransactions([entry("project:1", 1), entry("project:2", 2)]), /cannot mix projects/);
  await repository.appendTransactions([entry("project:1", 1)]);
  await assert.rejects(repository.appendTransactions([entry("project:1", 1)]), /already exists/);
});

function entry(documentId: string, revision: number): TransactionEntry {
  return { commandId: `cmd:${revision}`, documentId, revision, committedAt: new Date(0).toISOString(), actor: { type: "human", id: "test" }, commands: [], warnings: [] };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
