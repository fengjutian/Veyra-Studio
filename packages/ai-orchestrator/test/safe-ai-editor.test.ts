import assert from "node:assert/strict";
import test from "node:test";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
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
  appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#ffffff" }] },
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

test("a planner failure leaves the project untouched and no pending plan", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  let calls = 0;
  const failing: AiPlanner = {
    async plan() {
      calls += 1;
      throw new Error("provider exploded");
    },
  };
  const editor = new SafeAiEditor(project, failing);

  await assert.rejects(editor.createPlan("make something"), /provider exploded/);
  assert.equal(project.snapshot().revision, 0);
  assert.deepEqual(repository.transactions, []);

  // 失败之后可以原地重试，不需要清理任何残留状态。
  const retrying = new SafeAiEditor(project, plannerFor(frame("retry-node")));
  const preview = await retrying.createPlan("make something");
  assert.equal(calls, 1);
  assert.ok(preview.after.nodes["retry-node"]);
});

test("forwards the cancel signal to the planner and refuses pre-cancelled requests", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  let received: unknown;
  const planner: AiPlanner = {
    async plan(request) {
      received = request.signal;
      return { summary: "s", commands: [{ type: "node.create", payload: { node: frame("signalled") } }] };
    },
  };
  const editor = new SafeAiEditor(project, planner);
  const controller = new AbortController();

  await editor.createPlan("plan with signal", [], { signal: controller.signal });
  assert.equal(received, controller.signal);

  controller.abort();
  await assert.rejects(editor.createPlan("cancelled", [], { signal: controller.signal }), /已取消/);
});

test("reports image.patch targets in the preview", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const editor = new SafeAiEditor(project, {
    async plan() {
      const asset = { id: "asset:one", hash: "a".repeat(64), mimeType: "image/png", byteLength: 1, name: "a.png" };
      const node: DesignNode = {
        id: "image:1",
        type: "image",
        name: "图",
        parentId: "page:1",
        childIds: [],
        visible: true,
        locked: false,
        layout: { ...defaultLayout(), width: 10, height: 10 },
        appearance: defaultAppearance(),
        assetId: asset.id,
        fit: "cover",
      };
      return {
        summary: "swap image",
        commands: [
          { type: "asset.upsert", payload: { asset } },
          { type: "node.create", payload: { node } },
          { type: "image.patch", payload: { id: "image:1", patch: { fit: "contain" } } },
        ],
      };
    },
  });
  const preview = await editor.createPlan("swap");
  assert.deepEqual(preview.affectedNodeIds, ["image:1"]);
});

test("blocks confirming a plan that deletes a locked node", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  await project.execute({
    commandId: "human:1",
    documentId: "project:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: [{ type: "node.create", payload: { node: { ...frame("locked"), locked: true } } }],
  });

  const editor = new SafeAiEditor(project, {
    async plan() {
      return { summary: "删除锁定节点", commands: [{ type: "node.delete", payload: { id: "locked" } }] };
    },
  });
  const preview = await editor.createPlan("清理");
  assert.equal(preview.review.blocking, true);
  assert.equal(preview.review.findings[0]?.code, "locked-node-deleted");

  await assert.rejects(editor.confirm(preview.planId), /未通过结构审查/);
  assert.ok(project.snapshot().nodes.locked);
  assert.equal(project.snapshot().revision, 1);
});

test("blocks a current-page plan that changes another page", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  await project.execute({
    commandId: "human:pages",
    documentId: "project:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: [
      { type: "page.create", payload: { page: { id: "page:2", name: "Second", childIds: [] } } },
      { type: "node.create", payload: { node: { ...frame("other-page-node"), parentId: "page:2" } } },
    ],
  });
  const editor = new SafeAiEditor(project, {
    async plan() {
      return { summary: "改错页面", commands: [{ type: "node.patch", payload: { id: "other-page-node", patch: { name: "越界" } } }] };
    },
  });

  const preview = await editor.createPlan("只改当前页", [], { pageId: "page:1" });
  assert.equal(preview.review.blocking, true);
  assert.equal(preview.review.findings.at(-1)?.code, "page-scope-violation");
  await assert.rejects(editor.confirm(preview.planId), /未通过结构审查/);
  assert.equal(project.snapshot().nodes["other-page-node"]?.name, "other-page-node");
});

test("allows a current-page plan that stays on the requested page", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const editor = new SafeAiEditor(project, plannerFor(frame("in-scope")));

  const preview = await editor.createPlan("只改当前页", [], { pageId: "page:1" });
  assert.equal(preview.review.findings.some(finding => finding.code === "page-scope-violation"), false);
  await editor.confirm(preview.planId);
  assert.ok(project.snapshot().nodes["in-scope"]);
});

test("别的页面节点带多余字段时，本页计划不会被误判成越界", async () => {
  // 回归：runtime 曾经把**没校验**的草稿存回文档（validateDocument 的结果被丢掉），
  // 模型多写的字段就留在文档里。下一次 preview 用「校验过的文档」对比
  // 「没校验的文档」，于是每个带多余字段的节点都变成「被改过了」——
  // 一份只在本页新建节点、完全没碰别的页的计划，被单页范围审查判成
  // 「会修改 28 个页外节点」直接拦下。实测就是被这个坑掉的。
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  await project.execute({
    commandId: "human:pages",
    documentId: "project:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: [
      { type: "page.create", payload: { page: { id: "page:2", name: "Second", childIds: [] } } },
      {
        type: "node.create",
        payload: {
          node: {
            ...frame("other-page-node"),
            parentId: "page:2",
            // 模型常犯的错：把 strokeWidth 写成 strokeWeight。
            strokeWeight: 2,
          } as unknown as DesignNode,
        },
      },
    ],
  });

  const editor = new SafeAiEditor(project, plannerFor(frame("in-scope")));
  const preview = await editor.createPlan("只改当前页", [], { pageId: "page:1" });
  const violation = preview.review.findings.find(finding => finding.code === "page-scope-violation");
  assert.equal(violation, undefined, `不该报越界：${violation?.message ?? ""}`);
  await editor.confirm(preview.planId);
  assert.ok(project.snapshot().nodes["in-scope"]);
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
  async replaceProject(_projectId: string, document: DesignDocument): Promise<void> {
    this.document = structuredClone(document);
    this.transactions = [];
  }
  async listProjects(): Promise<ProjectSummary[]> {
    if (!this.document) return [];
    return [{ id: this.document.id, name: this.document.meta.name, revision: this.document.revision, updatedAt: this.document.meta.updatedAt }];
  }
  async deleteProject(): Promise<void> { this.document = undefined; this.transactions = []; }
  async pruneJournal(): Promise<number> { return 0; }
  async listSnapshots(): Promise<SnapshotSummary[]> {
    if (!this.document) return [];
    return [{ revision: this.document.revision, updatedAt: this.document.meta.updatedAt, schemaVersion: this.document.schemaVersion, current: true }];
  }
  async readSnapshot(_projectId: string, revision: number): Promise<DesignDocument> {
    if (!this.document || this.document.revision !== revision) throw new SnapshotNotFoundError("project:1", revision);
    return structuredClone(this.document);
  }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}
