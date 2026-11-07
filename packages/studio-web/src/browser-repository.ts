import Dexie, { type EntityTable, type Table } from "dexie";
import {
  JOURNAL_RETENTION,
  ProjectNotFoundError,
  SNAPSHOT_RETENTION,
  SnapshotNotFoundError,
  assertSavableDocument,
  estimateJsonBytes,
  loadDocumentPayload,
  normalizeAssetHash,
  replayJournal,
  snapshotSummary,
  type AssetWrite,
  type JournalPruneOptions,
  type ProjectRepository,
  type ProjectSnapshot,
  type ProjectStorageUsage,
  type ProjectSummary,
  type SnapshotSummary,
} from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { detectSchemaVersion, type DesignDocument } from "@ufira/design-schema";

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
  assets: Table<AssetRecord, [string, string]>;
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

  /**
   * 整体替换一个项目：清掉旧快照、旧日志和旧资产，再写入新内容。
   *
   * 必须先清空再写——旧快照的 revision 可能比新文档高，残留下来会被恢复流程
   * 选中，旧日志也会被重放到新内容上。
   */
  async replaceProject(projectId: string, document: DesignDocument): Promise<void> {
    const valid = assertSavableDocument(document);
    if (valid.id !== projectId) throw new Error(`Replacement document id ${valid.id} does not match project ${projectId}`);
    await this.database.transaction("rw", this.database.projects, this.database.snapshots, this.database.snapshotHistory, this.database.transactions, this.database.assets, async () => {
      await this.database.projects.delete(projectId);
      await this.database.snapshots.delete(projectId);
      await this.database.snapshotHistory.where("projectId").equals(projectId).delete();
      await this.database.transactions.where("documentId").equals(projectId).delete();
      await this.database.assets.where("projectId").equals(projectId).delete();
      await this.database.projects.put({ id: valid.id, revision: valid.revision, updatedAt: valid.meta.updatedAt, name: valid.meta.name });
      await this.database.snapshots.put({ projectId: valid.id, revision: valid.revision, document: structuredClone(valid) });
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

  async deleteAsset(projectId: string, hash: string): Promise<void> {
    await this.database.assets.delete([projectId, normalizeAssetHash(hash)]);
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

  /**
   * 列出保留的历史版本。
   *
   * 当前版本在 snapshots 表里，旧版本在 snapshotHistory 表里；同一个 revision
   * 可能两边都有（迁移升级时留下的旧格式副本），当前版本优先。
   */
  async listSnapshots(projectId: string): Promise<SnapshotSummary[]> {
    const current = await this.database.snapshots.get(projectId);
    const history = await this.database.snapshotHistory.where("projectId").equals(projectId).sortBy("revision");
    const byRevision = new Map<number, SnapshotSummary>();
    for (const record of history) byRevision.set(record.revision, describeSnapshot(record));
    if (current) byRevision.set(current.revision, describeSnapshot(current));
    return [...byRevision.values()]
      .sort((left, right) => right.revision - left.revision)
      .map((item, index) => ({ ...item, current: index === 0 }));
  }

  /** 读取某个历史版本的完整文档；存储里的旧格式在这里被迁移到当前格式。 */
  async readSnapshot(projectId: string, revision: number): Promise<DesignDocument> {
    const current = await this.database.snapshots.get(projectId);
    const record = current?.revision === revision ? current : await this.database.snapshotHistory.get([projectId, revision]);
    if (!record) throw new SnapshotNotFoundError(projectId, revision);
    const { document } = loadDocumentPayload(record.document);
    if (document.id !== projectId) throw new SnapshotNotFoundError(projectId, revision);
    return document;
  }

  /**
   * 统计这个项目占用的空间。
   *
   * IndexedDB 里存的是结构化克隆，拿不到"落盘后的字节数"，所以这里用序列化后的
   * UTF-8 长度做估算——和文件系统后端同一套口径，两个后端的数字才可比。
   */
  async inspectStorage(projectId: string): Promise<ProjectStorageUsage> {
    const current = await this.database.snapshots.get(projectId);
    const history = await this.database.snapshotHistory.where("projectId").equals(projectId).toArray();
    const entries = await this.database.transactions.where("documentId").equals(projectId).toArray();
    const assets = await this.database.assets.where("projectId").equals(projectId).toArray();
    const snapshotBytes = estimateJsonBytes(current?.document) + history.reduce((sum, record) => sum + estimateJsonBytes(record.document), 0);
    const journalBytes = entries.reduce((sum, entry) => sum + estimateJsonBytes(entry), 0);
    const assetBytes = assets.reduce((sum, record) => sum + record.bytes.byteLength, 0);
    return {
      projectId,
      projectName: current?.document.meta.name ?? "",
      snapshotBytes,
      journalBytes,
      assetBytes,
      totalBytes: snapshotBytes + journalBytes + assetBytes,
      historyCount: history.length,
      assetCount: assets.length,
    };
  }

  /**
   * 把历史版本裁到只剩最近 `keep` 份（当前版本不算在内）。
   *
   * 旧的先删——保留的历史版本越新越有价值。
   */
  async trimSnapshots(projectId: string, keep: number): Promise<number> {
    const target = Math.max(0, keep);
    const history = await this.database.snapshotHistory.where("projectId").equals(projectId).sortBy("revision");
    const outdated = history.slice(0, Math.max(0, history.length - target));
    for (const record of outdated) await this.database.snapshotHistory.delete([record.projectId, record.revision]);
    return outdated.length;
  }

  close(): void { this.database.close(); }  deleteDatabase(): Promise<void> { return this.database.delete(); }

  /** 底层数据库句柄：供迁移测试和运维检查直接读写原始数据。 */
  get storage(): StudioDatabase { return this.database; }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/** 把一条快照记录变成版本摘要。 */
function describeSnapshot(record: SnapshotRecord): SnapshotSummary {
  return snapshotSummary(record.document, { current: false, schemaVersion: detectSchemaVersion(record.document) ?? 0 });
}
