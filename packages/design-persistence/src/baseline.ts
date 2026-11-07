import { replayJournal, type SnapshotSummary } from "./contract";
import type { TransactionEntry } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";

/**
 * 重建基线。
 *
 * 事务日志按条数保留，快照按份数保留，两者的保留点并不对齐：日志可能还留着
 * 200 条，快照却只剩最近 10 份。于是"日志覆盖的版本"常常比"保留的快照"更宽，
 * 早于最老快照的那些步骤只剩日志、没有起点可以重放。
 *
 * 基线补的就是这个缺口：每个项目额外留一份**永不被裁剪**的文档，位置落在
 * "事务日志起点的前一版"。日志从它出发连续重放，每一条都能重建。
 *
 * 基线不是额外的备份，它是"重放的起点"——必须和日志起点严丝合缝地接上。所以
 * 每次裁日志之前，都要先把新的起点前一版重放出来固化成新基线，裁剪才安全。
 */

/** 仓库要支持基线，得能读写基线、列出并读取快照。 */
export interface BaselineRepository {
  readBaseline(projectId: string): Promise<DesignDocument | undefined>;
  writeBaseline(projectId: string, document: DesignDocument): Promise<void>;
  listSnapshots(projectId: string): Promise<SnapshotSummary[]>;
  readSnapshot(projectId: string, revision: number): Promise<DesignDocument>;
}

/**
 * 裁剪事务日志之前，先把"新的日志起点前一版"固化成基线。
 *
 * 返回裁剪后日志里最早的 revision，调用方据此删掉更早的日志；一条都不用删时
 * 返回当前最早的 revision。
 *
 * 裁剪的原则只有一条：**不能把还能重放出来的步骤裁没了**。所以基线接不上新的
 * 日志起点时，宁可少裁，也不留下断档。
 */
export async function prepareBaselinePrune(
  repository: BaselineRepository,
  projectId: string,
  entries: TransactionEntry[],
  keep: number,
): Promise<number> {
  const sorted = [...entries].sort((left, right) => left.revision - right.revision);
  const front = sorted[0]?.revision ?? -1;
  if (sorted.length <= keep) return front;

  // 新的日志起点：保留最近 keep 条，被裁掉的第一条就是它。
  const cutoff = sorted[sorted.length - keep]!.revision;

  let baseline = await repository.readBaseline(projectId);
  if (!baseline || baseline.revision < front - 1) {
    // 基线缺失，或者已经落在日志起点之前（日志被裁断过档，它接不上日志了）。
    // 换一份还能接上的快照当基线；一份都没有的话就只能按数量裁。
    const usable = await oldestUsableSnapshot(repository, projectId, front);
    if (!usable) return cutoff;
    baseline = usable;
    await repository.writeBaseline(projectId, usable);
  }

  // 基线比新的日志起点还新：它已经是更靠后的起点了，裁剪不影响它可用，只是
  // 基线与日志起点之间那几步仍然回不去。
  if (baseline.revision > cutoff - 1) return cutoff;

  const chain = sorted.filter(entry => entry.revision > baseline.revision && entry.revision <= cutoff - 1);
  const replay = replayJournal(baseline, chain);
  if (replay.document.revision === cutoff - 1) {
    // 重放到了新起点的前一版：固化成新基线，日志就能放心裁。
    await repository.writeBaseline(projectId, replay.document);
    return cutoff;
  }

  // 重放断档，基线到不了新的起点。只有基线还能接上当前日志起点时才值得少裁
  // 一点——否则日志会被永久卡住，越积越多。
  return baseline.revision >= front - 1 ? Math.min(cutoff, baseline.revision + 1) : cutoff;
}

/**
 * 找一份还接得上日志起点的快照：版本号不早于"日志起点前一版"的最老那一份。
 *
 * 拿它当基线，日志起点之后的部分就都能重放出来。
 */
async function oldestUsableSnapshot(repository: BaselineRepository, projectId: string, front: number): Promise<DesignDocument | undefined> {
  const snapshots = await repository.listSnapshots(projectId);
  // listSnapshots 从新到旧排；倒着找，第一份版本号够大的就是最老的那份。
  for (const summary of [...snapshots].reverse()) {
    if (summary.revision < front - 1) continue;
    try {
      return await repository.readSnapshot(projectId, summary.revision);
    } catch {
      // 这份快照读不出来（损坏或已被裁掉）：换下一份。
    }
  }
  return undefined;
}
