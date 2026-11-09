import { exportPageToHtml, type ExportDiagnostic } from "@ufira/design-export";
import { collectContrastIssues } from "@ufira/studio-application";
import { lintDocument, type AssetMetadata, type DesignDocument, type LintCode, type NodeId } from "@ufira/design-schema";

/**
 * 自查（体检）层：把几个已经各自成型的检查器聚成**一份**可执行、可回喂给模型的报告。
 *
 * 分散的检查器已经齐了（设计 lint、对比度、导出诊断），缺的是把它们汇到一起，
 * 让编排循环能回答两个问题：
 *
 * 1. 现在还有哪些问题没修？（待修清单）
 * 2. 上一轮改完之后，还剩哪些？（用来判断"有没有进展"）
 *
 * 报告里每个结论都带一个**稳定指纹**（来源 + 代码 + 节点 id）。指纹在多轮之间
 * 保持不变，是编排循环判断"同一个问题是不是还在"和"模型是不是在原地打转"的
 * 唯一依据——用消息文本比对是不行的，模型每轮的说法都不一样。
 */

/** 结论来自哪个检查器。 */
export type SelfCheckSource = "lint" | "contrast" | "export";

export type SelfCheckSeverity = "error" | "warning" | "info";

export interface SelfCheckIssue {
  source: SelfCheckSource;
  /** 来源内部的细分代码，例如 lint 的 `off-grid`、对比度的 `low-contrast`。 */
  code: string;
  severity: SelfCheckSeverity;
  message: string;
  nodeId?: NodeId;
  detail?: string;
  /**
   * 是否计入「待修项」。
   *
   * 导出诊断里的 `approximated`（比如椭圆渐变的旋转角丢失）是**说明**而不是缺陷：
   * 交付物能看，只是和设计稿有出入，让模型去"修"它只会制造无意义的改动。
   */
  actionable: boolean;
}

export interface SelfCheckReport {
  issues: SelfCheckIssue[];
  counts: { error: number; warning: number; info: number; actionable: number };
  /** 待修项指纹，去重且有序。 */
  fingerprints: string[];
}

/** 一次体检的上下文：报告本身，加上「已经判定修不动」的清单。 */
export interface SelfCheckContext {
  report: SelfCheckReport;
  /** 判定为「修不动」的指纹；模型不该再试这些。 */
  stuck: readonly string[];
  /**
   * 补充说明：上一轮做了什么、还剩多少项。
   *
   * 轮次上下文是**系统**说的话，不能混进「用户需求」——用户需求是用户原话，
   * 改写了模型就分不清哪句是命令、哪句是现状。
   */
  note?: string;
}

export interface SelfCheckOptions {
  /** lint 栅格步长（px）；缺省 8。 */
  grid?: number;
  /** 关掉某些 lint 规则：`{ "off-grid": false }`。 */
  lintRules?: Partial<Record<LintCode, boolean>>;
  /**
   * 导出诊断用的视口。
   *
   * 导出诊断关心的是「这个特性能不能导出」，与视口大小无关，所以给一个固定值
   * 就够；传 `skipExport` 可以整段跳过。
   */
  exportViewport?: { width: number; height: number };
  /** 不做导出诊断。 */
  skipExport?: boolean;
  /**
   * 图片资源的解析器。
   *
   * 传了才能判断「这个图片资源到底导不导得出去」。不传时用一个占位图代替——
   * 没有解析器不代表资源有问题，那只是体检层自己没提供，报告成缺陷是误报。
   */
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
}

/** 1×1 透明 PNG。用作「不关心图片内容」时的占位资源。 */
export const PLACEHOLDER_ASSET_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const DEFAULT_EXPORT_VIEWPORT = { width: 1920, height: 1080 };

/**
 * 一条结论的稳定指纹。
 *
 * 只用「来源 + 代码 + 节点」三段，不含消息文本与数值：对比度从 2.1:1 变成 2.3:1
 * 时仍然是同一个问题（还没修好），消息文本每轮都在变，用它比对会把「有点进展」
 * 误判成「换了问题」。
 */
export function selfCheckFingerprint(issue: SelfCheckIssue): string {
  return `${issue.source}:${issue.code}${issue.nodeId ? `#${issue.nodeId}` : ""}`;
}

/** 扫一篇文档，出一份体检报告。 */
export function collectSelfCheck(document: DesignDocument, options: SelfCheckOptions = {}): SelfCheckReport {
  const issues: SelfCheckIssue[] = [];

  for (const issue of lintDocument(document, { grid: options.grid, rules: options.lintRules })) {
    issues.push({
      source: "lint",
      code: issue.code,
      severity: issue.severity === "warning" ? "warning" : "info",
      message: issue.message,
      ...(issue.nodeId ? { nodeId: issue.nodeId } : {}),
      ...(issue.detail ? { detail: issue.detail } : {}),
      // lint 的结论全是"能修的"：硬编码颜色没绑 token、间距没绑 token、
      // 不在栅格上、同级重名——每一条都有明确的修法。
      actionable: true,
    });
  }

  for (const issue of collectContrastIssues(document)) {
    issues.push({
      source: "contrast",
      code: "low-contrast",
      severity: "error",
      message: `文本「${truncate(issue.text, 24)}」的对比度 ${issue.ratio.toFixed(2)}:1，低于阈值 ${issue.threshold}`,
      nodeId: issue.nodeId,
      detail: `前景 ${issue.foreground}，背景 ${issue.background}`,
      actionable: true,
    });
  }

  for (const diagnostic of collectExportDiagnostics(document, options)) {
    issues.push({
      source: "export",
      code: diagnostic.feature,
      severity: diagnostic.support === "unsupported" ? "error" : "info",
      message: diagnostic.message,
      ...(diagnostic.nodeId ? { nodeId: diagnostic.nodeId } : {}),
      actionable: diagnostic.support === "unsupported",
    });
  }

  return buildSelfCheckReport(issues);
}

