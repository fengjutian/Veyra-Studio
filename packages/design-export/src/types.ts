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
  /** 主题 id：导出前把该主题的 token 覆盖合并进来；不传用基础值。 */
  themeId?: string;
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
  /**
   * 要写进 `<style>` 的 `@font-face` 规则。
   *
   * 字体准备是异步的（要读资产字节），所以由调用方先准备好再传进来——
   * 导出器本身保持同步。
   */
  fontFaces?: readonly string[];
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
  /** 主题 id：导出前把该主题的 token 覆盖合并进来；不传用基础值。 */
  themeId?: string;
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
  textMeasurer?: TextMeasurer;
  /**
   * 要写进 `<style>` 的 `@font-face` 规则。
   *
   * 与 HTML 导出同名同义：规则文本一模一样，只是落点不同
   * （SVG 里是根 `<svg>` 下的一个 `<style>` 元素）。
   *
   * 字体准备是异步的（要读资产字节），所以由调用方先准备好再传进来——
   * 导出器本身保持同步。
   */
  fontFaces?: readonly string[];
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
