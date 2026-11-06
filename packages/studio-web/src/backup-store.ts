import Dexie, { type Table } from "dexie";
import type { DesignDocument } from "@ufira/design-schema";

/**
 * 自动备份。
 *
 * 快照和事务日志解决的是"同一次会话/同一份浏览器存储里的崩溃恢复"，但用户
 * 误删项目、清空站点数据、换浏览器时它们跟着一起消失。自动备份把最近的几份
 * 完整文档另存一张表，保留固定份数、按时间轮转，不参与文档事务。
 */

export const BACKUP_RETENTION = 3;

/** 两次自动备份之间的最小间隔：10 分钟。 */
export const BACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface BackupRecord {
  projectId: string;
  createdAt: string;
  revision: number;
  name: string;
  /** 文档 JSON 的字节数，用来在界面上给个体积概念。 */
  byteLength: number;
  document: DesignDocument;
}

export interface BackupSummary {
  projectId: string;
  createdAt: string;
  revision: number;
  name: string;
  byteLength: number;
}

export interface ProjectBackupStoreOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
  IDBKeyRange?: typeof IDBKeyRange;
}

interface BackupDatabase extends Dexie {
  backups: Table<BackupRecord, [string, string]>;
}

/**
 * 判断这一刻要不要写备份。
 *
 * 自动保存很频繁（每次停止输入都会落盘），备份不能跟着每次都写，否则轮转
 * 表里全是一分钟内的三份副本。第一次没有备份时立刻写，之后按最小间隔节流。
 */
export function shouldWriteBackup(last: { createdAt: string } | undefined, now: Date, minIntervalMs = BACKUP_MIN_INTERVAL_MS): boolean {
  if (!last) return true;
  const lastTime = Date.parse(last.createdAt);
  if (Number.isNaN(lastTime)) return true;
  return now.getTime() - lastTime >= minIntervalMs;
}

/** 文档 JSON 的字节数；备份列表用它显示体积。 */
export function backupByteLength(document: DesignDocument): number {
  return new TextEncoder().encode(JSON.stringify(document)).byteLength;
}

/** 备份摘要变成界面上的行。 */
export function backupRows(summaries: BackupSummary[]): Array<BackupSummary & { label: string }> {
  return summaries.map(summary => ({ ...summary, label: `r${summary.revision} · ${summary.name}` }));
}

/** 还原备份前的确认文案：说清回到哪一刻、当前改动还能不能撤销。 */
export function backupRestoreConfirmation(row: BackupSummary & { label?: string }): { title: string; description: string } {
  return {
    title: `还原备份 r${row.revision}`,
    description: `把项目内容还原到 ${new Date(row.createdAt).toLocaleString()} 自动保存的备份？当前的改动会作为一次还原记入历史，随时可以撤销。`,
  };
}

export class ProjectBackupStore {
  private readonly database: BackupDatabase;

  constructor(options: ProjectBackupStoreOptions = {}) {
    const database = new Dexie(options.databaseName ?? "ufira-design-studio-backups", options.indexedDB ? { indexedDB: options.indexedDB, IDBKeyRange: options.IDBKeyRange } : undefined) as BackupDatabase;
    database.version(1).stores({ backups: "[projectId+createdAt], projectId, createdAt" });
    this.database = database;
  }

  /** 写一份备份，并按保留策略裁掉最旧的几份。 */
  async write(document: DesignDocument, options: { keep?: number; now?: string } = {}): Promise<BackupSummary> {
    const record: BackupRecord = {
      projectId: document.id,
      createdAt: options.now ?? new Date().toISOString(),
      revision: document.revision,
      name: document.meta.name,
      byteLength: backupByteLength(document),
      document: structuredClone(document),
    };
    await this.database.backups.put(record);
    await this.prune(document.id, options.keep ?? BACKUP_RETENTION);
    return summaryOf(record);
  }

  /** 某个项目的备份，按时间从新到旧。 */
  async list(projectId: string): Promise<BackupSummary[]> {
    const records = await this.database.backups.where("projectId").equals(projectId).toArray();
    return records
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(summaryOf);
  }

  /** 读回某份备份的完整文档。 */
  async read(projectId: string, createdAt: string): Promise<DesignDocument> {
    const record = await this.database.backups.get([projectId, createdAt]);
    if (!record) throw new Error(`备份 ${projectId}@${createdAt} 不存在`);
    return structuredClone(record.document);
  }

  /** 只保留最新的 `keep` 份，返回删除的条数。 */
  async prune(projectId: string, keep = BACKUP_RETENTION): Promise<number> {
    const records = await this.database.backups.where("projectId").equals(projectId).toArray();
    const stale = records
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(Math.max(0, keep));
    for (const record of stale) await this.database.backups.delete([record.projectId, record.createdAt]);
    return stale.length;
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.database.backups.where("projectId").equals(projectId).delete();
  }

  close(): void { this.database.close(); }
  deleteDatabase(): Promise<void> { return this.database.delete(); }
  get storage(): BackupDatabase { return this.database; }
}

/** 工作台默认使用的备份库。 */
export const backupStore = new ProjectBackupStore();

function summaryOf(record: BackupRecord): BackupSummary {
  return { projectId: record.projectId, createdAt: record.createdAt, revision: record.revision, name: record.name, byteLength: record.byteLength };
}
