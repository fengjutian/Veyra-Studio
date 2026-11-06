import { MigrationError, migrateDocument, validateDocument, type DesignDocument } from "@ufira/design-schema";
import { DesignRuntime, type TransactionEntry } from "@ufira/design-runtime";

/**
 * 项目存储的统一契约。
 *
 * 文件系统仓库和浏览器仓库实现的是同一套语义：同样的错误类型、同样的恢复
 * 规则、同样的保留策略。新增后端时只要实现这个接口，就能直接复用工作台和
 * 应用层，不需要再写一份"差不多但不太一样"的逻辑。
 */

export interface AssetWrite {
  hash: string;
  bytes: Uint8Array;
}

/** 项目列表里用到的摘要信息。 */
export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}

export interface ProjectSnapshot {
  document: DesignDocument;
  recoveredFromRevision: number;
  replayedTransactions: number;
  latestKnownRevision: number;
  /** 没能恢复到最新已知修订时为 true。 */
  degraded: boolean;
  /** 存储里的文档不是当前格式版本时，记录它原本的版本号。 */
  migratedFrom?: number;
}

/**
 * 历史版本摘要。
 *
 * 存储会保留最近几份快照，界面上要列出"可以回滚到哪一版"时只需要这些字段，
 * 不必把整份文档读出来。
 */
export interface SnapshotSummary {
  revision: number;
  updatedAt: string;
  /** 这份快照的文档格式版本；比当前版本旧说明它是迁移前留下的。 */
  schemaVersion: number;
  /** 是否是当前正在使用的版本。 */
  current: boolean;
}

export interface JournalPruneOptions {
  /** 保留最近多少条事务；默认 {@link JOURNAL_RETENTION}。 */
  keep?: number;
}

export interface ProjectRepository {
  open(projectId: string): Promise<ProjectSnapshot>;
  saveSnapshot(document: DesignDocument): Promise<void>;
  /**
   * 用给定文档整体替换一个项目的全部内容：旧快照、旧日志和旧资产都被清掉。
   *
   * 导入外部文件覆盖已有项目时必须走这里，而不是 saveSnapshot——旧日志会被
   * 重放到新内容上，旧快照也可能盖过新写入的那一份。
   */
  replaceProject(projectId: string, document: DesignDocument): Promise<void>;
  appendTransactions(entries: TransactionEntry[]): Promise<void>;
  listTransactions(projectId: string, afterRevision?: number): Promise<TransactionEntry[]>;
  putAsset(projectId: string, asset: AssetWrite): Promise<void>;
  getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined>;
  recover(projectId: string): Promise<ProjectSnapshot>;
  listProjects(): Promise<ProjectSummary[]>;
  deleteProject(projectId: string): Promise<void>;
  /** 裁剪事务日志，返回被删除的条数。 */
  pruneJournal(projectId: string, options?: JournalPruneOptions): Promise<number>;
  /**
   * 列出项目保留的历史版本，按 revision 从新到旧。
   *
   * 保留几份由各后端自己的保留策略决定，但两个后端的条数与顺序必须一致，
   * 否则同一个项目在两种存储下能回滚到的范围会不一样。
   */
  listSnapshots(projectId: string): Promise<SnapshotSummary[]>;
  /**
   * 读取某个历史版本的完整文档。
   *
   * 存储里的旧格式文档会在这里被迁移到当前格式——回滚要的是内容，
   * 不是把整个应用退回旧格式。版本不存在时抛 {@link SnapshotNotFoundError}。
   */
  readSnapshot(projectId: string, revision: number): Promise<DesignDocument>;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectNotFoundError";
  }
}

/**
 * 指定的历史版本不存在。
 *
 * 单独一种错误类型，调用方才能区分"项目没了"和"这一版已经被保留策略清掉"。
 */
export class SnapshotNotFoundError extends Error {
  constructor(projectId: string, revision: number) {
    super(`Snapshot r${revision} of project ${projectId} does not exist`);
    this.name = "SnapshotNotFoundError";
  }
}

/**
 * 存储里的数据无法变成当前格式的合法文档。
 *
 * 带上原始版本号，调用方才能告诉用户"这个项目来自更旧的版本"还是"这个文件
 * 根本不是设计文档"。
 */
