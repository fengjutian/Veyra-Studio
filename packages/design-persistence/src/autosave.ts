import {
  JOURNAL_RETENTION,
  isQuotaExceededError,
  type AssetWrite,
  type JournalPruneOptions,
  type ProjectRepository,
} from "./contract";
import type { DesignDocument } from "@ufira/design-schema";
import type { TransactionEntry } from "@ufira/design-runtime";

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutosaveStatus {
  state: AutosaveState;
  /** 最近一次成功落盘的时间。 */
  lastSavedAt?: string;
  /** 最近一次失败的说明。 */
  lastError?: string;
  /** 失败是不是因为浏览器存储配额满了。 */
  quotaExceeded: boolean;
  /** 还有多少个项目的快照在等着落盘。 */
  pendingCount: number;
}

export interface AutosaveOptions {
  /** 合并写入的等待时间，默认 800ms。 */
  delayMs?: number;
  /** 状态变化回调，用于界面提示。 */
  onStatusChange?: (status: AutosaveStatus) => void;
  /** 每次成功落盘后保留多少条事务日志。 */
  journalRetention?: number;
}

export interface AutosaveRepository extends ProjectRepository {
  /** 立刻把待写快照落盘；没有待写内容时什么都不做。 */
  flush(): Promise<void>;
  /** 当前自动保存状态。 */
  readonly status: AutosaveStatus;
}

interface PendingWrite {
  document: DesignDocument;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * 给仓库套一层自动保存。
 *
 * 事务日志仍然是即时写入的（那是恢复的依据），被延迟的是快照：连续几次编辑
 * 只落一份盘，既避免每敲一下就写一次完整文档，也让"上次编辑"和"磁盘上的
 * 内容"之间的差距保持可预期。
 *
 * 每个项目的第一份快照会立刻写入——否则新建的项目在第一次落盘前就关闭，
 * 存储里根本没有这个项目，恢复时会直接报"项目不存在"。
 */
export function withAutosave(repository: ProjectRepository, options: AutosaveOptions = {}): AutosaveRepository {
  const delayMs = options.delayMs ?? 800;
  const journalRetention = options.journalRetention ?? JOURNAL_RETENTION;
  const pending = new Map<string, PendingWrite>();
  const written = new Set<string>();
  let status: AutosaveStatus = { state: "idle", quotaExceeded: false, pendingCount: 0 };

  // 所有写入排成一条队：晚到的旧快照不能盖掉先到的新快照。
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };

  const publish = (next: Partial<AutosaveStatus>) => {
    status = { ...status, ...next, pendingCount: pending.size };
    options.onStatusChange?.(status);
  };

  const write = async (projectId: string, document: DesignDocument): Promise<void> => {
    publish({ state: "saving" });
    try {
      await repository.saveSnapshot(document);
      written.add(projectId);
      publish({ state: "saved", lastSavedAt: new Date().toISOString(), lastError: undefined, quotaExceeded: false });
      try {
        await repository.pruneJournal(projectId, { keep: journalRetention });
      } catch {
        // 日志裁剪失败不影响已经落盘的快照。
      }
    } catch (error) {
      publish({ state: "error", lastError: error instanceof Error ? error.message : String(error), quotaExceeded: isQuotaExceededError(error) });
      throw error;
    }
  };

  const schedule = (projectId: string, document: DesignDocument) => {
    const existing = pending.get(projectId);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: PendingWrite = { document };
    entry.timer = setTimeout(() => {
      // 计划可能已经被更新的那次编辑取代，这时不再重复落盘。
      if (pending.get(projectId) !== entry) return;
      pending.delete(projectId);
      publish({ pendingCount: pending.size });
      void enqueue(() => write(projectId, document)).catch(() => undefined);
    }, delayMs);
    pending.set(projectId, entry);
    publish({ state: "pending" });
  };

  const autosave: AutosaveRepository = {
    open: projectId => repository.open(projectId),
    recover: projectId => repository.recover(projectId),
    listTransactions: (projectId, afterRevision) => repository.listTransactions(projectId, afterRevision),
    listProjects: () => repository.listProjects(),
    deleteProject: projectId => repository.deleteProject(projectId),
    putAsset: (projectId, asset: AssetWrite) => repository.putAsset(projectId, asset),
    getAsset: (projectId, hash) => repository.getAsset(projectId, hash),
    appendTransactions: (entries: TransactionEntry[]) => repository.appendTransactions(entries),

    async saveSnapshot(document: DesignDocument): Promise<void> {
      // 第一个项目的第一份快照必须立刻落盘，否则新建的项目在落盘前关闭就找不回来了。
      if (!written.has(document.id)) {
        written.add(document.id);
        await enqueue(() => write(document.id, document));
        return;
      }
      schedule(document.id, document);
    },

    async pruneJournal(projectId: string, pruneOptions?: JournalPruneOptions): Promise<number> {
      return repository.pruneJournal(projectId, pruneOptions);
    },

    async flush(): Promise<void> {
      const entries = [...pending.entries()];
      for (const [projectId, entry] of entries) {
        if (entry.timer) clearTimeout(entry.timer);
        pending.delete(projectId);
      }
      publish({ pendingCount: pending.size });
      for (const [projectId, entry] of entries) {
        try {
          await enqueue(() => write(projectId, entry.document));
        } catch (error) {
          // 写失败就把文档放回队列，等下一次冲刷再试，不让编辑内容凭空消失。
          pending.set(projectId, { document: entry.document });
          publish({ state: "error", pendingCount: pending.size });
          throw error;
        }
      }
      await queue;
    },

    get status(): AutosaveStatus {
      return status;
    },
  };

  return autosave;
}
