import { TEXT_DEFAULTS, absolutePath, pathDataFromCommands, resolveGap, resolveRadius, resolveStroke, validateDocument, vectorPathCommands, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportNodeSet, exportRootIds } from "./selection";
import type { ExportDiagnostic, HtmlExportOptions, HtmlExportResult } from "./types";

const ZERO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

export function exportPageToHtml(documentInput: DesignDocument, options: HtmlExportOptions): HtmlExportResult {
  const document = validateDocument(documentInput);
  const page = document.pages[options.pageId];
  if (!page) throw new Error(`Page ${options.pageId} does not exist`);
  if (!finiteSize(options.viewport)) throw new Error("Viewport dimensions must be finite non-negative numbers");

  const diagnostics: ExportDiagnostic[] = [];
  const tokenVariables = createTokenVariables(document);
  const css = buildCss(document, options, tokenVariables);
  const keep = options.nodeIds ? exportNodeSet(document, options.nodeIds) : undefined;
  const body = exportRootIds(document, options.pageId, keep)
    .map(id => renderNode(document, id, undefined, options, tokenVariables, diagnostics, keep))
    .join("\n");
  const title = escapeHtml(options.title ?? `${document.meta.name} — ${page.name}`);
  const html = `<main class="design-page" data-page-id="${escapeAttribute(page.id)}">${body ? `\n${indent(body)}\n` : ""}</main>`;
  const output = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${title}</title>`,
    "  <style>",
    indent(css, 4),
    "  </style>",
    "</head>",
    "<body>",
    indent(html, 2),
    "</body>",
    "</html>",
  ].join("\n");

  return { html, css, document: output, diagnostics: dedupeDiagnostics(diagnostics), tokenVariables };
}

function renderNode(
  document: DesignDocument,
  nodeId: string,
  parent: DesignNode | undefined,
  options: HtmlExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep?: Set<string>,
): string {
  const node = document.nodes[nodeId];
  const style = nodeStyle(document, node, parent, tokenVariables, options.origin);
  const common = `class="design-node design-${node.type}" data-node-id="${escapeAttribute(node.id)}" style="${escapeAttribute(style)}"`;

  if (node.type === "text") return `<p ${common}>${escapeHtml(node.text)}</p>`;
  if (node.type === "image") {
    const asset = document.assets[node.assetId];
    const rawUrl = asset ? options.resolveAsset?.(asset) : undefined;
    const url = rawUrl && safeAssetUrl(rawUrl) ? rawUrl : undefined;
    if (!url) {
      diagnostics.push({ nodeId, feature: "image-asset", support: "unsupported", message: rawUrl ? "Unsafe image URL was rejected" : `No export URL was provided for asset ${node.assetId}` });
      return `<div ${common} role="img" aria-label="${escapeAttribute(node.name)}"></div>`;
    }
    return `<img ${common} src="${escapeAttribute(url)}" alt="${escapeAttribute(node.name)}">`;
  }
  if (node.type === "vector") {
    const commands = node.geometry ? vectorPathCommands(node.geometry.d) : [];
    if (!commands.length) {
      diagnostics.push({ nodeId, feature: "vector", support: "unsupported", message: "Vector node has no path geometry and is exported as an empty container" });
    } else {
      return renderVectorPath(document, node, common, commands, tokenVariables);
    }
  }
  if (node.type === "instance") {
    diagnostics.push({ nodeId, feature: "component-instance", support: "approximated", message: "Instance export currently uses only materialized instance children" });
    const overrides = Object.keys(node.overrides ?? {}).length;
    if (overrides) {
      diagnostics.push({ nodeId, feature: "component-override", support: "exact", message: `Instance exports ${overrides} overridden node${overrides === 1 ? "" : "s"} from its materialized children` });
    }
  }

  const children = node.childIds
    .filter(id => !keep || keep.has(id))
    .map(id => renderNode(document, id, node, options, tokenVariables, diagnostics, keep))
    .join("\n");
  return `<div ${common}>${children ? `\n${indent(children)}\n` : ""}</div>`;
}

/**
 * 矢量节点在 HTML 里输出内联 `<svg>`。
 *
 * 外层仍是标准的 `.design-node` div（负责定位与尺寸），内层 svg 用 `viewBox` 撑满，
 * 路径坐标是归一化的，所以父 div 被布局引擎改变尺寸时图形跟着缩放。
 * 填充与描边直接写在 `<path>` 上：token 绑定已经在 `boundValue` 里变成 `var(--x)`。
 */
function renderVectorPath(
  document: DesignDocument,
  node: DesignNode & { type: "vector" },
  common: string,
  commands: ReturnType<typeof vectorPathCommands>,
  tokenVariables: Record<string, string>,
): string {
  const width = Math.max(node.layout.width, 1);
  const height = Math.max(node.layout.height, 1);
  const d = pathDataFromCommands(absolutePath(commands, { x: 0, y: 0, width, height }));
  const fill = node.appearance.fill ? boundValue(node.bindings?.fill, node.appearance.fill, tokenVariables) : "none";
  const hasStroke = Boolean(resolveStroke(document, node) || node.bindings?.stroke);
  const stroke = hasStroke ? boundValue(node.bindings?.stroke, node.appearance.stroke ?? "transparent", tokenVariables) : "none";
  const strokeWidth = node.appearance.strokeWidth ?? 1;
  const attributes = [`d="${escapeAttribute(d)}"`, `fill="${escapeAttribute(fill)}"`, `stroke="${escapeAttribute(stroke)}"`];
  if (hasStroke) attributes.push(`stroke-width="${num(strokeWidth)}"`);
  return `<div ${common}><svg viewBox="0 0 ${num(width)} ${num(height)}" preserveAspectRatio="none" style="display:block;width:100%;height:100%;overflow:visible"><path ${attributes.join(" ")} /></svg></div>`;
}

function nodeStyle(document: DesignDocument, node: DesignNode, parent: DesignNode | undefined, tokenVariables: Record<string, string>, origin?: { x: number; y: number }): string {
  const declarations: string[] = [];
  const inStack = parent?.layout.mode === "stack";
  // 有几何的矢量节点自己画路径，不能再给它铺一块背景矩形（否则线宽 1px 的直线会变成色块）。
  const pathVector = node.type === "vector" && Boolean(node.geometry);
  if (!inStack) {
    // 只有页面直属的节点用页面坐标定位，导出原点只影响它们；
    // 嵌套节点的坐标相对父节点，会跟着父节点一起平移。
    const offsetX = parent === undefined && origin ? origin.x : 0;
    const offsetY = parent === undefined && origin ? origin.y : 0;
    declarations.push("position:absolute", `left:${px(node.layout.x - offsetX)}`, `top:${px(node.layout.y - offsetY)}`);
  } else {
    declarations.push("position:relative");
  }
  addSize(declarations, "width", node.layout.widthMode, node.layout.width, parent);
  addSize(declarations, "height", node.layout.heightMode, node.layout.height, parent);
  declarations.push(`opacity:${node.appearance.opacity}`);
  if (!node.visible) declarations.push("display:none");
  if (node.appearance.fill && !pathVector) declarations.push(`background:${boundValue(node.bindings?.fill, node.appearance.fill, tokenVariables)}`);
  // 描边和圆角都可以由 token 驱动；绑定存在但节点没写 fallback 时同样要输出。
  if ((resolveStroke(document, node) || node.bindings?.stroke) && !pathVector) declarations.push(`border:${num(node.appearance.strokeWidth ?? 1)}px solid ${boundValue(node.bindings?.stroke, node.appearance.stroke ?? "transparent", tokenVariables)}`);
  const radius = resolveRadius(document, node);
  if (radius !== undefined && !pathVector) declarations.push(`border-radius:${px(radius)}`);

  if (node.type === "text") {
    declarations.push(`font-family:${cssString(node.fontFamily)}`, `font-size:${px(node.fontSize)}`, `line-height:${px(node.lineHeight)}`, "white-space:pre-wrap", "margin:0");
    // 只有偏离缺省值的样式才写进 CSS，旧文档的导出结果保持不变。
    const fontWeight = node.fontWeight ?? TEXT_DEFAULTS.fontWeight;
    if (fontWeight !== TEXT_DEFAULTS.fontWeight) declarations.push(`font-weight:${fontWeight}`);
    const fontStyle = node.fontStyle ?? TEXT_DEFAULTS.fontStyle;
    if (fontStyle !== TEXT_DEFAULTS.fontStyle) declarations.push(`font-style:${fontStyle}`);
    const textAlign = node.textAlign ?? TEXT_DEFAULTS.textAlign;
    if (textAlign !== TEXT_DEFAULTS.textAlign) declarations.push(`text-align:${textAlign}`);
    const letterSpacing = node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing;
    if (letterSpacing !== TEXT_DEFAULTS.letterSpacing) declarations.push(`letter-spacing:${px(letterSpacing)}`);
  }
  if (node.type === "image") declarations.push(`object-fit:${node.fit}`);
  if (node.type === "ellipse") declarations.push("border-radius:50%");

  if (node.layout.mode === "stack") {
    const padding = node.layout.padding ?? ZERO_PADDING;
    declarations.push(
      "display:flex",
      `flex-direction:${node.layout.direction === "horizontal" ? "row" : "column"}`,
      `gap:${px(resolveGap(document, node))}`,
      `padding:${px(padding.top)} ${px(padding.right)} ${px(padding.bottom)} ${px(padding.left)}`,
      `align-items:${alignItems(node.layout.align ?? "start")}`,
    );
  }
  return `${declarations.join(";")};`;
}

function addSize(declarations: string[], axis: "width" | "height", mode: "fixed" | "fill" | "hug", value: number, parent: DesignNode | undefined): void {
  if (mode === "fixed") declarations.push(`${axis}:${px(value)}`);
  else if (mode === "hug") declarations.push(`${axis}:fit-content`);
  else if (parent?.layout.mode === "stack") {
    const mainAxis = parent.layout.direction === "horizontal" ? "width" : "height";
    if (axis === mainAxis) declarations.push("flex:1 1 0", `${axis}:auto`);
    else declarations.push(`${axis}:100%`);
  }
  else declarations.push(`${axis}:100%`);
}

function buildCss(document: DesignDocument, options: HtmlExportOptions, tokenVariables: Record<string, string>): string {
  const variables = Object.entries(document.tokens).map(([name, token]) => `  ${tokenVariables[name]}: ${cssTokenValue(token.value)};`).join("\n");
  return [
    ":root {",
    variables,
    "}",
    "* { box-sizing: border-box; }",
    "html, body { margin: 0; min-height: 100%; }",
    `.design-page { position: relative; overflow: hidden; width: ${px(options.viewport.width)}; height: ${px(options.viewport.height)}; }`,
    ".design-node { min-width: 0; min-height: 0; }",
  ].filter(Boolean).join("\n");
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
  return binding && variables[binding] ? `var(${variables[binding]})` : safeCssValue(fallback);
}

function alignItems(align: "start" | "center" | "end" | "stretch"): string {
  if (align === "start") return "flex-start";
  if (align === "end") return "flex-end";
  return align;
}

function finiteSize(size: { width: number; height: number }): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width >= 0 && size.height >= 0;
}

function safeAssetUrl(url: string): boolean {
  return /^(https?:|data:image\/(?:png|jpeg|gif|webp);|blob:|\/|\.\.?\/)/i.test(url);
}

function cssTokenValue(value: string | number): string {
  return typeof value === "number" ? String(value) : safeCssValue(value);
}

function safeCssValue(value: string): string {
  return value.replace(/[;{}]/g, "").trim();
}

function cssString(value: string): string {
  return `"${value.replace(/["\\\n\r]/g, character => `\\${character}`)}"`;
}

function px(value: number): string {
  return `${Number(value.toFixed(4))}px`;
}

/** 无单位的数值（viewBox、stroke-width 这类属性用）。 */
function num(value: number): string {
  return String(Number(value.toFixed(4)));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
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
