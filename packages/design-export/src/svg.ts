import { computePageLayout, type ComputedBox, type TextMeasurer } from "@ufira/design-layout";
import { TEXT_DEFAULTS, validateDocument, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportNodeSet, exportRootIds } from "./selection";
import type { ExportDiagnostic, SvgExportOptions, SvgExportResult } from "./types";

/**
 * Exports a page as a self-contained SVG document.
 *
 * Geometry comes from the layout engine, so stack, fill and hug sizing resolve
 * exactly as they do in the editor. Token bindings become CSS custom properties,
 * and unsupported features produce explicit diagnostics instead of silent drops.
 */
export function exportPageToSvg(documentInput: DesignDocument, options: SvgExportOptions): SvgExportResult {
  const document = validateDocument(documentInput);
  const page = document.pages[options.pageId];
  if (!page) throw new Error(`Page ${options.pageId} does not exist`);
  if (!finiteSize(options.viewport)) throw new Error("Viewport dimensions must be finite non-negative numbers");

  const diagnostics: ExportDiagnostic[] = [];
  const tokenVariables = createTokenVariables(document);
  const boxes = resolveBoxes(document, options, diagnostics);
  const keep = options.nodeIds ? exportNodeSet(document, options.nodeIds) : undefined;
  const body = exportRootIds(document, options.pageId, keep)
    .map(id => renderNode(document, id, boxes, options, tokenVariables, diagnostics, keep))
    .join("\n");
  const title = escapeXml(options.title ?? `${document.meta.name} — ${page.name}`);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(options.viewport.width)}" height="${num(options.viewport.height)}" viewBox="0 0 ${num(options.viewport.width)} ${num(options.viewport.height)}" data-page-id="${escapeXml(page.id)}">`,
    `  <title>${title}</title>`,
    renderTokenStyles(document, tokenVariables),
    body ? indent(body, 2) : "",
    "</svg>",
  ]
    .filter(line => line !== "")
    .join("\n");

  return { svg, diagnostics: dedupeDiagnostics(diagnostics), tokenVariables };
}

/**
 * Resolves laid-out geometry. Falls back to the declared layout when the layout
 * engine cannot process the document, so export never hard-fails on a bad tree.
 */
function resolveBoxes(
  document: DesignDocument,
  options: SvgExportOptions,
  diagnostics: ExportDiagnostic[],
): Record<string, ComputedBox> {
  try {
    return computePageLayout(document, options.pageId, {
      viewport: options.viewport,
      textMeasurer: options.textMeasurer,
    }).boxes;
  } catch (error) {
    diagnostics.push({
      feature: "layout",
      support: "approximated",
      message: `Layout could not be computed, falling back to declared positions: ${error instanceof Error ? error.message : String(error)}`,
    });
    return {};
  }
}

function renderTokenStyles(document: DesignDocument, tokenVariables: Record<string, string>): string {
  const entries = Object.entries(document.tokens);
  if (!entries.length) return "";
  // tokenVariables 里已经带 `--` 前缀（和 HTML 导出共用同一套命名），这里不能再补一次，
  // 否则会写出 `----color-primary` 这种声明，`var(--color-primary)` 就取不到值了。
  const declarations = entries
    .map(([name, token]) => `    ${tokenVariables[name]}: ${escapeXml(cssTokenValue(token.value))};`)
    .join("\n");
  return `  <style>\n  :root {\n${declarations}\n  }\n  </style>`;
}

function renderNode(
  document: DesignDocument,
  nodeId: string,
  boxes: Record<string, ComputedBox>,
  options: SvgExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep?: Set<string>,
): string {
  const node = document.nodes[nodeId];
  if (!node) return "";
  if (!node.visible) {
    diagnostics.push({ nodeId, feature: "hidden-node", support: "exact", message: `Hidden node ${nodeId} was skipped` });
    return "";
  }

  // 布局引擎给出的坐标是页面绝对坐标，所以导出原点对所有节点统一平移。
  const raw = boxes[nodeId] ?? { x: node.layout.x, y: node.layout.y, width: node.layout.width, height: node.layout.height };
  const box = shiftBox(raw, options.origin);
  const style = nodeStyle(node, tokenVariables);
  const common = `data-node-id="${escapeXml(node.id)}" style="${escapeXml(style)}"`;

  if (node.type === "text") {
    // SVG 没有 text-align，用 text-anchor + x 表达盒内对齐。
    const textAlign = node.textAlign ?? TEXT_DEFAULTS.textAlign;
    const x = textAlign === "center" ? box.x + box.width / 2 : textAlign === "right" ? box.x + box.width : box.x;
    const anchor = textAlign === "center" ? " text-anchor=\"middle\"" : textAlign === "right" ? " text-anchor=\"end\"" : "";
    return `<text ${common} x="${num(x)}" y="${num(box.y)}" dominant-baseline="hanging"${anchor}>${escapeXml(node.text)}</text>`;
  }

  if (node.type === "image") {
    const asset = document.assets[node.assetId];
    const rawUrl = asset ? options.resolveAsset?.(asset) : undefined;
    const url = rawUrl && safeAssetUrl(rawUrl) ? rawUrl : undefined;
    if (!url) {
      diagnostics.push({ nodeId, feature: "image-asset", support: "unsupported", message: rawUrl ? "Unsafe image URL was rejected" : `No export URL was provided for asset ${node.assetId}` });
      return `<rect ${common} x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="none" stroke="#cccccc" />`;
    }
    return `<image ${common} x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" href="${escapeXml(url)}" preserveAspectRatio="${preserveAspectRatio(node.fit)}" />`;
  }

  if (node.type === "vector") {
    diagnostics.push({ nodeId, feature: "vector", support: "unsupported", message: "Structured vector path data is not available in schema v1" });
  }
  if (node.type === "instance") {
    diagnostics.push({ nodeId, feature: "component-instance", support: "approximated", message: "Instance export uses the materialized instance children" });
  }

  const children = renderChildren(document, node, boxes, options, tokenVariables, diagnostics, keep);
  const radius = node.appearance.cornerRadius ?? 0;

  if (node.type === "ellipse") {
    return `<ellipse ${common} cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}" />${children ? `\n${indent(children, 2)}\n` : ""}`;
  }

  return `<g ${common}>  <rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radius > 0 ? ` rx="${num(radius)}"` : ""} />${children ? `\n${indent(children, 2)}\n` : ""}</g>`;
}

