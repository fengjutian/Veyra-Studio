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
}

export interface HtmlExportResult {
  html: string;
  css: string;
  document: string;
  diagnostics: ExportDiagnostic[];
  tokenVariables: Record<string, string>;
}
