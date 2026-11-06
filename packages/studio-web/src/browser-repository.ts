import Dexie, { type EntityTable, type Table } from "dexie";
import {
  JOURNAL_RETENTION,
  ProjectNotFoundError,
  SNAPSHOT_RETENTION,
  assertSavableDocument,
  loadDocumentPayload,
  normalizeAssetHash,
  replayJournal,
  type AssetWrite,
  type JournalPruneOptions,
  type ProjectRepository,
  type ProjectSnapshot,
  type ProjectSummary,
} from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";

interface ProjectRecord { id: string; revision: number; updatedAt: string; name: string }
interface SnapshotRecord { projectId: string; revision: number; document: DesignDocument }
interface AssetRecord { projectId: string; hash: string; bytes: Uint8Array }

/** 项目列表摘要；与仓库契约里的 {@link ProjectSummary} 是同一个形状。 */
export type StoredProjectSummary = ProjectSummary;

interface StudioDatabase extends Dexie {
  projects: EntityTable<ProjectRecord, "id">;
  snapshots: EntityTable<SnapshotRecord, "projectId">;
  snapshotHistory: Table<SnapshotRecord, [string, number]>;
  transactions: Table<TransactionEntry, [string, number]>;
  assets: Table<AssetRecord, [string, number]>;
}

export interface DexieRepositoryOptions { databaseName?: string; indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange }

/** 浏览器侧的"项目不存在"。它继承统一契约里的同名错误，调用方只需捕获一种类型。 */
export class BrowserProjectNotFoundError extends ProjectNotFoundError {
  constructor(projectId: string) { super(projectId); this.name = "BrowserProjectNotFoundError"; }
}

/**
 * 浏览器存储格式版本。
 *
 * 2 新增 `snapshotHistory` 表：当前快照仍在 `snapshots` 里，旧版本留在历史表，
 * 于是同一项目可以保留最近几份快照用于回滚，旧格式的原始快照也不会被迁移
 * 覆盖掉。IndexedDB 不允许在升级时改表的主键，所以新增表而不是改主键。
 */
export const BROWSER_STORAGE_VERSION = 2;

export class DexieProjectRepository implements ProjectRepository {
  private readonly database: StudioDatabase;

  constructor(options: DexieRepositoryOptions = {}) {
    const database = new Dexie(options.databaseName ?? "ufira-design-studio", options.indexedDB ? { indexedDB: options.indexedDB, IDBKeyRange: options.IDBKeyRange } : undefined) as StudioDatabase;
    database.version(1).stores({ projects: "&id, updatedAt", snapshots: "&projectId, revision", transactions: "[documentId+revision], documentId, revision", assets: "[projectId+hash], projectId, hash" });
    database.version(2).stores({ projects: "&id, updatedAt", snapshots: "&projectId, revision", snapshotHistory: "[projectId+revision], projectId, revision", transactions: "[documentId+revision], documentId, revision", assets: "[projectId+hash], projectId, hash" });
    this.database = database;
  }

  open(projectId: string): Promise<ProjectSnapshot> { return this.recover(projectId); }

