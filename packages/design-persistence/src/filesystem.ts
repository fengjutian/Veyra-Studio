import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DesignDocument } from "@ufira/design-schema";
import type { TransactionEntry } from "@ufira/design-runtime";
import {
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
} from "./contract";

/**
 * 项目存储布局的版本。
 *
 * 1 是最初版本：manifest 只记 projectId / latestRevision / updatedAt。
 * 2 补上 storageVersion 与 documentSchemaVersion，让"这份数据是哪个布局、哪个
 * 文档格式写下来的"可以被查出来。
 */
export const STORAGE_VERSION = 2;

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
    await this.pruneSnapshots(directory);
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
    const keep = Math.max(0, options.keep ?? SNAPSHOT_RETENTION);
    const outdated = files.slice(0, Math.max(0, files.length - keep));
    for (const file of outdated) await rm(join(directory, file), { force: true });
    return outdated.length;
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
