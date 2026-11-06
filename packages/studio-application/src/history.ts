import { replayJournal, type ProjectRepository } from "@ufira/design-persistence";
import type { DesignDocument } from "@ufira/design-schema";

/**
 * 把项目还原到"某一次事务之后的那个状态"。
 *
 * 快照只能回滚到保留的那几份，事务日志却保留了最近几百条。要回到一个没有快照
 * 的中间版本，就从**不晚于目标 revision 的最近一份快照**出发，按顺序重放事务，
 * 直到目标 revision。
 *
 * 这个过程不写存储：调用方拿到文档后自己走 `history.restore`，这样回退本身
 * 也是一次可撤销的事务。
 */

export type HistoryReconstructionFailure = "base-missing" | "journal-gap";

export class HistoryReconstructionError extends Error {
  constructor(message: string, public readonly reason: HistoryReconstructionFailure) {
    super(message);
    this.name = "HistoryReconstructionError";
  }
}

export interface ReconstructedHistory {
  document: DesignDocument;
  /** 从快照之后重放了事务条数；目标正好是快照时为 0。 */
  replayedTransactions: number;
  /** 这次重建用到的快照 revision。 */
  baseRevision: number;
}

export async function reconstructDocumentAt(repository: ProjectRepository, projectId: string, revision: number): Promise<ReconstructedHistory> {
  if (!Number.isInteger(revision) || revision < 0) throw new HistoryReconstructionError(`无效的修订号 ${revision}`, "journal-gap");

  const snapshots = await repository.listSnapshots(projectId);
  const base = snapshots
    .filter(snapshot => snapshot.revision <= revision)
    .sort((left, right) => right.revision - left.revision)[0];
  if (!base) {
    throw new HistoryReconstructionError(
      `要回到 r${revision}，但保留的快照都晚于这一版，起点已经被清理掉了`,
      "base-missing",
    );
  }

  const document = await repository.readSnapshot(projectId, base.revision);
  if (document.revision === revision) return { document, replayedTransactions: 0, baseRevision: base.revision };

  const entries = (await repository.listTransactions(projectId, base.revision))
    .filter(entry => entry.revision <= revision)
    .sort((left, right) => left.revision - right.revision);
  // replayJournal 遇到断档会停下并把实际到达的 revision 报出来，这里据此判断能不能精确回到目标。
  const replay = replayJournal(document, entries, { latestKnownRevision: revision });
  if (replay.document.revision !== revision) {
    throw new HistoryReconstructionError(
      `从 r${base.revision} 重放事务只到 r${replay.document.revision}，到不了 r${revision}；对应的事务日志可能已被裁剪`,
      "journal-gap",
    );
  }
  return { document: replay.document, replayedTransactions: replay.replayedTransactions, baseRevision: base.revision };
}
