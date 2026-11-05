import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import type { TransactionEntry } from "@ufira/design-runtime";
import { FileSystemProjectRepository, ProjectNotFoundError } from "../src/index";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "design-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repository: new FileSystemProjectRepository(directory) };
}

test("atomically saves and opens a validated snapshot", async t => {
  const { repository } = await fixture(t);
  const document = createDocument("project:1", "Demo");
  await repository.saveSnapshot(document);
  const opened = await repository.open(document.id);
  assert.deepEqual(opened.document, document);
  assert.equal(opened.degraded, false);
});

test("falls back to the previous snapshot when the latest is corrupt", async t => {
  const { directory, repository } = await fixture(t);
  const document = createDocument("project:1", "Demo");
  await repository.saveSnapshot(document);
  document.revision = 1;
  document.meta.updatedAt = new Date().toISOString();
  await repository.saveSnapshot(document);
  await writeFile(join(directory, encodeURIComponent(document.id), "snapshots", "000000000001.json"), "{broken");
  const recovered = await repository.recover(document.id);
  assert.equal(recovered.document.revision, 0);
  assert.equal(recovered.latestKnownRevision, 1);
  assert.equal(recovered.degraded, true);
});

test("stores transaction records in revision order", async t => {
  const { repository } = await fixture(t);
  const entry = (revision: number): TransactionEntry => ({
    commandId: `cmd:${revision}`,
    documentId: "project:1",
    revision,
    committedAt: new Date().toISOString(),
    actor: { type: "human", id: "user:1" },
    commands: [],
    warnings: [],
  });
  await repository.appendTransactions([entry(2), entry(1)]);
  const entries = await repository.listTransactions("project:1");
  assert.deepEqual(entries.map(item => item.revision), [1, 2]);
});

test("deduplicates assets by verified SHA-256 hash", async t => {
  const { repository } = await fixture(t);
  const bytes = new TextEncoder().encode("asset-data");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await repository.putAsset("project:1", { hash, bytes });
  await repository.putAsset("project:1", { hash, bytes });
  assert.deepEqual(Array.from((await repository.getAsset("project:1", hash)) ?? []), Array.from(bytes));
  await assert.rejects(repository.putAsset("project:1", { hash: "0".repeat(64), bytes }), /hash mismatch/);
});

test("reports missing projects", async t => {
  const { repository } = await fixture(t);
  await assert.rejects(repository.open("missing"), ProjectNotFoundError);
});
