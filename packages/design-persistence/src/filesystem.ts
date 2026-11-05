import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateDocument, type DesignDocument } from "@ufira/design-schema";
import { DesignRuntime, type TransactionEntry } from "@ufira/design-runtime";
import { ProjectNotFoundError, type AssetWrite, type ProjectRepository, type ProjectSnapshot } from "./types";

interface Manifest {
  projectId: string;
  latestRevision: number;
  updatedAt: string;
}

export class FileSystemProjectRepository implements ProjectRepository {
  constructor(private readonly rootDirectory: string) {}

  async open(projectId: string): Promise<ProjectSnapshot> {
    return this.recover(projectId);
  }

  async saveSnapshot(document: DesignDocument): Promise<void> {
    const valid = validateDocument(document);
    const directory = this.projectDirectory(valid.id);
    const snapshots = join(directory, "snapshots");
    await mkdir(snapshots, { recursive: true });
    await mkdir(join(directory, "transactions"), { recursive: true });
    await mkdir(join(directory, "assets"), { recursive: true });

    const snapshotPath = join(snapshots, revisionFile(valid.revision));
    await writeExclusiveAtomic(snapshotPath, JSON.stringify(valid));
    await replaceAtomic(join(directory, "manifest.json"), JSON.stringify({
      projectId: valid.id,
      latestRevision: valid.revision,
      updatedAt: valid.meta.updatedAt,
    } satisfies Manifest));
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
    const actualHash = createHash("sha256").update(asset.bytes).digest("hex");
    if (actualHash !== asset.hash) throw new Error(`Asset hash mismatch: expected ${asset.hash}, received ${actualHash}`);
    const directory = join(this.projectDirectory(projectId), "assets");
    await mkdir(directory, { recursive: true });
    const target = join(directory, safeHash(asset.hash));
    try {
      await writeExclusiveAtomic(target, asset.bytes);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  async getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(join(this.projectDirectory(projectId), "assets", safeHash(hash)));
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
      try {
        const document = validateDocument(JSON.parse(await readFile(join(snapshots, file), "utf8")));
        if (document.id !== projectId) continue;
        const recoveredFromRevision = document.revision;
        const runtime = new DesignRuntime(document);
        const transactions = await this.listTransactions(projectId, recoveredFromRevision);
        let replayedTransactions = 0;
        for (const entry of transactions) {
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
        const recovered = runtime.snapshot();
        return {
          document: recovered,
          recoveredFromRevision,
          replayedTransactions,
          latestKnownRevision,
          degraded: recovered.revision !== latestKnownRevision,
        };
      } catch {
        // Fall through to the previous valid snapshot.
      }
    }
    throw new Error(`Project ${projectId} has no valid snapshots`);
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

function safeHash(hash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Asset hash must be a SHA-256 hex string");
  return hash.toLowerCase();
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
