import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectSchemaVersion, type DesignDocument } from "@ufira/design-schema";
import type { TransactionEntry } from "@ufira/design-runtime";
import {
  JOURNAL_RETENTION,
  ProjectNotFoundError,
  SNAPSHOT_RETENTION,
  SnapshotNotFoundError,
  assertSavableDocument,
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
} from "./contract";
import { prepareBaselinePrune } from "./baseline";

/**
 * 项目存储布局的版本。
 *
 * 1 是最初版本：manifest 只记 projectId / latestRevision / updatedAt。
 * 2 补上 storageVersion 与 documentSchemaVersion，让"这份数据是哪个布局、哪个
 * 文档格式写下来的"可以被查出来。
 */
export const STORAGE_VERSION = 2;

/**
 * 基线快照的文件名。
 *
 * 它放在 snapshots 目录里，但**不叫版本号**：快照目录里只有 `^\d{12}\.json$`
 * 才算一个版本，所以这份文件不会被版本列表算进去，也不会被裁剪策略删掉——
 * 基线必须永远留着。
 */
const BASELINE_FILE = "baseline.json";

interface Manifest {
  projectId: string;
  name: string;
  latestRevision: number;
  updatedAt: string;
  storageVersion?: number;
  documentSchemaVersion?: number;
}

export class FileSystemProjectRepository implements ProjectRepository {
  constructor(private readonly rootDirectory: string) {}

  async open(projectId: string): Promise<ProjectSnapshot> {
    return this.recover(projectId);
  }

  async saveSnapshot(document: DesignDocument): Promise<void> {
    const valid = assertSavableDocument(document);
    const directory = this.projectDirectory(valid.id);
    const snapshots = join(directory, "snapshots");
    await mkdir(snapshots, { recursive: true });
    await mkdir(join(directory, "transactions"), { recursive: true });
    await mkdir(join(directory, "assets"), { recursive: true });

    // 同一 revision 可能被迁移后的文档重写，所以这里用替换语义而不是独占创建。
    await replaceAtomic(join(snapshots, revisionFile(valid.revision)), JSON.stringify(valid));
    await replaceAtomic(join(directory, "manifest.json"), JSON.stringify({
      projectId: valid.id,
      name: valid.meta.name,
      latestRevision: valid.revision,
      updatedAt: valid.meta.updatedAt,
      storageVersion: STORAGE_VERSION,
      documentSchemaVersion: valid.schemaVersion,
    } satisfies Manifest));
    await this.ensureBaseline(valid.id, directory);
    await this.pruneSnapshots(directory);
  }

