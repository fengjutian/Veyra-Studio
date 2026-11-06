import type { CommandEnvelope } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";
import type { SnapshotSummary } from "@ufira/design-persistence";

/**
 * 历史版本在面板上的一行。
 *
 * 这一层只做展示口径的转换，不碰存储也不碰运行时，方便单独测。
 */
export interface SnapshotRow {
  revision: number;
  /** 版本号，例如 "r12"。 */
  label: string;
  /** 这份快照落盘的时间。 */
  updatedAt: string;
  /** 这份快照存下来时的文档格式版本。 */
  schemaVersion: number;
  /** 是否是当前正在使用的版本。 */
  current: boolean;
  /** 当前版本自己不需要还原，所以只有旧版本可以点还原。 */
  restorable: boolean;
}

/**
 * 把存储给出的版本摘要变成面板上的行。
 *
 * 存储已经按从新到旧排好序，这里不再重排——重排会让"当前版本"标记和
 * 存储里的实际状态对不上。
 */
export function snapshotRows(summaries: SnapshotSummary[]): SnapshotRow[] {
  return summaries.map(summary => ({
    revision: summary.revision,
    label: `r${summary.revision}`,
    updatedAt: summary.updatedAt,
    schemaVersion: summary.schemaVersion,
    current: summary.current,
    restorable: !summary.current,
  }));
}

/**
 * 构造"还原到某个历史版本"的命令信封。
 *
 * 用的是运行时自带的 history.restore：旧版本的内容被写回当前文档，但修订号
 * 继续往前走（版本号不会倒退），并且照常往事务日志里记一笔——也就是说这次
 * 还原本身也能再撤销回去。
 *
 * 注意这里不直接覆写存储：覆写会把事务日志清掉，还原就变成不可撤销的动作了。
 */
export function restoreSnapshotEnvelope(current: DesignDocument, snapshot: DesignDocument, actorId = "local-user"): CommandEnvelope {
  if (snapshot.id !== current.id) throw new Error(`快照 ${snapshot.id} 与当前项目 ${current.id} 不是同一个项目`);
  return {
    commandId: `restore:${globalThis.crypto.randomUUID()}`,
    documentId: current.id,
    baseRevision: current.revision,
    actor: { type: "human", id: actorId },
    commands: [{ type: "history.restore", payload: { document: snapshot } }],
  };
}

/** 版本时间的展示格式：几月几号几点几分。 */
export function formatSnapshotTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 还原确认弹窗里的话。
 *
 * 说清楚三件事：回到哪一版、当前的改动去哪了、能不能撤销。
 */
export function restoreConfirmation(row: SnapshotRow): { title: string; description: string } {
  return {
    title: `还原到 ${row.label}`,
    description: `把项目内容还原到 ${row.label}（${formatSnapshotTime(row.updatedAt)}）？当前的改动会作为一次还原记入历史，随时可以撤销。`,
  };
}
