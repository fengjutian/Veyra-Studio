import Dexie, { type EntityTable } from "dexie";
import type { AssetWrite, ProjectRepository, ProjectSnapshot } from "@ufira/design-persistence";
import { DesignRuntime, type TransactionEntry } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";

interface ProjectRecord { id: string; revision: number; updatedAt: string }
interface SnapshotRecord { projectId: string; revision: number; document: DesignDocument }
interface AssetRecord { projectId: string; hash: string; bytes: Uint8Array }
export interface StoredProjectSummary { id: string; name: string; revision: number; updatedAt: string }
interface StudioDatabase extends Dexie {
  projects: EntityTable<ProjectRecord, "id">;
  snapshots: EntityTable<SnapshotRecord, "projectId">;
  transactions: EntityTable<TransactionEntry, "revision">;
  assets: EntityTable<AssetRecord, "hash">;
}

export interface DexieRepositoryOptions { databaseName?: string; indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange }

export class BrowserProjectNotFoundError extends Error {
  constructor(projectId: string) { super(`Project ${projectId} does not exist`); this.name = "BrowserProjectNotFoundError"; }
}

export class DexieProjectRepository implements ProjectRepository {
  private readonly database: StudioDatabase;

  constructor(options: DexieRepositoryOptions = {}) {
    const database = new Dexie(options.databaseName ?? "ufira-design-studio", options.indexedDB ? { indexedDB: options.indexedDB, IDBKeyRange: options.IDBKeyRange } : undefined) as StudioDatabase;
    database.version(1).stores({ projects: "&id, updatedAt", snapshots: "&projectId, revision", transactions: "[documentId+revision], documentId, revision", assets: "[projectId+hash], projectId, hash" });
    this.database = database;
  }

  open(projectId: string): Promise<ProjectSnapshot> { return this.recover(projectId); }

  async saveSnapshot(document: DesignDocument): Promise<void> {
    await this.database.transaction("rw", this.database.projects, this.database.snapshots, async () => {
      await this.database.projects.put({ id: document.id, revision: document.revision, updatedAt: document.meta.updatedAt });
      await this.database.snapshots.put({ projectId: document.id, revision: document.revision, document: structuredClone(document) });
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
    const actualHash = await sha256(asset.bytes);
    if (actualHash !== asset.hash.toLowerCase()) throw new Error(`Asset hash mismatch: expected ${asset.hash}, received ${actualHash}`);
    await this.database.assets.put({ projectId, hash: actualHash, bytes: new Uint8Array(asset.bytes) });
  }

  async getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined> {
    const record = await this.database.assets.get([projectId, hash.toLowerCase()]);
    return record ? new Uint8Array(record.bytes) : undefined;
  }

  async recover(projectId: string): Promise<ProjectSnapshot> {
    const snapshot = await this.database.snapshots.get(projectId);
    if (!snapshot) throw new BrowserProjectNotFoundError(projectId);
    const entries = await this.listTransactions(projectId, snapshot.revision), runtime = new DesignRuntime(snapshot.document);
    let replayedTransactions = 0, degraded = false;
    for (const entry of entries) {
      if (entry.revision !== runtime.snapshot().revision + 1) { degraded = true; break; }
      try {
        runtime.execute({ commandId: entry.commandId, documentId: entry.documentId, baseRevision: runtime.snapshot().revision, actor: entry.actor, commands: entry.commands }, { committedAt: entry.committedAt });
        replayedTransactions += 1;
      } catch { degraded = true; break; }
    }
    const latestKnownRevision = Math.max(snapshot.revision, ...entries.map(entry => entry.revision));
    return { document: runtime.snapshot(), recoveredFromRevision: snapshot.revision, replayedTransactions, latestKnownRevision, degraded };
  }

  async listProjects(): Promise<StoredProjectSummary[]> {
    const snapshots = await this.database.snapshots.toArray();
    return snapshots.map(({ document }) => ({ id: document.id, name: document.meta.name, revision: document.revision, updatedAt: document.meta.updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.database.transaction("rw", this.database.projects, this.database.snapshots, this.database.transactions, this.database.assets, async () => {
      await this.database.projects.delete(projectId);
      await this.database.snapshots.delete(projectId);
      await this.database.transactions.where("documentId").equals(projectId).delete();
      await this.database.assets.where("projectId").equals(projectId).delete();
    });
  }

  close(): void { this.database.close(); }
  deleteDatabase(): Promise<void> { return this.database.delete(); }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
