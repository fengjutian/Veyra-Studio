import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSystemProjectRepository, type AssetWrite, type ProjectRepository, type ProjectSnapshot } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "../src/index";

const frame = (id: string): DesignNode => ({
  id,
  type: "frame",
  name: id,
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: { ...defaultLayout(), width: 320, height: 200 },
  appearance: { ...defaultAppearance(), fill: "#ffffff" },
});

const envelope = (revision: number, node: DesignNode) => ({
  commandId: `cmd:${revision + 1}`,
  documentId: "project:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: [{ type: "node.create" as const, payload: { node } }],
});

test("runs create, command, recovery, layout, and export end to end", async t => {
  const directory = await mkdtemp(join(tmpdir(), "studio-application-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = new FileSystemProjectRepository(directory);
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const committed = await project.execute(envelope(0, frame("root")));
  assert.equal(committed.checkpointed, true);
  assert.equal(committed.result.revision, 1);
  assert.deepEqual(project.computeLayout("page:1", { viewport: { width: 800, height: 600 } }).boxes.root, { x: 0, y: 0, width: 320, height: 200 });
  assert.match(project.exportHtml({ pageId: "page:1", viewport: { width: 800, height: 600 } }).document, /data-node-id="root"/);

  const reopened = await StudioProject.open(repository, "project:1");
  assert.equal(reopened.project.snapshot().revision, 1);
  assert.ok(reopened.project.snapshot().nodes.root);
  assert.equal(reopened.recovery.degraded, false);
});

test("rolls back memory state when the transaction journal fails", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  repository.failJournal = true;
  await assert.rejects(project.execute(envelope(0, frame("root"))), /journal failed/);
  assert.equal(project.snapshot().revision, 0);
  assert.equal(project.snapshot().nodes.root, undefined);
});

test("keeps a journaled transaction when checkpointing fails", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  repository.failCheckpoint = true;
  const committed = await project.execute(envelope(0, frame("root")));
  assert.equal(committed.checkpointed, false);
  assert.match(committed.checkpointError ?? "", /checkpoint failed/);
  assert.equal(project.snapshot().revision, 1);
  assert.equal(repository.transactions.length, 1);
});

test("serializes concurrent commands before checking revisions", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const first = project.execute(envelope(0, frame("first")));
  const stale = project.execute(envelope(0, frame("stale")));
  await first;
  await assert.rejects(stale, /Revision conflict/);
  assert.ok(project.snapshot().nodes.first);
  assert.equal(project.snapshot().nodes.stale, undefined);
});

class MemoryRepository implements ProjectRepository {
  document?: DesignDocument;
  transactions: TransactionEntry[] = [];
  failJournal = false;
  failCheckpoint = false;

  async open(): Promise<ProjectSnapshot> {
    if (!this.document) throw new Error("missing");
    return { document: structuredClone(this.document), recoveredFromRevision: this.document.revision, replayedTransactions: 0, latestKnownRevision: this.document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> {
    if (this.failCheckpoint) throw new Error("checkpoint failed");
    this.document = structuredClone(document);
  }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    if (this.failJournal) throw new Error("journal failed");
    this.transactions.push(...structuredClone(entries));
  }
  async listTransactions(): Promise<TransactionEntry[]> { return structuredClone(this.transactions); }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}