/** 汇总一份报告的计数与指纹。 */
export function buildSelfCheckReport(issues: SelfCheckIssue[]): SelfCheckReport {
  const counts = { error: 0, warning: 0, info: 0, actionable: 0 };
  const fingerprints = new Set<string>();
  for (const issue of issues) {
    if (issue.severity === "error") counts.error += 1;
    else if (issue.severity === "warning") counts.warning += 1;
    else counts.info += 1;
    if (issue.actionable) {
      counts.actionable += 1;
      fingerprints.add(selfCheckFingerprint(issue));
    }
  }
  return { issues, counts, fingerprints: [...fingerprints].sort() };
}

/**
 * 把体检结论排成给模型看的待修清单。
 *
 * 这段文字是编排循环的**回喂通道**：模型看到的是"体检说这里不对"，而不是
 * "上一次你说改好了"。没有它，循环就只是把同一个需求问了很多遍。
 */
export function formatSelfCheckForPrompt(context: SelfCheckContext, options: { maxItems?: number; round?: number } = {}): string {
  const maxItems = Math.max(1, options.maxItems ?? 20);
  const { report, stuck } = context;
  const actionable = report.issues.filter(issue => issue.actionable).sort(compareIssues);
  const lines: string[] = [];

  const header = options.round ? `体检结论（第 ${options.round} 轮）：` : "体检结论：";
  lines.push(`${header}待修 ${actionable.length} 项（错误 ${report.counts.error}、警告 ${report.counts.warning}、提示 ${report.counts.info}）`);

  if (context.note) {
    lines.push(context.note);
  }

  if (!actionable.length) {
    lines.push("没有待修项。");
    return lines.join("\n");
  }

  const shown = actionable.slice(0, maxItems);
  shown.forEach((issue, index) => {
    const where = issue.nodeId ? `（节点 ${issue.nodeId}）` : "";
    const detail = issue.detail ? ` —— ${issue.detail}` : "";
    lines.push(`${index + 1}. [${SEVERITY_LABELS[issue.severity]}][${issue.source}/${issue.code}] ${issue.message}${where}${detail}`);
  });
  if (actionable.length > shown.length) lines.push(`……另有 ${actionable.length - shown.length} 项未列出。`);

  const stuckSet = new Set(stuck);
  const stuckItems = actionable.filter(issue => stuckSet.has(selfCheckFingerprint(issue)));
  if (stuckItems.length) {
    lines.push("");
    lines.push("以下问题已尝试多轮仍未解决，不要再尝试：");
    for (const issue of stuckItems) lines.push(`- ${selfCheckFingerprint(issue)}：${issue.message}`);
  }

  lines.push("");
  lines.push("只针对上面列出的待修项做改动，不要顺手改其它节点。");
  return lines.join("\n");
}

const SEVERITY_LABELS: Record<SelfCheckSeverity, string> = { error: "错误", warning: "警告", info: "提示" };

const SEVERITY_ORDER: Record<SelfCheckSeverity, number> = { error: 0, warning: 1, info: 2 };

/** 错误优先、警告其次、提示最后；同级按来源与节点排序，保证同一份文档的结果稳定。 */
function compareIssues(left: SelfCheckIssue, right: SelfCheckIssue): number {
  const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (bySeverity !== 0) return bySeverity;
  const bySource = left.source.localeCompare(right.source);
  if (bySource !== 0) return bySource;
  const byNode = (left.nodeId ?? "").localeCompare(right.nodeId ?? "");
  if (byNode !== 0) return byNode;
  return left.code.localeCompare(right.code);
}

/**
 * 跑一遍 HTML 导出，收集导出诊断。
 *
 * 只保留「导不出去」的结论作为待修项；`approximated` 与 `exact` 是说明性信息，
 * 报成缺陷只会让模型去做无意义的改动。
 */
function collectExportDiagnostics(document: DesignDocument, options: SelfCheckOptions): ExportDiagnostic[] {
  if (options.skipExport) return [];
  const viewport = options.exportViewport ?? DEFAULT_EXPORT_VIEWPORT;
  const resolveAsset = options.resolveAsset ?? (() => PLACEHOLDER_ASSET_URL);
  const diagnostics: ExportDiagnostic[] = [];
  for (const pageId of document.pageOrder) {
    if (!document.pages[pageId]) continue;
    try {
      const result = exportPageToHtml(document, { pageId, viewport, resolveAsset });
      diagnostics.push(...result.diagnostics);
    } catch {
      // 导不出来不等于文档有缺陷（校验不过的文档本来也进不了运行时）。
      // 这里不报「导出失败」，免得把体检结论变成噪声。
    }
  }
  return diagnostics.filter(diagnostic => diagnostic.support === "unsupported" || diagnostic.support === "approximated" || diagnostic.support === "rasterized");
}

function truncate(value: string, limit: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
