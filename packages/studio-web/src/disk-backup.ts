/**
 * 磁盘备份（导出到用户选的目录）。
 *
 * 浏览器的 IndexedDB 备份解决的是「误删项目 / 撤销过头」，但清空站点数据、
 * 换浏览器、磁盘损坏时它跟着一起消失。磁盘备份把完整文档另存到用户自己的
 * 目录里，是唯一能跨浏览器、跨设备带走的形态。
 *
 * 这个模块**只有纯逻辑与可注入的目录端口**：
 *
 * - 文件名怎么起、怎么排序；
 * - 多久写一次（节流）；
 * - 保留几份、删哪几份（轮转）；
 * - 失败怎么上报。
 *
 * 真正的落盘在 `disk-backup-browser.ts`（File System Access API），
 * 因此这里可以在 Node 里用假目录跑完整行为测试。加密与跨设备同步不在范围内：
 * 前者需要密钥管理，后者需要服务端。
 */

import type { DesignDocument } from "@ufira/design-schema";

/** 两次磁盘备份之间的最小间隔。比内存备份紧一点：磁盘备份是用户主动开启的。 */
export const DISK_BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;

/** 每个项目在备份目录里保留的份数。 */
export const DISK_BACKUP_RETENTION = 10;

/** 备份文件名前缀：目录里可能还有用户的其它文件，轮转只碰自己写的。 */
export const DISK_BACKUP_PREFIX = "ufira-backup-";

