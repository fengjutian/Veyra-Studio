import type { ExportSupport } from "./types";

/**
 * 导出支持矩阵。
 *
 * 这份表回答"某个特性在某个交付格式里到底是什么水平"，和导出器实际发出的
 * 诊断一一对应：诊断里的 `feature`、`support` 必须能在这张表里找到同一行，
 * 否则用户会看到一条无法解释的警告。
 *
 * `"n/a"` 表示该格式不涉及这个特性（例如 PNG 没有"元素隐藏"的语义，它只是
 * 光栅化 SVG 的结果）。
 */
export interface ExportSupportEntry {
  feature: string;
  html: ExportSupport | "n/a";
  svg: ExportSupport | "n/a";
  png: ExportSupport | "n/a";
  note: string;
}

export const EXPORT_SUPPORT_MATRIX: ExportSupportEntry[] = [
  { feature: "layout-absolute", html: "exact", svg: "exact", png: "exact", note: "Absolute positioning and fixed sizes are resolved by the shared layout engine." },
  { feature: "layout-stack", html: "exact", svg: "exact", png: "exact", note: "Stack layout, gap, padding and alignment are resolved before export." },
  { feature: "sizing", html: "exact", svg: "exact", png: "exact", note: "Fixed / fill / hug sizing is computed once and shared by canvas, export and rasterization." },
  { feature: "text-typography", html: "exact", svg: "exact", png: "exact", note: "Family, size, line height, weight, style, alignment and letter spacing." },
  { feature: "text-wrapping", html: "exact", svg: "exact", png: "exact", note: "Line breaks come from the injected text measurer." },
  { feature: "tokens", html: "exact", svg: "exact", png: "exact", note: "Color, number and string tokens become CSS variables / SVG variables." },
  { feature: "shapes", html: "exact", svg: "exact", png: "exact", note: "Frame, rectangle and ellipse with fill, stroke, corner radius and opacity." },
  { feature: "image-asset", html: "exact", svg: "exact", png: "rasterized", note: "Requires a resolvable asset; the workbench inlines data URLs. Remote URLs are rejected as unsafe." },
  { feature: "component-instance", html: "approximated", svg: "approximated", png: "approximated", note: "Only the materialized instance children are exported; slots are not re-evaluated." },
  { feature: "component-override", html: "exact", svg: "exact", png: "exact", note: "Overrides are applied to the materialized children before export, so text and appearance already include them." },
  { feature: "vector", html: "exact", svg: "exact", png: "rasterized", note: "Normalized M/L/Z paths are written as SVG path data (HTML uses an inline <svg>). Vector nodes without geometry keep the legacy empty-container diagnostic." },
  { feature: "layout", html: "approximated", svg: "approximated", png: "approximated", note: "Fallback to declared positions when the layout engine cannot resolve the page; geometry may drift from the canvas." },
  { feature: "hidden-node", html: "exact", svg: "exact", png: "exact", note: "Hidden nodes are skipped and reported as a diagnostic instead of silently disappearing." },
  { feature: "png-rasterize", html: "n/a", svg: "n/a", png: "rasterized", note: "PNG is produced by rasterizing the SVG in the browser; external images taint the canvas." },
];

/** 某个特性在某个格式下的支持程度；表里没有就返回 undefined。 */
export function supportFor(feature: string, format: "html" | "svg" | "png"): ExportSupport | "n/a" | undefined {
  return EXPORT_SUPPORT_MATRIX.find(entry => entry.feature === feature)?.[format];
}
