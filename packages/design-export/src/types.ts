import type { TextMeasurer } from "@ufira/design-layout";
import type { AssetMetadata } from "@ufira/design-schema";

export type ExportSupport = "exact" | "approximated" | "rasterized" | "unsupported";

export interface ExportDiagnostic {
  nodeId?: string;
  feature: string;
  support: ExportSupport;
  message: string;
}

export interface HtmlExportOptions {
  pageId: string;
  viewport: { width: number; height: number };
  title?: string;
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
  /** 只导出包含这些节点的分支；不传则导出整页。 */
  nodeIds?: string[];
  /** 视口原点：导出坐标会减去该偏移，用来把选区裁剪到画布左上角。 */
  origin?: { x: number; y: number };
}

export interface HtmlExportResult {
  html: string;
  css: string;
  document: string;
  diagnostics: ExportDiagnostic[];
  tokenVariables: Record<string, string>;
}

export interface SvgExportOptions {
  pageId: string;
  viewport: { width: number; height: number };
  title?: string;
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
  textMeasurer?: TextMeasurer;
  /** 只导出包含这些节点的分支；不传则导出整页。 */
  nodeIds?: string[];
  /** 视口原点：导出坐标会减去该偏移，用来把选区裁剪到画布左上角。 */
  origin?: { x: number; y: number };
}

export interface SvgExportResult {
  svg: string;
  diagnostics: ExportDiagnostic[];
  tokenVariables: Record<string, string>;
}
