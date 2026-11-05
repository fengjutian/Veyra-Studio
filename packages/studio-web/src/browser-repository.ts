import type { AssetWrite, ProjectRepository, ProjectSnapshot } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";

export class BrowserProjectRepository implements ProjectRepository {
  constructor(private readonly storage: Storage = localStorage) {}

  async open(projectId: string): Promise<ProjectSnapshot> {
    const key = this.documentKey(projectId);
    const document = this.read<DesignDocument>(key) ?? this.read<DesignDocument>(`${key}:pending`);
    if (!document) throw new Error(`Project ${projectId} does not exist`);
    return { document, recoveredFromRevision: document.revision, replayedTransactions: 0, latestKnownRevision: document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> {
    const key = this.documentKey(document.id);
    const serialized = JSON.stringify(document);
    this.storage.setItem(`${key}:pending`, serialized);
    this.storage.setItem(key, serialized);
    this.storage.removeItem(`${key}:pending`);
  }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    if (!entries[0]) return;
    if (entries.some(entry => entry.documentId !== entries[0]!.documentId)) throw new Error("A journal append cannot mix projects");
    const key = `studio:${entries[0].documentId}:transactions`;
    const existing = this.read<TransactionEntry[]>(key) ?? [];
    const revisions = new Set(existing.map(entry => entry.revision));
    for (const entry of entries) {
      if (revisions.has(entry.revision)) throw new Error(`Transaction revision ${entry.revision} already exists`);
      revisions.add(entry.revision);
    }
    this.storage.setItem(key, JSON.stringify([...existing, ...entries]));
  }
  async listTransactions(projectId: string): Promise<TransactionEntry[]> { return this.read(`studio:${projectId}:transactions`) ?? []; }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> { throw new Error("Browser assets are not implemented yet"); }
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }

  private documentKey(projectId: string): string { return `studio:${projectId}:document`; }

  private read<T>(key: string): T | undefined {
    const value = this.storage.getItem(key);
    if (value === null) return undefined;
    try { return JSON.parse(value) as T; }
    catch { return undefined; }
  }
}