function renderChildren(
  document: DesignDocument,
  node: DesignNode,
  boxes: Record<string, ComputedBox>,
  options: SvgExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep?: Set<string>,
): string {
  return node.childIds
    .filter(id => !keep || keep.has(id))
    .map(childId => renderNode(document, childId, boxes, options, tokenVariables, diagnostics, keep))
    .filter(Boolean)
    .join("\n");
}

/** 把页面绝对坐标平移到导出视口的坐标系。 */
function shiftBox(box: ComputedBox, origin?: { x: number; y: number }): ComputedBox {
  if (!origin) return box;
  return { ...box, x: box.x - origin.x, y: box.y - origin.y };
}

function nodeStyle(node: DesignNode, tokenVariables: Record<string, string>): string {
  const declarations: string[] = [];
  declarations.push(`opacity:${num(node.appearance.opacity)}`);
  declarations.push(`fill:${node.appearance.fill ? boundValue(node.bindings?.fill, node.appearance.fill, tokenVariables) : "none"}`);
  if (node.appearance.stroke) {
    declarations.push(`stroke:${boundValue(node.bindings?.stroke, node.appearance.stroke, tokenVariables)}`);
    declarations.push("stroke-width:1");
  }
  if (node.type === "text") {
    declarations.push(`font-family:${cssString(node.fontFamily)}`);
    declarations.push(`font-size:${num(node.fontSize)}`);
    const fontWeight = node.fontWeight ?? TEXT_DEFAULTS.fontWeight;
    if (fontWeight !== TEXT_DEFAULTS.fontWeight) declarations.push(`font-weight:${fontWeight}`);
    const fontStyle = node.fontStyle ?? TEXT_DEFAULTS.fontStyle;
    if (fontStyle !== TEXT_DEFAULTS.fontStyle) declarations.push(`font-style:${fontStyle}`);
    const letterSpacing = node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing;
    if (letterSpacing !== TEXT_DEFAULTS.letterSpacing) declarations.push(`letter-spacing:${num(letterSpacing)}`);
    declarations.push("stroke:none");
  }
  if (node.type === "ellipse") declarations.push("stroke:none");
  return `${declarations.join(";")};`;
}

function createTokenVariables(document: DesignDocument): Record<string, string> {
  const used = new Set<string>();
  const output: Record<string, string> = {};
  for (const name of Object.keys(document.tokens).sort()) {
    const base = `--${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "token"}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    used.add(candidate);
    output[name] = candidate;
  }
  return output;
}

function boundValue(binding: string | undefined, fallback: string, variables: Record<string, string>): string {
  if (binding && variables[binding]) return `var(${variables[binding]})`;
  return safeCssValue(fallback);
}

function safeCssValue(value: string): string {
  return value.replace(/[;{}<>"']/g, "").trim();
}

function cssTokenValue(value: string | number): string {
  return typeof value === "number" ? String(value) : safeCssValue(value);
}

function cssString(value: string): string {
  return value.replace(/["\\\n\r]/g, "");
}

function preserveAspectRatio(fit: string): string {
  if (fit === "cover") return "xMidYMid slice";
  if (fit === "contain") return "xMidYMid meet";
  return "none";
}

function finiteSize(size: { width: number; height: number }): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width >= 0 && size.height >= 0;
}

function safeAssetUrl(url: string): boolean {
  return /^(https?:|data:image\/(?:png|jpeg|gif|webp);|blob:|\/|\.\.?\/)/i.test(url);
}

function num(value: number): string {
  return String(Number(value.toFixed(4)));
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function indent(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map(line => `${prefix}${line}`).join("\n");
}

function dedupeDiagnostics(diagnostics: ExportDiagnostic[]): ExportDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter(item => {
    const key = `${item.nodeId}:${item.feature}:${item.support}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
