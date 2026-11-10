import { EXPORT_SUPPORT_MATRIX, type ExportDiagnostic, type ExportSupport } from "@ufira/design-export";

/**
 * 导出诊断与支持矩阵的展示层。
 *
 * 导出器现在只把诊断条数报给用户，说得出"有 3 条诊断"，却说不出"缺的是哪张图"。
 * 这一层把诊断变成可点击的行，并把支持矩阵翻译成中文，两者共用同一套特性 id。
 */

const FEATURE_LABELS: Record<string, string> = {
  "image-asset": "图片资源",
  vector: "矢量图形",
  "component-instance": "组件实例",
  "component-override": "组件覆盖",
  "hidden-node": "隐藏节点",
  layout: "布局计算",
  "png-rasterize": "PNG 光栅化",
  "layout-absolute": "绝对定位",
  "layout-stack": "自动布局",
  sizing: "尺寸策略",
  "text-typography": "文字样式",
  "text-wrapping": "文本换行",
  tokens: "设计 Token",
  shapes: "基础形状",
};

const SUPPORT_LABELS: Record<ExportSupport | "n/a", string> = {
  exact: "完整",
  approximated: "近似",
  rasterized: "光栅化",
  unsupported: "不支持",
  "n/a": "—",
};

export type ExportFormat = "html" | "svg" | "png" | "react" | "pdf";

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature;
}

export function supportLabel(support: ExportSupport | "n/a"): string {
  return SUPPORT_LABELS[support] ?? support;
}

export interface DiagnosticRow {
  key: string;
  feature: string;
  label: string;
  support: ExportSupport;
  supportLabel: string;
  message: string;
  nodeId?: string;
}

/** 诊断 → 面板行；顺序保持导出器产生的顺序，便于对照。 */
export function diagnosticRows(diagnostics: ExportDiagnostic[]): DiagnosticRow[] {
  return diagnostics.map((diagnostic, index) => ({
    key: `${diagnostic.feature}:${diagnostic.nodeId ?? "doc"}:${index}`,
    feature: diagnostic.feature,
    label: featureLabel(diagnostic.feature),
    support: diagnostic.support,
    supportLabel: supportLabel(diagnostic.support),
    message: diagnostic.message,
    nodeId: diagnostic.nodeId,
  }));
}

/** 一行摘要：条数 + 不支持的数量，没有诊断时明确说"没有"。 */
export function diagnosticSummary(diagnostics: ExportDiagnostic[], format?: ExportFormat): string {
  if (!format) return "导出一次后这里会列出诊断";
  if (!diagnostics.length) return `${format.toUpperCase()} 本次导出没有诊断`;
  const unsupported = diagnostics.filter(diagnostic => diagnostic.support === "unsupported").length;
  return unsupported
    ? `${format.toUpperCase()} 共 ${diagnostics.length} 条诊断，其中 ${unsupported} 条不受支持`
    : `${format.toUpperCase()} 共 ${diagnostics.length} 条诊断`;
}

export interface SupportRow {
  feature: string;
  label: string;
  html: string;
  svg: string;
  png: string;
  note: string;
}

/** 支持矩阵 → 面板表格行。 */
export function supportRows(): SupportRow[] {
  return EXPORT_SUPPORT_MATRIX.map(entry => ({
    feature: entry.feature,
    label: featureLabel(entry.feature),
    html: supportLabel(entry.html),
    svg: supportLabel(entry.svg),
    png: supportLabel(entry.png),
    note: entry.note,
  }));
}