  /**
   * 整体替换一个项目：先删掉整个项目目录，再写入新内容。
   *
   * 必须先清空再写——旧快照的 revision 可能比新文档高，残留下来会被恢复流程
   * 选中，旧日志也会被重放到新内容上。
   */
  async replaceProject(projectId: string, document: DesignDocument): Promise<void> {
    const valid = assertSavableDocument(document);
    if (valid.id !== projectId) throw new Error(`Replacement document id ${valid.id} does not match project ${projectId}`);
    await rm(this.projectDirectory(projectId), { recursive: true, force: true });
    await this.saveSnapshot(valid);
  }

  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    for (const entry of entries) {
      const directory = join(this.projectDirectory(entry.documentId), "transactions");
      await mkdir(directory, { recursive: true });
      await writeExclusiveAtomic(join(directory, revisionFile(entry.revision)), JSON.stringify(entry));
    }
  }

  async listTransactions(projectId: string, afterRevision = -1): Promise<TransactionEntry[]> {
    const directory = join(this.projectDirectory(projectId), "transactions");
    const files = await safeReadDirectory(directory);
    const entries: TransactionEntry[] = [];
    for (const file of files.filter(isRevisionFile).sort()) {
      try {
        const entry = JSON.parse(await readFile(join(directory, file), "utf8")) as TransactionEntry;
        if (entry.documentId === projectId && entry.revision > afterRevision) entries.push(entry);
      } catch {
        // Ignore incomplete or corrupt journal records; snapshots remain authoritative.
      }
    }
    return entries;
  }

  async putAsset(projectId: string, asset: AssetWrite): Promise<void> {
    const hash = normalizeAssetHash(asset.hash);
    const actualHash = createHash("sha256").update(asset.bytes).digest("hex");
    if (actualHash !== hash) throw new Error(`Asset hash mismatch: expected ${hash}, received ${actualHash}`);
    const directory = join(this.projectDirectory(projectId), "assets");
    await mkdir(directory, { recursive: true });
    const target = join(directory, hash);
    try {
      await writeExclusiveAtomic(target, asset.bytes);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  async getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(join(this.projectDirectory(projectId), "assets", normalizeAssetHash(hash)));
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async deleteAsset(projectId: string, hash: string): Promise<void> {
    try {
      await unlink(join(this.projectDirectory(projectId), "assets", normalizeAssetHash(hash)));
    } catch (error: any) {
      // 字节本来就不在，等价于已经删掉了。
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async recover(projectId: string): Promise<ProjectSnapshot> {
    const directory = this.projectDirectory(projectId);
    const snapshots = join(directory, "snapshots");
    const files = (await safeReadDirectory(snapshots)).filter(isRevisionFile).sort().reverse();
    if (!files.length) throw new ProjectNotFoundError(projectId);

    const manifest = await readManifest(join(directory, "manifest.json"));
    const transactionFiles = (await safeReadDirectory(join(directory, "transactions"))).filter(isRevisionFile);
    const latestKnownRevision = Math.max(
      manifest?.latestRevision ?? -1,
      ...files.map(parseRevision),
      ...transactionFiles.map(parseRevision),
    );

    for (const file of files) {
      const raw = await readFile(join(snapshots, file), "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      try {
        const { document, migratedFrom } = loadDocumentPayload(JSON.parse(raw));
        if (document.id !== projectId) continue;
        const recoveredFromRevision = document.revision;
        // 迁移过的文档立刻按新格式落盘，原始文件留一份备份，随时可以退回。
        if (migratedFrom !== undefined) await this.writeMigratedSnapshot(directory, document, raw);
        const transactions = await this.listTransactions(projectId, recoveredFromRevision);
        const replay = replayJournal(document, transactions, { latestKnownRevision });
        return {
          document: replay.document,
          recoveredFromRevision,
          replayedTransactions: replay.replayedTransactions,
          latestKnownRevision: replay.latestKnownRevision,
          degraded: replay.degraded,
          migratedFrom,
        };
      } catch {
        // Fall through to the previous valid snapshot.
      }
    }
    throw new Error(`Project ${projectId} has no valid snapshots`);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const directories = await safeReadDirectory(this.rootDirectory);
    const summaries: ProjectSummary[] = [];
    for (const entry of directories) {
      const directory = join(this.rootDirectory, entry);
      const manifest = await readManifest(join(directory, "manifest.json"));
      if (manifest) {
        summaries.push({ id: manifest.projectId, name: manifest.name ?? "", revision: manifest.latestRevision, updatedAt: manifest.updatedAt });
        continue;
      }
      const snapshots = join(directory, "snapshots");
      const files = (await safeReadDirectory(snapshots)).filter(isRevisionFile).sort().reverse();
      if (!files.length) continue;
      const document = await readFile(join(snapshots, files[0]!), "utf8").then(raw => JSON.parse(raw) as DesignDocument).catch(() => undefined);
      if (!document) continue;
      summaries.push({ id: document.id, name: document.meta.name, revision: document.revision, updatedAt: document.meta.updatedAt });
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async deleteProject(projectId: string): Promise<void> {
    await rm(this.projectDirectory(projectId), { recursive: true, force: true });
  }

  async pruneJournal(projectId: string, options: JournalPruneOptions = {}): Promise<number> {
    const directory = join(this.projectDirectory(projectId), "transactions");
    const files = (await safeReadDirectory(directory)).filter(isRevisionFile).sort();
    const keep = Math.max(0, options.keep ?? JOURNAL_RETENTION);
    if (files.length <= keep) return 0;
    // 裁之前先把"新的日志起点前一版"固化成基线：日志敢裁，靠的是这份基线。
    const entries = await this.listTransactions(projectId);
    const front = await prepareBaselinePrune(this, projectId, entries, keep);
    const outdated = files.filter(file => parseRevision(file) < front);
    for (const file of outdated) await rm(join(directory, file), { force: true });
    return outdated.length;
  }

  /** 读取重建基线；没有基线（老项目或后端不支持）时返回 undefined。 */
  async readBaseline(projectId: string): Promise<DesignDocument | undefined> {
    const raw = await readFile(this.baselinePath(projectId), "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const { document } = loadDocumentPayload(JSON.parse(raw));
      return document.id === projectId ? document : undefined;
    } catch {
      return undefined;
    }
  }

  /** 固化重建基线；这份文档永不被裁剪。 */
  async writeBaseline(projectId: string, document: DesignDocument): Promise<void> {
    const valid = assertSavableDocument(document);
    const directory = join(this.projectDirectory(projectId), "snapshots");
    await mkdir(directory, { recursive: true });
    await replaceAtomic(join(directory, BASELINE_FILE), JSON.stringify(valid));
  }

  /**
   * 列出保留的快照版本。
   *
   * snapshots 目录里每一份文件就是一个版本，文件名上的 revision 越大越新，
   * 所以最新的一份就是当前版本。坏掉的文件直接跳过，不让整个列表查不出来。
   */
  async listSnapshots(projectId: string): Promise<SnapshotSummary[]> {
    const directory = join(this.projectDirectory(projectId), "snapshots");
    const files = (await safeReadDirectory(directory)).filter(isRevisionFile).sort().reverse();
    const summaries: SnapshotSummary[] = [];
    for (const file of files) {
      const stored = await this.readSnapshotFile(join(directory, file));
      if (!stored) continue;
      summaries.push(snapshotSummary(stored.document, { current: false, schemaVersion: stored.schemaVersion }));
    }
    if (summaries.length) summaries[0]!.current = true;
    return summaries;
  }

  /** 读取某个历史版本的完整文档；存储里的旧格式在这里被迁移到当前格式。 */
  async readSnapshot(projectId: string, revision: number): Promise<DesignDocument> {
    const directory = join(this.projectDirectory(projectId), "snapshots");
    const stored = await this.readSnapshotFile(join(directory, revisionFile(revision)));
    if (!stored || stored.document.id !== projectId) throw new SnapshotNotFoundError(projectId, revision);
    return stored.document;
  }

  /**
   * 统计这个项目占用的空间。
   *
   * 文件系统这边能拿到文件的真实字节数，所以快照和日志都按磁盘上的实际大小算，
   * 只有资源字节是内容本身的长度（同一个 hash 只存一份）。
   */
  async inspectStorage(projectId: string): Promise<ProjectStorageUsage> {
    const directory = this.projectDirectory(projectId);
    const manifest = await readManifest(join(directory, "manifest.json"));
    const snapshotBytes = await sumFileSizes(join(directory, "snapshots"));
    const journalBytes = await sumFileSizes(join(directory, "transactions"));
    const assetBytes = await sumFileSizes(join(directory, "assets"));
    const historyCount = (await safeReadDirectory(join(directory, "snapshots"))).filter(isRevisionFile).length;
    const assetCount = (await safeReadDirectory(join(directory, "assets"))).length;
    const name = manifest?.name ?? (await this.projectName(projectId)) ?? "";
    return {
      projectId,
      projectName: name,
      snapshotBytes,
      journalBytes,
      assetBytes,
      totalBytes: snapshotBytes + journalBytes + assetBytes,
      historyCount: Math.max(0, historyCount - 1),
      assetCount,
    };
  }

  /**
   * 把历史版本裁到只剩最近 `keepVersions` 个版本（**含当前版本**）。
   *
   * 文件名上的 revision 越大越新，所以从旧到新删；当前版本是最新的一份，永远保留。
   */
  async trimSnapshots(projectId: string, keepVersions: number): Promise<number> {
    const snapshots = join(this.projectDirectory(projectId), "snapshots");
    const files = (await safeReadDirectory(snapshots)).filter(isRevisionFile).sort().reverse();
    // 至少留 1 份：当前版本不能被裁掉。
    const outdated = files.slice(Math.max(1, keepVersions));
    for (const file of outdated) await rm(join(snapshots, file), { force: true });
    return outdated.length;
  }

  /** 读不出 manifest 时回退到最新快照里的项目名。 */
  private async projectName(projectId: string): Promise<string | undefined> {
    const snapshots = join(this.projectDirectory(projectId), "snapshots");
    const files = (await safeReadDirectory(snapshots)).filter(isRevisionFile).sort().reverse();
    for (const file of files) {
      const stored = await this.readSnapshotFile(join(snapshots, file));
      if (stored) return stored.document.meta.name;
    }
    return undefined;
  }

  /**
   * 确保这个项目有一份重建基线。
   *
   * 基线只补一次：项目建立时的第一份快照就是最合适的起点，之后由裁日志的流程
   * 往前推进。已经在更早版本里建过基线的项目，这里不会覆盖它。
   */
  private async ensureBaseline(projectId: string, directory: string): Promise<void> {
    if (await fileExists(join(directory, "snapshots", BASELINE_FILE))) return;
    // 用最老的那份保留快照当基线：越早的起点，能重建的步骤越多。
    const oldest = await this.oldestSnapshotRevision(directory);
    if (oldest === undefined) return;
    const document = await this.readSnapshot(projectId, oldest).catch(() => undefined);
    if (document) await this.writeBaseline(projectId, document);
  }

  /** 快照目录里最老的那个版本号。 */
  private async oldestSnapshotRevision(directory: string): Promise<number | undefined> {
    const files = (await safeReadDirectory(join(directory, "snapshots"))).filter(isRevisionFile);
    if (!files.length) return undefined;
    return files.map(parseRevision).sort((left, right) => left - right)[0];
  }

  private baselinePath(projectId: string): string {
    return join(this.projectDirectory(projectId), "snapshots", BASELINE_FILE);
  }

  private async readSnapshotFile(path: string): Promise<{ document: DesignDocument; schemaVersion: number } | undefined> {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const payload = JSON.parse(raw) as unknown;
      // 存的是哪个格式版本，和读出来的是哪个格式版本，是两件事：迁移前的
      // 旧文件迁上来之后内容一样，但界面上要如实告诉用户它是哪一版留下的。
      return { document: loadDocumentPayload(payload).document, schemaVersion: detectSchemaVersion(payload) ?? 0 };
    } catch {
      return undefined;
    }
  }

  private async writeMigratedSnapshot(directory: string, document: DesignDocument, original: string): Promise<void> {
    const backups = join(directory, "backups");
    await mkdir(backups, { recursive: true });
    await writeExclusiveAtomic(join(backups, revisionFile(document.revision)), original);
    await this.saveSnapshot(document);
  }

  private async pruneSnapshots(directory: string): Promise<void> {
    const snapshots = join(directory, "snapshots");
    const files = (await safeReadDirectory(snapshots)).filter(isRevisionFile).sort().reverse();
    for (const file of files.slice(SNAPSHOT_RETENTION)) await rm(join(snapshots, file), { force: true });
  }

  private projectDirectory(projectId: string): string {
    return join(this.rootDirectory, encodeURIComponent(projectId));
  }
}

function revisionFile(revision: number): string {
  if (!Number.isInteger(revision) || revision < 0) throw new Error(`Invalid revision ${revision}`);
  return `${revision.toString().padStart(12, "0")}.json`;
}

function isRevisionFile(file: string): boolean {
  return /^\d{12}\.json$/.test(file);
}

function parseRevision(file: string): number {
  return Number.parseInt(file.slice(0, 12), 10);
}

async function safeReadDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

/** 文件在不在；读不出来一律当"不在"。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录下所有文件的字节数之和；目录不存在时算 0。 */
async function sumFileSizes(directory: string): Promise<number> {  const files = await safeReadDirectory(directory);
  let total = 0;
  for (const file of files) {
    const stats = await stat(join(directory, file)).catch(() => undefined);
    if (stats?.isFile()) total += stats.size;
  }
  return total;
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

async function writeExclusiveAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function replaceAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const backup = `${path}.bak`;
  await writeFile(temporary, data, { flag: "wx" });
  await rm(backup, { force: true });
  try {
    await rename(path, backup);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, path);
    await rm(backup, { force: true });
  } catch (error) {
    try { await rename(backup, path); } catch { /* best-effort restore */ }
    await rm(temporary, { force: true });
    throw error;
  }
}
