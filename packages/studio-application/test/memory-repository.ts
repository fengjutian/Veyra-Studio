import type { TransactionEntry } from "@ufira/design-runtime";
import type { DesignDocument } from "@ufira/design-schema";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";

/**
 * 内存里的项目仓库（测试用）。
 *
 * 单进程、无持久化，但接口与真实后端一致——测试里换掉后端不需要改调用方。
 */
export class MemoryRepository implements ProjectRepository {
  document?: DesignDocument;
  transactions: TransactionEntry[] = [];
  assets = new Map<string, Uint8Array>();

  async open(): Promise<ProjectSnapshot> {
    if (!this.document) throw new Error("missing");
    return {
      document: structuredClone(this.document),
      recoveredFromRevision: this.document.revision,
      replayedTransactions: 0,
      latestKnownRevision: this.document.revision,
      degraded: false,
    };
  }

  async saveSnapshot(document: DesignDocument): Promise<void> {
    this.document = structuredClone(document);
  }

  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    this.transactions.push(...structuredClone(entries));
  }

  async listTransactions(): Promise<TransactionEntry[]> {
    return structuredClone(this.transactions);
  }

  async replaceProject(_projectId: string, document: DesignDocument): Promise<void> {
    this.document = structuredClone(document);
    this.transactions = [];
    this.assets.clear();
  }

  async listProjects(): Promise<ProjectSummary[]> {
    if (!this.document) return [];
    return [{
      id: this.document.id,
      name: this.document.meta.name,
      revision: this.document.revision,
      updatedAt: this.document.meta.updatedAt,
    }];
  }

  async deleteProject(): Promise<void> {
    this.document = undefined;
    this.transactions = [];
    this.assets.clear();
  }

  async pruneJournal(): Promise<number> {
    return 0;
  }

  async listSnapshots(): Promise<SnapshotSummary[]> {
    if (!this.document) return [];
    return [{
      revision: this.document.revision,
      updatedAt: this.document.meta.updatedAt,
      schemaVersion: this.document.schemaVersion,
      current: true,
    }];
  }

  async readSnapshot(_projectId: string, revision: number): Promise<DesignDocument> {
    if (!this.document || this.document.revision !== revision) throw new SnapshotNotFoundError("project:1", revision);
    return structuredClone(this.document);
  }

  async putAsset(_projectId: string, write: AssetWrite): Promise<void> {
    this.assets.set(write.hash, new Uint8Array(write.bytes));
  }

  async getAsset(_projectId: string, hash: string): Promise<Uint8Array | undefined> {
    const bytes = this.assets.get(hash);
    return bytes ? new Uint8Array(bytes) : undefined;
  }

  async recover(projectId: string): Promise<ProjectSnapshot> {
    return this.open(projectId);
  }
}
