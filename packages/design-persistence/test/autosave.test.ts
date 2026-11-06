import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, type DesignDocument } from "@ufira/design-schema";
import type { TransactionEntry } from "@ufira/design-runtime";
import { withAutosave, type AutosaveStatus } from "../src/autosave";
import { ProjectNotFoundError, type ProjectRepository, type ProjectSnapshot, type ProjectSummary } from "../src/contract";

interface FakeRepositoryOptions {
  failWith?: Error;
}

function fakeRepository(options: FakeRepositoryOptions = {}): ProjectRepository & { snapshots: DesignDocument[]; pruned: number } {
  const snapshots: DesignDocument[] = [];
  let pruned = 0;
  const repository: ProjectRepository & { snapshots: DesignDocument[]; pruned: number } = {
    snapshots,
    get pruned() { return pruned; },
    async open(): Promise<ProjectSnapshot> { throw new ProjectNotFoundError("project:1"); },
    async recover(): Promise<ProjectSnapshot> { throw new ProjectNotFoundError("project:1"); },
    async saveSnapshot(document: DesignDocument) {
      if (options.failWith) throw options.failWith;
      snapshots.push(document);
    },
    async appendTransactions(_entries: TransactionEntry[]) {},
    async listTransactions() { return []; },
    async putAsset() {},
    async getAsset() { return undefined; },
    async listProjects(): Promise<ProjectSummary[]> { return []; },
    async deleteProject() {},
    async pruneJournal() { pruned += 1; return 0; },
  };
  return repository;
}

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("writes the first snapshot immediately so the project exists in storage", async () => {
  const repository = fakeRepository();
  const autosave = withAutosave(repository, { delayMs: 50 });
  const document = createDocument("project:1", "Demo");

  await autosave.saveSnapshot(document);
  assert.equal(repository.snapshots.length, 1);
  assert.equal(autosave.status.state, "saved");
});

test("coalesces rapid edits into a single write", async () => {
  const repository = fakeRepository();
  const autosave = withAutosave(repository, { delayMs: 20 });
  const document = createDocument("project:1", "Demo");
  await autosave.saveSnapshot(document);

  document.revision = 1;
  await autosave.saveSnapshot(document);
  document.revision = 2;
  await autosave.saveSnapshot(document);

  assert.equal(repository.snapshots.length, 1);
  assert.equal(autosave.status.state, "pending");

  await tick(60);
  assert.equal(repository.snapshots.length, 2);
  assert.equal(repository.snapshots[1]?.revision, 2);
  assert.equal(autosave.status.state, "saved");
});

test("flush writes pending snapshots without waiting for the timer", async () => {
  const repository = fakeRepository();
  const autosave = withAutosave(repository, { delayMs: 10_000 });
  const document = createDocument("project:1", "Demo");
  await autosave.saveSnapshot(document);
  document.revision = 1;
  await autosave.saveSnapshot(document);

  await autosave.flush();
  assert.equal(repository.snapshots.length, 2);
  assert.equal(autosave.status.pendingCount, 0);
});

test("reports quota failures instead of swallowing them", async () => {
  const quotaError = Object.assign(new Error("The quota has been exceeded"), { name: "QuotaExceededError" });
  const repository = fakeRepository({ failWith: quotaError });
  const statuses: AutosaveStatus[] = [];
  const autosave = withAutosave(repository, { delayMs: 10, onStatusChange: status => statuses.push(status) });
  const document = createDocument("project:1", "Demo");

  await assert.rejects(autosave.saveSnapshot(document), /quota/);
  assert.equal(autosave.status.state, "error");
  assert.equal(autosave.status.quotaExceeded, true);
  assert.ok(statuses.some(status => status.state === "error" && status.quotaExceeded));
});

test("trims the journal after a successful write", async () => {
  const repository = fakeRepository();
  const autosave = withAutosave(repository, { delayMs: 10 });
  const document = createDocument("project:1", "Demo");
  await autosave.saveSnapshot(document);
  assert.equal(repository.pruned, 1);
});

test("keeps a failed write in the queue so the next flush retries it", async () => {
  const repository = fakeRepository({ failWith: new Error("disk on fire") });
  const autosave = withAutosave(repository, { delayMs: 10_000 });
  const document = createDocument("project:1", "Demo");
  await assert.rejects(autosave.saveSnapshot(document), /disk on fire/);

  // 第一次写失败后重新排队（这里用的是同一个必失败的仓库，所以依然失败）。
  document.revision = 1;
  await autosave.saveSnapshot(document);
  await assert.rejects(autosave.flush(), /disk on fire/);
  assert.equal(autosave.status.pendingCount, 1);
});

test("writes pending snapshots in order", async () => {
  const order: number[] = [];
  const repository = fakeRepository();
  const original = repository.saveSnapshot.bind(repository);
  repository.saveSnapshot = async (document: DesignDocument) => {
    order.push(document.revision);
    if (order.length === 2) await new Promise(resolve => setTimeout(resolve, 20));
    return original(document);
  };
  const autosave = withAutosave(repository, { delayMs: 5 });
  const document = createDocument("project:1", "Demo");
  await autosave.saveSnapshot(document);
  document.revision = 1;
  await autosave.saveSnapshot(document);
  document.revision = 2;
  await autosave.saveSnapshot(document);
  await tick(40);

  assert.deepEqual(order, [0, 2]);
});
