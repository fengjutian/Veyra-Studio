import { exportPageToHtml, exportPageToSvg, type HtmlExportOptions, type HtmlExportResult, type SvgExportOptions, type SvgExportResult } from "@ufira/design-export";
import { computePageLayout, type LayoutOptions, type LayoutResult } from "@ufira/design-layout";
import type { ProjectRepository, ProjectSnapshot } from "@ufira/design-persistence";
import { DesignRuntime, type CommandEnvelope, type CommandResult, type TransactionEntry } from "@ufira/design-runtime";
import { createDocument, type DesignDocument } from "@ufira/design-schema";
import { preparePackageAssets, preparePackageFontFaces, type AssetPackage } from "./asset-package";
import { createAssetResolver } from "./assets";
import { dedupeByFeature, prepareFontFaces } from "./font-faces";

export interface StudioExecuteResult {
  result: CommandResult;
  checkpointed: boolean;
  checkpointError?: string;
}

/** 一次成功提交之后广播出去的事件。 */
export interface StudioCommitEvent {
  /** 提交后的修订号。 */
  revision: number;
  commandId: string;
  /** 这次提交包含的命令类型。 */
  commandTypes: string[];
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
  /**
   * 提交成功的监听者。
   *
   * 外部集成（MCP 的 SSE 推送）靠它知道「文档变了」——否则只能轮询。
   * 这只是**新增**的订阅入口，不改变任何已有路径的行为。
   */
  private readonly commitListeners = new Set<(event: StudioCommitEvent) => void>();

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

  /**
   * 订阅提交事件；返回取消订阅的函数。
   *
   * 只在**提交成功**之后触发——回滚了的事务不算数，否则外部会收到一条
   * 「文档变了」但其实没变的通知。
   */
  onCommit(listener: (event: StudioCommitEvent) => void): () => void {
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
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
        this.notifyCommitted({ revision: result.revision, commandId: envelope.commandId, commandTypes: envelope.commands.map(command => command.type) });
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

  exportSvg(options: SvgExportOptions): SvgExportResult {
    return exportPageToSvg(this.runtime.snapshot(), options);
  }

  /**
   * 导出 HTML，并把文档引用的图片资源一起交给导出器。
   *
   * 资源字节在仓库里，导出器却是同步接口，所以这里先异步读一遍、转成 data URL，
   * 再走原来的导出路径。调用方自己传了 `resolveAsset` 时以调用方为准。
   *
   * 字体同理：文档声明过的字体会被内联进 `@font-face`，交付物因此自带字体，
   * 对方机器上没装这个字体也不会走回退字形。
   */
  async exportHtmlWithAssets(options: HtmlExportOptions): Promise<HtmlExportResult> {
    const document = this.runtime.snapshot();
    const resolveAsset = options.resolveAsset ?? await createAssetResolver(this.repository, document, options.pageId, options.nodeIds);
    const fonts = options.fontFaces
      ? { css: options.fontFaces.join("\n"), diagnostics: [] }
      : await prepareFontFaces(this.repository, document, options);
    const result = exportPageToHtml(document, { ...options, resolveAsset, fontFaces: fonts.css ? [fonts.css] : [] });
    return { ...result, diagnostics: dedupeByFeature([...result.diagnostics, ...fonts.diagnostics]) };
  }

  /**
   * 导出成**资源包**：主文档 + 图片/字体文件，文档里用相对路径引用。
   *
   * 与 {@link exportHtmlWithAssets} 的差别是「内联」与「外链」：
   * 内联产出单个自包含 HTML，体积涨约 33%，字体超过 1 MB 就只能放弃；
   * 外链产出一个包，体积不涨、字体不受内联上限约束，代价是交付物不再
   * 是单个文件。规格见 `docs/asset-packaging.md`。
   *
   * 注意：包里的相对路径要落盘后才解析得了，所以这个产物**不能**直接塞进
   * 预览弹窗（预览用的是内联版）。
   */
  async exportHtmlPackage(options: HtmlExportOptions): Promise<AssetPackage> {
    const document = this.runtime.snapshot();
    const images = await preparePackageAssets(this.repository, document, options.pageId, options.nodeIds);
    const fonts = await preparePackageFontFaces(this.repository, document, options);
    const result = exportPageToHtml(document, {
      ...options,
      resolveAsset: options.resolveAsset ?? images.resolveAsset,
      fontFaces: fonts.css ? [fonts.css] : [],
    });
    return {
      document: result.document,
      files: [...images.files, ...fonts.files],
      diagnostics: dedupeByFeature([...result.diagnostics, ...fonts.diagnostics]),
    };
  }

  /**
   * 导出 SVG，并把文档引用的图片资源一起交给导出器。
   *
   * 资源与字体的处理同 {@link exportHtmlWithAssets}：图片转成 data URL，
   * 字体转成 `@font-face` 规则写进 SVG 里的 `<style>`——
   * 浏览器里 SVG 的内联 `@font-face` 是生效的（实测见 `docs/font-inline.md` §8.2）。
   */
  async exportSvgWithAssets(options: SvgExportOptions): Promise<SvgExportResult> {
    const document = this.runtime.snapshot();
    const resolveAsset = options.resolveAsset ?? await createAssetResolver(this.repository, document, options.pageId, options.nodeIds);
    const fonts = options.fontFaces
      ? { css: options.fontFaces.join("\n"), diagnostics: [] }
      : await prepareFontFaces(this.repository, document, options);
    const result = exportPageToSvg(document, { ...options, resolveAsset, fontFaces: fonts.css ? [fonts.css] : [] });
    return { ...result, diagnostics: dedupeByFeature([...result.diagnostics, ...fonts.diagnostics]) };
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
      try {
        await this.repository.saveSnapshot(this.runtime.snapshot());
        this.notifyCommitted({ revision: result.revision, commandId: entry.commandId, commandTypes: entry.commands.map(command => command.type) });
        return { result, checkpointed: true };
      } catch (error) { return { result, checkpointed: false, checkpointError: errorMessage(error) }; }
    });
  }

  /** 广播提交事件；一个监听者出错不影响其他人。 */
  private notifyCommitted(event: StudioCommitEvent): void {
    for (const listener of [...this.commitListeners]) {
      try {
        listener(event);
      } catch {
        // 监听者的问题不该让提交本身失败——提交已经落库了。
      }
    }
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
