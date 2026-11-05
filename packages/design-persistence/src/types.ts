import type { DesignDocument } from "@ufira/design-schema";
import type { TransactionEntry } from "@ufira/design-runtime";

export interface AssetWrite {
  hash: string;
  bytes: Uint8Array;
}

export interface ProjectSnapshot {
  document: DesignDocument;
  recoveredFromRevision: number;
  latestKnownRevision: number;
  degraded: boolean;
}

export interface ProjectRepository {
  open(projectId: string): Promise<ProjectSnapshot>;
  saveSnapshot(document: DesignDocument): Promise<void>;
  appendTransactions(entries: TransactionEntry[]): Promise<void>;
  listTransactions(projectId: string, afterRevision?: number): Promise<TransactionEntry[]>;
  putAsset(projectId: string, asset: AssetWrite): Promise<void>;
  getAsset(projectId: string, hash: string): Promise<Uint8Array | undefined>;
  recover(projectId: string): Promise<ProjectSnapshot>;
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectNotFoundError";
  }
}
