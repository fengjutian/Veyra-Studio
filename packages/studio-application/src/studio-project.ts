import { exportPageToHtml, type HtmlExportOptions, type HtmlExportResult } from "@ufira/design-export";
import { computePageLayout, type LayoutOptions, type LayoutResult } from "@ufira/design-layout";
import type { ProjectRepository, ProjectSnapshot } from "@ufira/design-persistence";
import { DesignRuntime, type CommandEnvelope, type CommandResult, type TransactionEntry } from "@ufira/design-runtime";
import { createDocument, type DesignDocument } from "@ufira/design-schema";

export interface StudioExecuteResult {
  result: CommandResult;
  checkpointed: boolean;
  checkpointError?: string;
}

export interface StudioPreviewResult {
  before: DesignDocument;
  after: DesignDocument;
  result: CommandResult;
}

export interface OpenProjectResult {
  project: StudioProject;
  recovery: Omit<ProjectSnapshot, "document">;
}

export class StudioProject {
  private runtime: DesignRuntime;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly repository: ProjectRepository,
    document: DesignDocument,
  ) {
    this.runtime = new DesignRuntime(document);
  }

  static async create(repository: ProjectRepository, id: string, name: string, pageId?: string): Promise<StudioProject> {
    const document = createDocument(id, name, pageId);
    await repository.saveSnapshot(document);
    return new StudioProject(repository, document);
  }

  static async open(repository: ProjectRepository, id: string): Promise<OpenProjectResult> {
    const recovery = await repository.open(id);
    return {
      project: new StudioProject(repository, recovery.document),
      recovery: {
        recoveredFromRevision: recovery.recoveredFromRevision,
        replayedTransactions: recovery.replayedTransactions,
        latestKnownRevision: recovery.latestKnownRevision,
        degraded: recovery.degraded,
      },
    };
  }

  snapshot(): DesignDocument {
    return this.runtime.snapshot();
  }

  canUndo(): boolean { return this.runtime.canUndo(); }
  canRedo(): boolean { return this.runtime.canRedo(); }

  preview(envelope: CommandEnvelope): StudioPreviewResult {
    const before = this.runtime.snapshot();
    const previewRuntime = new DesignRuntime(before);
    const result = previewRuntime.execute(envelope);
    return { before, after: previewRuntime.snapshot(), result };
  }

  execute(envelope: CommandEnvelope): Promise<StudioExecuteResult> {
    return this.exclusive(async () => {
      const before = this.runtime.snapshot();
      const result = this.runtime.execute(envelope);
      const entry = this.lastTransaction();
      try {
        await this.repository.appendTransactions([entry]);
      } catch (error) {
        this.runtime = new DesignRuntime(before);
        throw error;
      }

      try {
        await this.repository.saveSnapshot(this.runtime.snapshot());
        return { result, checkpointed: true };
      } catch (error) {
        return { result, checkpointed: false, checkpointError: errorMessage(error) };
      }
    });
  }

  undo(actorId = "local-user"): Promise<StudioExecuteResult> { return this.applyHistory("undo", actorId); }
  redo(actorId = "local-user"): Promise<StudioExecuteResult> { return this.applyHistory("redo", actorId); }

  computeLayout(pageId: string, options: LayoutOptions): LayoutResult {
    return computePageLayout(this.runtime.snapshot(), pageId, options);
  }

  exportHtml(options: HtmlExportOptions): HtmlExportResult {
    return exportPageToHtml(this.runtime.snapshot(), options);
  }

  private lastTransaction(): TransactionEntry {
    const log = this.runtime.transactionLog();
    const entry = log.at(-1);
    if (!entry) throw new Error("Runtime committed without producing a transaction entry");
    return entry;
  }

  private applyHistory(direction: "undo" | "redo", actorId: string): Promise<StudioExecuteResult> {
    return this.exclusive(async () => {
      const before = this.runtime.snapshot();
      const result = this.runtime[direction]({ commandId: `${direction}:${globalThis.crypto.randomUUID()}`, actor: { type: "human", id: actorId } });
      const entry = this.lastTransaction();
      try { await this.repository.appendTransactions([entry]); }
      catch (error) { this.runtime = new DesignRuntime(before); throw error; }
      try { await this.repository.saveSnapshot(this.runtime.snapshot()); return { result, checkpointed: true }; }
      catch (error) { return { result, checkpointed: false, checkpointError: errorMessage(error) }; }
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