  async saveSnapshot(document: DesignDocument): Promise<void> {
    const valid = assertSavableDocument(document);
    await this.database.transaction("rw", this.database.projects, this.database.snapshots, this.database.snapshotHistory, async () => {
      // 覆盖前先把上一份快照挪进历史表：迁移升级和普通保存都因此留有退路。
      const previous = await this.database.snapshots.get(valid.id);
      if (previous) await this.database.snapshotHistory.put({ projectId: valid.id, revision: previous.revision, document: previous.document });
      await this.database.projects.put({ id: valid.id, revision: valid.revision, updatedAt: valid.meta.updatedAt, name: valid.meta.name });
      await this.database.snapshots.put({ projectId: valid.id, revision: valid.revision, document: structuredClone(valid) });
      const history = await this.database.snapshotHistory.where("projectId").equals(valid.id).sortBy("revision");
      for (const stale of history.slice(0, Math.max(0, history.length - (SNAPSHOT_RETENTION - 1)))) {
        await this.database.snapshotHistory.delete([stale.projectId, stale.revision]);
      }
    });
  }

  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    if (!entries.length) return;
    const projectId = entries[0]!.documentId;
    if (entries.some(entry => entry.documentId !== projectId)) throw new Error("A journal append cannot mix projects");
    await this.database.transaction("rw", this.database.transactions, async () => { for (const entry of entries) await this.database.transactions.add(structuredClone(entry)); });
  }

  async listTransactions(projectId: string, afterRevision = 0): Promise<TransactionEntry[]> {
    return this.database.transactions.where("documentId").equals(projectId).filter(entry => entry.revision > afterRevision).sortBy("revision");
  }

  async putAsset(projectId: string, asset: AssetWrite): Promise<void> {
    const hash = normalizeAssetHash(asset.hash);
    const actualHash = await sha256(asset.bytes);
    if (actualHash !== hash) throw new Error(`Asset hash mismatch: expected ${hash}, received ${actualHash}`);
    await this.database.assets.put({ projectId, hash: actualHash, bytes: new Uint8Array(asset.bytes) });
  }

  async getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined> {
    const record = await this.database.assets.get([projectId, normalizeAssetHash(hash)]);
    return record ? new Uint8Array(record.bytes) : undefined;
  }

  async recover(projectId: string): Promise<ProjectSnapshot> {
    const current = await this.database.snapshots.get(projectId);
    const history = await this.database.snapshotHistory.where("projectId").equals(projectId).sortBy("revision");
    const candidates = [...(current ? [current] : []), ...history].sort((left, right) => right.revision - left.revision);
    if (!candidates.length) throw new BrowserProjectNotFoundError(projectId);
    const newest = candidates[0]!;
    const { document, migratedFrom } = loadDocumentPayload(newest.document);
    // 迁移过的文档立刻按新格式落盘，原始快照留在历史表里，随时可以退回。
    if (migratedFrom !== undefined) await this.saveSnapshot(document);
    const entries = await this.listTransactions(projectId, document.revision);
    const replay = replayJournal(document, entries);
    return {
      document: replay.document,
      recoveredFromRevision: document.revision,
      replayedTransactions: replay.replayedTransactions,
      latestKnownRevision: replay.latestKnownRevision,
      degraded: replay.degraded,
      migratedFrom,
    };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const snapshots = await this.database.snapshots.toArray();
    const newestByProject = new Map<string, SnapshotRecord>();
    for (const snapshot of snapshots) {
      const current = newestByProject.get(snapshot.projectId);
      if (!current || current.revision < snapshot.revision) newestByProject.set(snapshot.projectId, snapshot);
    }
    return [...newestByProject.values()]
      .map(({ document }) => ({ id: document.id, name: document.meta.name, revision: document.revision, updatedAt: document.meta.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.database.transaction("rw", this.database.projects, this.database.snapshots, this.database.snapshotHistory, this.database.transactions, this.database.assets, async () => {
      await this.database.projects.delete(projectId);
      await this.database.snapshots.delete(projectId);
      await this.database.snapshotHistory.where("projectId").equals(projectId).delete();
      await this.database.transactions.where("documentId").equals(projectId).delete();
      await this.database.assets.where("projectId").equals(projectId).delete();
    });
  }

  async pruneJournal(projectId: string, options: JournalPruneOptions = {}): Promise<number> {
    const keep = Math.max(0, options.keep ?? JOURNAL_RETENTION);
    const entries = await this.listTransactions(projectId);
    if (entries.length <= keep) return 0;
    const cutoff = entries[entries.length - keep]!.revision;
    return this.database.transactions.where("documentId").equals(projectId).and(entry => entry.revision < cutoff).delete();
  }

  close(): void { this.database.close(); }
  deleteDatabase(): Promise<void> { return this.database.delete(); }

  /** 底层数据库句柄：供迁移测试和运维检查直接读写原始数据。 */
  get storage(): StudioDatabase { return this.database; }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
