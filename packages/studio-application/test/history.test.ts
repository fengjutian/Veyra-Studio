import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { SnapshotNotFoundError, type AssetWrite, type ProjectRepository, type ProjectSnapshot, type ProjectSummary, type SnapshotSummary } from "@ufira/design-persistence";
import { DesignRuntime, type TransactionEntry } from "@ufira/design-runtime";
import { HistoryReconstructionError, canRestoreRevision, reconstructDocumentAt } from "../src/index";

const frame = (id: string): DesignNode => ({
  id,
  type: "frame",
  name: id,
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: defaultLayout(),
  appearance: defaultAppearance(),
});

/**
 * 造一段真实的历史：初始快照 + 连续提交的事务。
 *
 * 事务条目直接来自运行时自己的日志，避免手工编造出和运行时不一致的形状。
 */
function buildHistory(steps = 4) {
  const repository = new HistoryRepository();
  const runtime = new DesignRuntime(createDocument("project:1", "Demo"));
  repository.snapshots.set(0, runtime.snapshot());
  for (let index = 1; index <= steps; index += 1) {
    runtime.execute({
      commandId: `cmd:${index}`,
      documentId: "project:1",
      baseRevision: runtime.snapshot().revision,
      actor: { type: "human", id: "local-user" },
      commands: [{ type: "node.create", payload: { node: frame(`frame:${index}`) } }],
    });
    repository.transactions.push(runtime.transactionLog().at(-1)!);
  }
  return { repository, runtime };
}

test("回到某一条事务之后的状态", async () => {
  const { repository } = buildHistory(4);
  const reconstructed = await reconstructDocumentAt(repository, "project:1", 2);

  assert.equal(reconstructed.document.revision, 2);
  assert.equal(reconstructed.replayedTransactions, 2);
  assert.equal(reconstructed.baseRevision, 0);
  assert.ok(reconstructed.document.nodes["frame:2"]);
  assert.equal(reconstructed.document.nodes["frame:3"], undefined);
});

test("目标正好是快照版本时不需要重放", async () => {
  const { repository } = buildHistory(4);
  const reconstructed = await reconstructDocumentAt(repository, "project:1", 0);

  assert.equal(reconstructed.document.revision, 0);
  assert.equal(reconstructed.replayedTransactions, 0);
});

test("起点快照被清理时明确报 base-missing", async () => {
  const { repository } = buildHistory(4);
  // 只保留最新快照，模拟保留策略把旧版本清掉。
  const latest = createDocument("project:1", "Demo");
  latest.revision = 4;
  repository.snapshots.clear();
  repository.snapshots.set(4, latest);

  await assert.rejects(
    reconstructDocumentAt(repository, "project:1", 2),
    (error: unknown) => error instanceof HistoryReconstructionError && error.reason === "base-missing",
  );
});

test("起点快照被清理时用重建基线起步", async () => {
  const { repository } = buildHistory(4);
  // 只保留最新快照，但基线还在：日志没被裁，那几步就仍然重建得出来。
  const latest = createDocument("project:1", "Demo");
  latest.revision = 4;
  repository.snapshots.clear();
  repository.snapshots.set(4, latest);
  repository.baseline = createDocument("project:1", "Demo");

  const reconstructed = await reconstructDocumentAt(repository, "project:1", 2);
  assert.equal(reconstructed.document.revision, 2);
  assert.equal(reconstructed.baseRevision, 0);
  assert.equal(reconstructed.replayedTransactions, 2);
  assert.ok(reconstructed.document.nodes["frame:2"]);
  assert.equal(reconstructed.document.nodes["frame:3"], undefined);
});

test("可回退判定按真实可达性来", () => {
  // 基线 r0 加上连续日志：窗口里的每一版都能重建。
  assert.equal(canRestoreRevision(3, [0, 5], [1, 2, 3, 4, 5]), true);
  // 日志被裁到只剩 r4、r5：更早的版本没有日志，回退不了。
  assert.equal(canRestoreRevision(3, [0, 5], [4, 5]), false);
  // 没有不晚于目标的起点：同样回退不了。
  assert.equal(canRestoreRevision(3, [5], [1, 2, 3, 4, 5]), false);
  // 目标正好是起点：不需要重放，直接就是那一版。
  assert.equal(canRestoreRevision(5, [0, 5], [1, 2, 3, 4, 5]), true);
});

test("事务日志断档时明确报 journal-gap", async () => {
  const { repository } = buildHistory(4);
  repository.transactions = repository.transactions.filter(entry => entry.revision !== 2);

  await assert.rejects(
    reconstructDocumentAt(repository, "project:1", 4),
    (error: unknown) => error instanceof HistoryReconstructionError && error.reason === "journal-gap",
  );
});

test("拒绝非法修订号", async () => {
  const { repository } = buildHistory(2);
  await assert.rejects(reconstructDocumentAt(repository, "project:1", -1), HistoryReconstructionError);
  await assert.rejects(reconstructDocumentAt(repository, "project:1", 1.5), HistoryReconstructionError);
});

class HistoryRepository implements ProjectRepository {
  snapshots = new Map<number, DesignDocument>();
  transactions: TransactionEntry[] = [];
  /** 重建基线：有它就能给"只剩日志"的那段历史当起点。 */
  baseline?: DesignDocument;

  async listSnapshots(): Promise<SnapshotSummary[]> {
    return [...this.snapshots.values()]
      .sort((left, right) => right.revision - left.revision)
      .map((document, index) => ({ revision: document.revision, updatedAt: document.meta.updatedAt, schemaVersion: document.schemaVersion, current: index === 0 }));
  }
  async readBaseline(): Promise<DesignDocument | undefined> {
    return this.baseline ? structuredClone(this.baseline) : undefined;
  }
  async readSnapshot(projectId: string, revision: number): Promise<DesignDocument> {
    const document = this.snapshots.get(revision);
    if (!document) throw new SnapshotNotFoundError(projectId, revision);
    return structuredClone(document);
  }
  async listTransactions(_projectId: string, afterRevision = 0): Promise<TransactionEntry[]> {
    return structuredClone(this.transactions.filter(entry => entry.revision > afterRevision));
  }

  async open(): Promise<ProjectSnapshot> { throw new Error("not used"); }
  async saveSnapshot(): Promise<void> { throw new Error("not used"); }
  async replaceProject(): Promise<void> { throw new Error("not used"); }
  async appendTransactions(): Promise<void> { throw new Error("not used"); }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> { throw new Error("not used"); }
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(): Promise<ProjectSnapshot> { throw new Error("not used"); }
  async listProjects(): Promise<ProjectSummary[]> { return []; }
  async deleteProject(): Promise<void> { throw new Error("not used"); }
  async pruneJournal(): Promise<number> { return 0; }
}
