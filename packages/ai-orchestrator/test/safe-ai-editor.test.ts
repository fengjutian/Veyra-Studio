import assert from "node:assert/strict";
import test from "node:test";
import type { AssetWrite, ProjectRepository, ProjectSnapshot } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import { SafeAiEditor, type AiPlanner } from "../src/index";

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

const plannerFor = (node: DesignNode): AiPlanner => ({
  async plan() {
    return {
      summary: `Create ${node.name}`,
      assumptions: ["Use the active page"],
      commands: [{ type: "node.create", payload: { node } }],
    };
  },
});

test("previews without mutating and commits only after confirmation", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const editor = new SafeAiEditor(project, plannerFor(frame("hero")));

  const preview = await editor.createPlan("Create a hero");
  assert.equal(project.snapshot().revision, 0);
  assert.equal(project.snapshot().nodes.hero, undefined);
  assert.ok(preview.after.nodes.hero);
  assert.deepEqual(preview.affectedNodeIds, ["hero"]);
  assert.equal(preview.warnings.length, 1);

  const committed = await editor.confirm(preview.planId);
  assert.equal(committed.result.revision, 1);
  assert.ok(project.snapshot().nodes.hero);
  assert.equal(repository.transactions[0]?.actor.type, "ai");
  assert.equal(editor.getPending(preview.planId), undefined);
});

test("rejects a stale AI plan after a human edit", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const editor = new SafeAiEditor(project, plannerFor(frame("ai-node")));
  const preview = await editor.createPlan("Create a card");

  await project.execute({
    commandId: "human:1",
    documentId: "project:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: [{ type: "node.create", payload: { node: frame("human-node") } }],
  });

  await assert.rejects(editor.confirm(preview.planId), /Revision conflict/);
  assert.equal(project.snapshot().nodes["ai-node"], undefined);
  assert.ok(editor.getPending(preview.planId));
});

test("can cancel a pending plan", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const editor = new SafeAiEditor(project, plannerFor(frame("discarded")));
  const preview = await editor.createPlan("Create then discard");
  editor.cancel(preview.planId);
  await assert.rejects(editor.confirm(preview.planId), /no longer pending/);
  assert.equal(project.snapshot().nodes.discarded, undefined);
});

class MemoryRepository implements ProjectRepository {
  document?: DesignDocument;
  transactions: TransactionEntry[] = [];

  async open(): Promise<ProjectSnapshot> {
    if (!this.document) throw new Error("missing");
    return { document: structuredClone(this.document), recoveredFromRevision: this.document.revision, replayedTransactions: 0, latestKnownRevision: this.document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> { this.document = structuredClone(document); }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> { this.transactions.push(...structuredClone(entries)); }
  async listTransactions(): Promise<TransactionEntry[]> { return structuredClone(this.transactions); }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}