export class DocumentLoadError extends Error {
  constructor(message: string, public readonly fromVersion?: number) {
    super(message);
    this.name = "DocumentLoadError";
  }
}

/** 事务日志默认保留条数：够覆盖一次长会话，又不至于让存储无限膨胀。 */
export const JOURNAL_RETENTION = 200;

/** 快照默认保留份数：最新一份加上可回滚的前几份。 */
export const SNAPSHOT_RETENTION = 3;

/**
 * 校验一份即将落盘的文档。
 *
 * 两个后端都走这个入口，保证"能存进去的文档"在两边是同一套标准。
 */
export function assertSavableDocument(document: DesignDocument): DesignDocument {
  return validateDocument(document);
}

/**
 * 把文档变成版本摘要。
 *
 * 两个后端用同一份口径，免得同一份数据在文件系统里显示的版本信息和在浏览器里
 * 显示的不一样。`schemaVersion` 可以显式传入存储里真实的格式版本——迁移前的
 * 旧文件读上来之后内容已经是当前格式，但界面上要如实说明它是哪一版留下的。
 */
export function snapshotSummary(document: DesignDocument, options: { current: boolean; schemaVersion?: number }): SnapshotSummary {
  return {
    revision: document.revision,
    updatedAt: document.meta.updatedAt,
    schemaVersion: options.schemaVersion ?? document.schemaVersion,
    current: options.current,
  };
}

/** 校验资产哈希，统一大小写写法。 */
export function normalizeAssetHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Asset hash must be a SHA-256 hex string");
  return hash.toLowerCase();
}

/**
 * 把存储里读出来的原始数据变成当前格式的文档。
 *
 * 这是恢复路径上的唯一入口：旧版本文档在这里被迁移，迁移不了就抛
 * {@link DocumentLoadError}，调用方据此提示用户，而不是让校验器报一句看不懂的
 * "expected 2"。
 */
export function loadDocumentPayload(raw: unknown, options: { now?: string } = {}): { document: DesignDocument; migratedFrom?: number } {
  try {
    const result = migrateDocument(raw, options);
    return {
      document: result.document,
      migratedFrom: result.fromVersion === result.toVersion ? undefined : result.fromVersion,
    };
  } catch (error) {
    if (error instanceof DocumentLoadError) throw error;
    const fromVersion = error instanceof MigrationError ? error.fromVersion : undefined;
    throw new DocumentLoadError(error instanceof Error ? error.message : String(error), fromVersion);
  }
}

export interface JournalReplay {
  document: DesignDocument;
  replayedTransactions: number;
  latestKnownRevision: number;
  degraded: boolean;
}

/**
 * 统一的日志重放语义。
 *
 * 从快照出发，按 revision 连续重放事务；遇到断档或重放失败就停下，并把
 * "恢复到哪一版"和"最新已知是哪一版"分别报出来。两个后端共用这一份实现，
 * 恢复行为因此不会因为换了存储而改变。
 */
export function replayJournal(snapshot: DesignDocument, entries: TransactionEntry[], options: { latestKnownRevision?: number } = {}): JournalReplay {
  const runtime = new DesignRuntime(snapshot);
  let replayedTransactions = 0;
  for (const entry of entries) {
    if (entry.revision !== runtime.snapshot().revision + 1) break;
    try {
      runtime.execute({
        commandId: entry.commandId,
        documentId: entry.documentId,
        baseRevision: runtime.snapshot().revision,
        actor: entry.actor,
        commands: entry.commands,
      }, { committedAt: entry.committedAt });
      replayedTransactions += 1;
    } catch {
      break;
    }
  }
  const document = runtime.snapshot();
  const latestKnownRevision = Math.max(
    snapshot.revision,
    options.latestKnownRevision ?? 0,
    ...entries.map(entry => entry.revision),
  );
  return { document, replayedTransactions, latestKnownRevision, degraded: document.revision !== latestKnownRevision };
}

/**
 * 判断一个写入错误是不是浏览器存储配额超限。
 *
 * 配额超限不能当成普通异常吞掉：用户需要知道"存不下了"，并去导出 JSON 备份。
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; code?: string | number; message?: string };
  if (candidate.name === "QuotaExceededError") return true;
  if (candidate.code === 22 || candidate.code === "QuotaExceededError") return true;
  return typeof candidate.message === "string" && /quota|storage.*full/i.test(candidate.message);
}
