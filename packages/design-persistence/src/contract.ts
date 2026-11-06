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

export interface JournalPruneOptions {
  /** 保留最近多少条事务；默认 {@link JOURNAL_RETENTION}。 */
  keep?: number;
}

export interface ProjectRepository {
  open(projectId: string): Promise<ProjectSnapshot>;
  saveSnapshot(document: DesignDocument): Promise<void>;
  appendTransactions(entries: TransactionEntry[]): Promise<void>;
  listTransactions(projectId: string, afterRevision?: number): Promise<TransactionEntry[]>;
  putAsset(projectId: string, asset: AssetWrite): Promise<void>;
  getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined>;
  recover(projectId: string): Promise<ProjectSnapshot>;
  listProjects(): Promise<ProjectSummary[]>;
  deleteProject(projectId: string): Promise<void>;
  /** 裁剪事务日志，返回被删除的条数。 */
  pruneJournal(projectId: string, options?: JournalPruneOptions): Promise<number>;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectNotFoundError";
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
