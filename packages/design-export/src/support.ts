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
  { feature: "layout-grid", html: "exact", svg: "exact", png: "exact", note: "Grid tracks and cells are resolved by the layout engine; HTML emits CSS Grid, SVG/PNG use the resolved absolute boxes." },
  { feature: "sizing", html: "exact", svg: "exact", png: "exact", note: "Fixed / fill / hug sizing is computed once and shared by canvas, export and rasterization." },
  { feature: "text-typography", html: "exact", svg: "exact", png: "exact", note: "Family, size, line height, weight, style, alignment and letter spacing." },
  { feature: "font-inline", html: "exact", svg: "unsupported", png: "rasterized", note: "HTML inlines the declared font files as @font-face data URLs, so the deliverable carries its own type. Fonts above 1 MB are not inlined and are reported. SVG references system fonts; PNG has already rasterized the text." },
  { feature: "text-wrapping", html: "exact", svg: "exact", png: "exact", note: "Line breaks come from the injected text measurer." },
  { feature: "paragraph-styles", html: "exact", svg: "exact", png: "exact", note: "List type and indent level. HTML uses real <ul>/<ol> with explicit <li value> so numbering matches the canvas; SVG emits the marker and the body as separate <text> elements." },
  { feature: "tokens", html: "exact", svg: "exact", png: "exact", note: "Color, number and string tokens become CSS variables / SVG variables." },
  { feature: "shapes", html: "exact", svg: "exact", png: "exact", note: "Frame, rectangle and ellipse with fill, stroke, corner radius and opacity." },
  { feature: "drop-shadow", html: "exact", svg: "exact", png: "rasterized", note: "投影。HTML uses box-shadow; SVG uses <feDropShadow> with stdDeviation = blur / 2." },
  { feature: "shadow-spread", html: "exact", svg: "exact", png: "rasterized", note: "阴影扩散半径。HTML 是 box-shadow 的第 4 个值；SVG 用 <feMorphology> 膨胀后再模糊、偏移、着色。" },
  { feature: "inner-shadow", html: "exact", svg: "exact", png: "rasterized", note: "内阴影。HTML 用 box-shadow: inset；SVG 用 SourceAlpha 与「模糊并偏移后的自己」求差，剩下的区域就是内阴影。" },
  { feature: "layer-blur", html: "exact", svg: "exact", png: "rasterized", note: "图层模糊：模糊整个图层（含子节点）。HTML 用 filter: blur()；SVG 用 <feGaussianBlur> 挂在图层分组上。" },
  { feature: "text-fill", html: "exact", svg: "exact", png: "exact", note: "文本颜色取填充层：单层实色时三端一致（HTML 写 color:，SVG 写 fill:）。" },
  { feature: "text-fill-multi", html: "approximated", svg: "approximated", png: "rasterized", note: "多层填充的文本只按第一层上色，后续填充层不参与文字颜色。" },
  { feature: "text-fill-gradient", html: "approximated", svg: "exact", png: "rasterized", note: "渐变文字：SVG 直接用渐变填充文字；HTML 与画布没有渐变文字，按首个色标近似。" },
  { feature: "mask", html: "exact", svg: "exact", png: "rasterized", note: "蒙版裁剪同一父级里排在它上面的兄弟。HTML 用 clip-path: path()，SVG 用 <clipPath>；圆角在两端都被尊重。" },
  { feature: "mask-soft", html: "exact", svg: "exact", png: "rasterized", note: "半透明 / 羽化蒙版：HTML 用 mask-image（内联 SVG 遮罩），SVG 用 <mask>，画布用离屏合成（destination-in）。硬蒙版仍走 clip-path / <clipPath>。" },
  { feature: "blend-mode", html: "exact", svg: "exact", png: "rasterized", note: "CSS mix-blend-mode with the same 16 values as the editor. HTML isolates the page so blending stays inside the design; SVG relies on the browser's CSS compositing." },
  { feature: "gradient-elliptical", html: "exact", svg: "exact", png: "rasterized", note: "Elliptical gradient. HTML uses radial-gradient(ellipse rx ry at …); SVG uses a unit <radialGradient> with gradientTransform." },
  { feature: "gradient-rotation", html: "approximated", svg: "exact", png: "rasterized", note: "Rotation of a radial/elliptical gradient. SVG rotates the gradient with gradientTransform; CSS radial-gradient has no rotation, so HTML drops the angle and reports an approximated diagnostic." },
  { feature: "background-blur", html: "exact", svg: "approximated", png: "rasterized", note: "HTML uses backdrop-filter. SVG has no backdrop-filter, so the backdrop is copied, clipped to the node shape and blurred — ancestor backgrounds are not part of that copy." },
  { feature: "image-asset", html: "exact", svg: "exact", png: "rasterized", note: "Requires a resolvable asset; the workbench inlines data URLs. Remote URLs are rejected as unsafe." },
  { feature: "component-instance", html: "approximated", svg: "approximated", png: "approximated", note: "Only the materialized instance children are exported; slots are not re-evaluated." },
  { feature: "component-override", html: "exact", svg: "exact", png: "exact", note: "Overrides are applied to the materialized children before export, so text and appearance already include them." },
  { feature: "vector", html: "exact", svg: "exact", png: "rasterized", note: "Normalized M/L/Z paths are written as SVG path data (HTML uses an inline <svg>). Vector nodes without geometry keep the legacy empty-container diagnostic." },
  { feature: "boolean", html: "exact", svg: "exact", png: "rasterized", note: "操作数在读取时合并：曲线级引擎（paper.js）保留贝塞尔曲线，没装引擎时退回多边形近似。操作数可以带旋转。" },
  { feature: "layout", html: "approximated", svg: "approximated", png: "approximated", note: "Fallback to declared positions when the layout engine cannot resolve the page; geometry may drift from the canvas." },
  { feature: "hidden-node", html: "exact", svg: "exact", png: "exact", note: "Hidden nodes are skipped and reported as a diagnostic instead of silently disappearing." },
  { feature: "png-rasterize", html: "n/a", svg: "n/a", png: "rasterized", note: "PNG is produced by rasterizing the SVG in the browser; external images taint the canvas." },
];

/** 某个特性在某个格式下的支持程度；表里没有就返回 undefined。 */
export function supportFor(feature: string, format: "html" | "svg" | "png"): ExportSupport | "n/a" | undefined {
  return EXPORT_SUPPORT_MATRIX.find(entry => entry.feature === feature)?.[format];
}
