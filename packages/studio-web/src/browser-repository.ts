import type { AssetWrite, ProjectRepository, ProjectSnapshot } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";

export class BrowserProjectRepository implements ProjectRepository {
  constructor(private readonly storage: Storage = localStorage) {}

  async open(projectId: string): Promise<ProjectSnapshot> {
    const document = this.read<DesignDocument>(`studio:${projectId}:document`);
    if (!document) throw new Error(`Project ${projectId} does not exist`);
    return { document, recoveredFromRevision: document.revision, replayedTransactions: 0, latestKnownRevision: document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> {
    this.storage.setItem(`studio:${document.id}:document`, JSON.stringify(document));
  }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    if (!entries[0]) return;
    const key = `studio:${entries[0].documentId}:transactions`;
    this.storage.setItem(key, JSON.stringify([...this.read<TransactionEntry[]>(key, []), ...entries]));
  }
  async listTransactions(projectId: string): Promise<TransactionEntry[]> { return this.read(`studio:${projectId}:transactions`, []); }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> { throw new Error("Browser assets are not implemented yet"); }
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }

  private read<T>(key: string, fallback?: T): T {
    const value = this.storage.getItem(key);
    if (value === null) {
      if (fallback !== undefined) return fallback;
      return undefined as T;
    }
    return JSON.parse(value) as T;
  }
}