/** 一份备份的落点。 */
export interface BackupDirectoryPort {
  /** 目录显示名（界面上告诉用户存到哪了）。 */
  readonly name: string;
  write(name: string, contents: string): Promise<void>;
  /** 目录下的文件名列表。 */
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

/**
 * 写盘前的编码步骤（目前只有加密）。
 *
 * 抽象成一个端口而不是把加密写进来：这个模块只管「什么时候写、写到哪、留几份」，
 * 加密是另一件事（`backup-crypto.ts`），两者用这个接口解耦，纯逻辑层照样能在
 * Node 里用假编码器跑完整行为测试。
 */
export interface BackupContentEncoder {
  /** 把明文内容变成最终落盘的内容。 */
  encode(plain: string): Promise<string>;
}

/** 备份状态。 */
export type DiskBackupState =
  /** 已接上目录，但这次会话还没有写过。 */
  | "idle"
  | "disabled"
  /** 还在节流窗口内，这次没有写。 */
  | "throttled"
  | "saved"
  | "error";

export interface DiskBackupStatus {
  state: DiskBackupState;
  /** 最近一次成功写入的时间（ISO）。 */
  lastSavedAt?: string;
  /** 刚写下的文件名。 */
  fileName?: string;
  /** 目录里这个项目的备份份数（含刚写的）。 */
  files?: number;
  /** 失败原因（人话）。 */
  error?: string;
}

/** 项目名 → 文件名安全的片段：只留字母数字与 `-_.`，其余折成 `-`。 */
export function backupProjectSlug(projectId: string): string {
  const slug = projectId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "project";
}

/** 紧凑时间戳：`20261109T121957Z`，按字典序即按时间序。 */
function timestamp(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
}

/**
 * 备份文件名。
 *
 * 时间戳在前、revision 在后：同一项目的文件按名字排序就是按时间排序，
 * 轮转不需要读文件内容。
 */
export function backupFileName(projectId: string, revision: number, now: Date): string {
  const safeRevision = Math.max(0, Math.trunc(revision));
  return `${DISK_BACKUP_PREFIX}${backupProjectSlug(projectId)}-${timestamp(now)}-r${safeRevision}.json`;
}

/**
 * 备份文件名的形状：`前缘 + 项目片段 + 时间戳 + revision`。
 *
 * 项目片段允许包含 `-`，所以用固定宽度的时间戳来定界——否则 `a-b` 这样的
 * 项目名会切错位置，轮转就会删错文件。
 */
const BACKUP_NAME_PATTERN = /^ufira-backup-(.+)-(\d{8}T\d{6}Z)-r(\d+)\.json$/;

/** 文件名是否由本模块生成。 */
export function isBackupFileName(name: string): boolean {
  return BACKUP_NAME_PATTERN.test(name);
}

/** 从文件名解析出它属于哪个项目；不是备份文件时返回 `undefined`。 */
export function backupFileProjectSlug(name: string): string | undefined {
  return BACKUP_NAME_PATTERN.exec(name)?.[1];
}

/**
 * 轮转：只保留最新的 `keep` 份，返回要删掉的文件名。
 *
 * 只处理**同一个项目**的备份文件；目录里别的文件（包括别的项目的备份）
 * 一律不碰——删用户的文件是不可逆的。
 */
export function planBackupRotation(files: readonly string[], options: { keep?: number; projectId?: string } = {}): string[] {
  const keep = Math.max(0, Math.trunc(options.keep ?? DISK_BACKUP_RETENTION));
  const slug = options.projectId === undefined ? undefined : backupProjectSlug(options.projectId);
  const relevant = files.filter(name => isBackupFileName(name) && (slug === undefined || backupFileProjectSlug(name) === slug));
  if (relevant.length <= keep) return [];
  return [...relevant].sort((left, right) => left.localeCompare(right)).slice(0, relevant.length - keep);
}

/**
 * 这一刻要不要写备份。
 *
 * 自动保存很频繁；磁盘备份按时间节流，否则目录里全是一分钟内的副本。
 * 第一次（没有记录）立即写。
 */
export function shouldWriteDiskBackup(lastSavedAt: string | undefined, now: Date, minIntervalMs = DISK_BACKUP_MIN_INTERVAL_MS): boolean {
  if (!lastSavedAt) return true;
  const last = Date.parse(lastSavedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= minIntervalMs;
}

/**
 * 磁盘备份的执行器。
 *
 * 不抛错：自动保存链路上的失败不能把编辑器带崩，状态里带 `error` 由界面展示。
 */
export class DiskBackupRunner {
  private directory: BackupDirectoryPort | undefined;
  private lastSavedAt: string | undefined;
  private readonly now: () => Date;
  private readonly keep: number;
  private readonly minIntervalMs: number;
  /** 编码步骤可以中途换（开/关加密），所以不是 readonly。 */
  private encoder: BackupContentEncoder | undefined;

  constructor(options: { now?: () => Date; keep?: number; minIntervalMs?: number; encoder?: BackupContentEncoder } = {}) {
    this.now = options.now ?? (() => new Date());
    this.keep = options.keep ?? DISK_BACKUP_RETENTION;
    this.minIntervalMs = options.minIntervalMs ?? DISK_BACKUP_MIN_INTERVAL_MS;
    this.encoder = options.encoder;
  }

  /**
   * 换掉编码步骤（开/关加密）。
   *
   * 换掉的是**已落盘文件的形态**，不是已写出的文件：目录里旧的明文备份不会被
   * 追溯加密（要加密只能重新写一份），这一点在界面上要说清楚。
   */
  setEncoder(encoder: BackupContentEncoder | undefined): void {
    this.encoder = encoder;
  }

  /** 当前备份目录（未启用时为 undefined）。 */
  get target(): BackupDirectoryPort | undefined {
    return this.directory;
  }

  /** 最近一次成功写入时间（可用于跨会话恢复节流状态）。 */
  get lastSaved(): string | undefined {
    return this.lastSavedAt;
  }

  /** 接上/断开备份目录。 */
  use(directory: BackupDirectoryPort | undefined): void {
    this.directory = directory;
  }

  /** 恢复上次会话的节流状态。 */
  restoreLastSavedAt(lastSavedAt: string | undefined): void {
    this.lastSavedAt = lastSavedAt;
  }

  /**
   * 写一份备份（默认按节流判断）。
   *
   * `force` 用于「立即备份」按钮：用户明确要求时不该被节流挡住。
   */
  async backup(document: DesignDocument, options: { force?: boolean } = {}): Promise<DiskBackupStatus> {
    const directory = this.directory;
    if (!directory) return { state: "disabled" };

    const now = this.now();
    if (!options.force && !shouldWriteDiskBackup(this.lastSavedAt, now, this.minIntervalMs)) {
      return { state: "throttled", lastSavedAt: this.lastSavedAt };
    }

    const fileName = backupFileName(document.id, document.revision, now);
    try {
      // 编码（加密）在写盘前发生：编码失败与写入失败一样，只落到 error 状态，
      // 不推进 lastSavedAt —— 下一次自动保存会重试。
      const plain = JSON.stringify(document);
      const contents = this.encoder ? await this.encoder.encode(plain) : plain;
      await directory.write(fileName, contents);
      const files = await directory.list();
      const stale = planBackupRotation(files, { keep: this.keep, projectId: document.id });
      for (const name of stale) await directory.remove(name);
      this.lastSavedAt = now.toISOString();
      const slug = backupProjectSlug(document.id);
      const remaining = files.filter(name => backupFileProjectSlug(name) === slug && !stale.includes(name));
      return {
        state: "saved",
        lastSavedAt: this.lastSavedAt,
        fileName,
        // 目录里这个项目还剩几份（刚写的那份一定在里面）。
        files: Math.max(1, remaining.length),
      };
    } catch (error) {
      return {
        state: "error",
        error: error instanceof Error ? error.message : String(error),
        lastSavedAt: this.lastSavedAt,
      };
    }
  }
}
