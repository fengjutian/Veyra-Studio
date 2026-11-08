import { TEXT_DEFAULTS, absolutePath, computeBooleanGeometry, cssBlendMode, ellipticalGeometry, ellipticalGradientMatrix, gradientLine, radialGeometry, pathDataFromCommands, resolveCornerRadii, resolveFills, resolveGap, resolveRadius, resolveStroke, textRunSegments, validateDocument, vectorPathCommands, type DesignDocument, type DesignNode, type GridTrack, type Paint, type TextNode } from "@ufira/design-schema";
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
  const body = renderSiblingList(document, exportRootIds(document, options.pageId, keep), undefined, options, tokenVariables, diagnostics, keep);
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
  // 蒙版节点自身不渲染；父级在 children 循环里把它转成裁剪容器。
  if (node.mask) return "";
  // CSS 的 radial-gradient 没有旋转：带旋转角的椭圆渐变在 HTML 里会丢掉旋转。
  // 这里明确记一条诊断，而不是悄悄导出一个方向不对的渐变。
  if (resolveFills(document, node).some(paint => paint.type === "elliptical" && paint.angle)) {
    diagnostics.push({ nodeId, feature: "gradient-rotation", support: "approximated", message: "CSS 的 radial-gradient 不支持旋转，椭圆渐变的旋转角在 HTML 导出里丢失" });
  }
  const style = nodeStyle(document, node, parent, tokenVariables, options.origin);
  const common = `class="design-node design-${node.type}" data-node-id="${escapeAttribute(node.id)}" style="${escapeAttribute(style)}"`;

  if (node.type === "text") return `<p ${common}>${textHtml(node)}</p>`;
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
  if (node.type === "boolean") {
    const commands = computeBooleanGeometry(document, node, {}, node.layout);
    if (!commands?.length) {
      // 空结果也不能把操作数当普通子节点导出：它们只是运算输入。
      diagnostics.push({ nodeId, feature: "boolean", support: "unsupported", message: "Boolean group produced an empty shape" });
      return `<div ${common}></div>`;
    } else {
      return renderVectorPath(document, node as unknown as DesignNode & { type: "vector" }, common, commands, tokenVariables);
    }
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

  const children = renderChildren(document, node, options, tokenVariables, diagnostics, keep);
  return `<div ${common}>${children ? `\n${indent(children)}\n` : ""}</div>`;
}

/**
 * 渲染子节点，并把蒙版翻译成 CSS 裁剪。
 *
 * HTML 没有 `<clipPath>`，用 `clip-path: path('…')`。这里给被遮罩的兄弟套一层
 * `position:absolute; inset:0` 的容器：容器和父级同坐标系，所以路径可以直接用
 * 父级坐标，不需要把路径平移到子元素的局部坐标（那是很容易写错的一步）。
 * 多层蒙版就套多层容器，天然叠加。
 */
function renderChildren(
  document: DesignDocument,
  node: DesignNode,
  options: HtmlExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep?: Set<string>,
): string {
  return renderSiblingList(document, node.childIds, node, options, tokenVariables, diagnostics, keep);
}

function renderSiblingList(
  document: DesignDocument,
  ids: readonly string[],
  parent: DesignNode | undefined,
  options: HtmlExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep?: Set<string>,
): string {
  const parts: string[] = [];
  const masks: DesignNode[] = [];
  for (const childId of ids) {
    if (keep && !keep.has(childId)) continue;
    const childNode = document.nodes[childId];
    if (!childNode) continue;
    if (childNode.mask) { masks.push(childNode); continue; }
    const rendered = renderNode(document, childId, parent, options, tokenVariables, diagnostics, keep);
    if (!rendered) continue;
    let wrapped = rendered;
    for (const mask of masks) {
      const clip = maskClipPath(document, mask);
      if (!clip) continue;
      wrapped = `<div style="position:absolute;inset:0;clip-path:path('${escapeAttribute(clip)}')">\n${indent(wrapped, 2)}\n</div>`;
    }
    parts.push(wrapped);
  }
  return parts.join("\n");
}

/**
 * 蒙版轮廓（父级坐标系），供 CSS `clip-path: path()` 使用。
 *
 * 只取几何轮廓：圆角矩形的 `cornerRadius` 在这里被忽略（CSS path 里补圆弧会让表达式
 * 明显变长，而蒙版用圆角矩形并不常见），椭圆用 32 段折线近似。
 */
function maskClipPath(document: DesignDocument, mask: DesignNode): string | undefined {
  const { x, y, width, height } = mask.layout;
  if (mask.type === "ellipse") {
    const points: string[] = [];
    const steps = 32;
    for (let index = 0; index < steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      points.push(`${num(x + width / 2 + Math.cos(angle) * (width / 2))} ${num(y + height / 2 + Math.sin(angle) * (height / 2))}`);
    }
    return `M ${points[0]} ${points.slice(1).map(point => `L ${point}`).join(" ")} Z`;
  }
  if (mask.type === "vector") {
    if (!mask.geometry) return undefined;
    return pathDataFromCommands(absolutePath(vectorPathCommands(mask.geometry.d), { x, y, width, height }));
  }
  return `M ${num(x)} ${num(y)} L ${num(x + width)} ${num(y)} L ${num(x + width)} ${num(y + height)} L ${num(x)} ${num(y + height)} Z`;
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
  // 填充层：实色走 CSS 变量，渐变走 linear-gradient（角度与画布/SVG 同一套约定）。
  const fills = resolveFills(document, node);
  const defs: string[] = [];
  const hasStroke = Boolean(resolveStroke(document, node) || node.bindings?.stroke);
  const stroke = hasStroke ? boundValue(node.bindings?.stroke, node.appearance.stroke ?? "transparent", tokenVariables) : "none";
  const strokeWidth = node.appearance.strokeWidth ?? 1;
  const attributesOf = (paint: Paint | undefined, index: number): string => {
    let fill = "none";
    if (paint?.type === "solid") {
      fill = boundValue(node.bindings?.fill, paint.color, tokenVariables);
    } else if (paint) {
      // 内联 <svg> 里不能用 CSS 渐变函数，只能生成一条 gradient；坐标用 viewBox 的本地空间。
      const id = `paint-${index}`;
      const local = { x: 0, y: 0, width, height };
      const stops = [...paint.stops].sort((a, b) => a.offset - b.offset)
        .map(stop => `<stop offset="${num(stop.offset)}" stop-color="${escapeAttribute(stop.color)}" />`)
        .join("");
      if (paint.type === "linear") {
        const line = gradientLine(local, paint.angle);
        defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(line.x1)}" y1="${num(line.y1)}" x2="${num(line.x2)}" y2="${num(line.y2)}">${stops}</linearGradient>`);
      } else if (paint.type === "radial") {
        const radial = radialGeometry(local, paint);
        defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(radial.cx)}" cy="${num(radial.cy)}" r="${num(radial.r)}">${stops}</radialGradient>`);
      } else {
        // 椭圆渐变：单位圆 + gradientTransform 缩放成椭圆（SVG 没有原生椭圆径向渐变）。
        const ellipse = ellipticalGeometry(local, paint);
        const matrix = ellipticalGradientMatrix(ellipse, paint.angle ?? 0);
        defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${matrix.map(num).join(" ")})">${stops}</radialGradient>`);
      }
      fill = `url(#${id})`;
    }
    const parts = [`d="${escapeAttribute(d)}"`, `fill="${escapeAttribute(fill)}"`];
    // 描边只画一次：多层填充重复的是路径本身，不是描边。
    if (index === 0) {
      parts.push(`stroke="${escapeAttribute(stroke)}"`);
      if (hasStroke) parts.push(`stroke-width="${num(strokeWidth)}"`);
    }
    return parts.join(" ");
  };
  const paths = fills.length ? fills.map((paint, index) => `<path ${attributesOf(paint, index)} />`) : [`<path ${attributesOf(undefined, 0)} />`];
  const paintDefs = defs.length ? `<defs>${defs.join("")}</defs>` : "";
  return `<div ${common}><svg viewBox="0 0 ${num(width)} ${num(height)}" preserveAspectRatio="none" style="display:block;width:100%;height:100%;overflow:visible">${paintDefs}${paths.join("")}</svg></div>`;
}

function nodeStyle(document: DesignDocument, node: DesignNode, parent: DesignNode | undefined, tokenVariables: Record<string, string>, origin?: { x: number; y: number }): string {
  const declarations: string[] = [];
  const inStack = parent?.layout.mode === "stack";
  const inGrid = parent?.layout.mode === "grid";
  // 有几何的矢量节点自己画路径，不能再给它铺一块背景矩形（否则线宽 1px 的直线会变成色块）。
  const pathVector = (node.type === "vector" && Boolean(node.geometry)) || node.type === "boolean";
  if (!inStack && !inGrid) {
    // 只有页面直属的节点用页面坐标定位，导出原点只影响它们；
    // 嵌套节点的坐标相对父节点，会跟着父节点一起平移。
    const offsetX = parent === undefined && origin ? origin.x : 0;
    const offsetY = parent === undefined && origin ? origin.y : 0;
    declarations.push("position:absolute", `left:${px(node.layout.x - offsetX)}`, `top:${px(node.layout.y - offsetY)}`);
  } else {
    declarations.push("position:relative");
  }
  if (inGrid) {
    // Grid 子节点由父容器的 grid 定位，自己不再声明坐标。
    const cell = parent?.layout.grid?.cells?.[node.id];
    if (cell) {
      declarations.push(`grid-column:${cell.column} / span ${cell.columnSpan ?? 1}`);
      declarations.push(`grid-row:${cell.row} / span ${cell.rowSpan ?? 1}`);
    }
  }
  addSize(declarations, "width", node.layout.widthMode, node.layout.width, parent);
  addSize(declarations, "height", node.layout.heightMode, node.layout.height, parent);
  declarations.push(`opacity:${node.appearance.opacity}`);
  // 混合模式：与 CSS `mix-blend-mode` 同名，不需要翻译。
  const blend = cssBlendMode(node.appearance.blendMode);
  if (blend) declarations.push(`mix-blend-mode:${blend}`);
  // 背景模糊：节点后面的内容被模糊，节点自身不模糊。
  if (node.appearance.backgroundBlur) declarations.push(`backdrop-filter:blur(${num(node.appearance.backgroundBlur)}px)`);
  if (!node.visible) declarations.push("display:none");
  const fills = resolveFills(document, node);
  if (fills[0] && !pathVector) {
    if (fills.length === 1) {
      // 单层（实色或渐变）保持 `background:` 简写：输出与引入多层之前逐字一致。
      declarations.push(`background:${cssPaint(node, fills[0]!, tokenVariables)}`);
    } else {
      // 多层：CSS 的 background-image 列表是「第一个在最上面」，所以按数组倒序输出。
      const bottom = fills[0]!;
      if (bottom.type === "solid") declarations.push(`background-color:${cssPaint(node, bottom, tokenVariables)}`);
      const layers = (bottom.type === "solid" ? fills.slice(1) : fills)
        .map(paint => cssBackgroundLayer(node, paint, tokenVariables))
        .reverse();
      if (layers.length) declarations.push(`background-image:${layers.join(", ")}`);
    }
  }
  // 旋转绕元素中心（transform-origin 的初始值就是 50% 50%），与画布、SVG 一致。
  if (node.layout.rotation) declarations.push(`transform:rotate(${num(node.layout.rotation)}deg)`);
  if (node.appearance.shadow) {
    const shadow = node.appearance.shadow;
    // 颜色来自文档，仍然走一次 safeCssValue，避免有人把 `;}` 塞进颜色里。
    declarations.push(`box-shadow:${num(shadow.x)}px ${num(shadow.y)}px ${num(shadow.blur)}px ${safeCssValue(shadow.color)}`);
  }
  if (node.appearance.blur) declarations.push(`filter:blur(${num(node.appearance.blur)}px)`);
  // 描边和圆角都可以由 token 驱动；绑定存在但节点没写 fallback 时同样要输出。
  if ((resolveStroke(document, node) || node.bindings?.stroke) && !pathVector) declarations.push(`border:${num(node.appearance.strokeWidth ?? 1)}px solid ${boundValue(node.bindings?.stroke, node.appearance.stroke ?? "transparent", tokenVariables)}`);
  const radii = resolveCornerRadii(document, node);
  if (radii && !pathVector) {
    // CSS 的 border-radius 直接支持「左上 右上 右下 左下」四值写法。
    const uniform = radii.every(value => value === radii[0]);
    declarations.push(`border-radius:${uniform ? px(radii[0]) : radii.map(px).join(" ")}`);
  }

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
  if (node.layout.mode === "grid" && node.layout.grid) {
    // Grid 容器输出成 CSS Grid：轨道写法与本项目的五种轨道类型一一对应。
    const grid = node.layout.grid;
    const padding = node.layout.padding ?? ZERO_PADDING;
    declarations.push(
      "display:grid",
      `grid-template-columns:${grid.columns.map(gridTrackCss).join(" ")}`,
      `grid-template-rows:${grid.rows.map(gridTrackCss).join(" ")}`,
      `column-gap:${px(grid.columnGap)}`,
      `row-gap:${px(grid.rowGap)}`,
      `padding:${px(padding.top)} ${px(padding.right)} ${px(padding.bottom)} ${px(padding.left)}`,
      `align-items:${alignItems(grid.align ?? "start")}`,
    );
  }
  return `${declarations.join(";")};`;
}

/**
 * Grid 轨道 → CSS 轨道写法。
 *
 * 五种轨道类型与 CSS Grid 的 `grid-template-columns/rows` 一一对应：
 * `fixed` → px、`fraction` → fr、`auto` → auto、
 * `min-content` / `max-content` → 同名关键字。
 */
function gridTrackCss(track: GridTrack): string {
  switch (track.type) {
    case "fixed":
      return px(track.size);
    case "fraction":
      return `${num(track.weight)}fr`;
    case "auto":
      return "auto";
    case "min-content":
      return "min-content";
    case "max-content":
      return "max-content";
  }
}

function addSize(declarations: string[], axis: "width" | "height", mode: "fixed" | "fill" | "hug", value: number, parent: DesignNode | undefined): void {
  if (mode === "fixed") declarations.push(`${axis}:${px(value)}`);
  else if (mode === "hug") declarations.push(`${axis}:fit-content`);
  else if (parent?.layout.mode === "stack") {
    const mainAxis = parent.layout.direction === "horizontal" ? "width" : "height";
    if (axis === mainAxis) declarations.push("flex:1 1 0", `${axis}:auto`);
    else declarations.push(`${axis}:100%`);
  }
  // Grid 子节点的 fill 尺寸由 grid 轨道决定：宽度填满轨道用 stretch，
  // 高度同理。这里不写 width/height，让 grid 布局自己算。
  else if (parent?.layout.mode === "grid") {
    if (mode === "fill") declarations.push(`${axis}:100%`);
  }
  else declarations.push(`${axis}:100%`);
}

function buildCss(document: DesignDocument, options: HtmlExportOptions, tokenVariables: Record<string, string>): string {
  const variables = Object.entries(document.tokens).map(([name, token]) => `  ${tokenVariables[name]}: ${cssTokenValue(token.value)};`).join("\n");
  // 页面里有混合模式时给页面加 isolation：混合只应该在页面内部发生，
  // 不然会跟页面外的背景（浏览器窗口底色）混在一起。
  // 没有混合模式的旧文档不加这一行，导出产物逐字不变。
  const isolation = documentUsesBlendMode(document) ? " isolation:isolate;" : "";
  return [
    ":root {",
    variables,
    "}",
    "* { box-sizing: border-box; }",
    "html, body { margin: 0; min-height: 100%; }",
    `.design-page { position: relative; overflow: hidden; width: ${px(options.viewport.width)}; height: ${px(options.viewport.height)};${isolation} }`,
    ".design-node { min-width: 0; min-height: 0; }",
  ].filter(Boolean).join("\n");
}

/** 文档里有没有节点真的用了混合模式（`normal` 不算）。 */
function documentUsesBlendMode(document: DesignDocument): boolean {
  return Object.values(document.nodes).some(node => node.visible !== false && cssBlendMode(node.appearance.blendMode) !== undefined);
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

/**
 * 文本内容：没有段内样式时就是转义后的纯文本（产物与升级前逐字一致）；
 * 有 runs 时按区间切成 `<span>`，只写被覆盖的字段，其余继承 `<p>` 的样式。
 */
function textHtml(node: TextNode): string {
  if (!node.runs?.length) return escapeHtml(node.text);
  return textRunSegments(node.text, node.runs).map(segment => {
    const declarations: string[] = [];
    if (segment.style.fontWeight !== undefined) declarations.push(`font-weight:${segment.style.fontWeight}`);
    if (segment.style.fontStyle !== undefined) declarations.push(`font-style:${segment.style.fontStyle}`);
    if (segment.style.fontSize !== undefined) declarations.push(`font-size:${px(segment.style.fontSize)}`);
    if (segment.style.color !== undefined) declarations.push(`color:${safeCssValue(segment.style.color)}`);
    const body = escapeHtml(segment.text);
    return declarations.length ? `<span style="${escapeAttribute(declarations.join(";"))}">${body}</span>` : body;
  }).join("");
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

/** 填充层 → CSS 背景值。颜色 token 绑定由 resolveFills 提前压成实色。 */
function cssPaint(node: DesignNode, paint: Paint, tokenVariables: Record<string, string>): string {
  if (paint.type === "solid") return boundValue(node.bindings?.fill, paint.color, tokenVariables);
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset)
    .map(stop => `${safeCssValue(stop.color)} ${num(stop.offset * 100)}%`)
    .join(", ");
  if (paint.type === "linear") return `linear-gradient(${num(paint.angle)}deg, ${stops})`;
  if (paint.type === "radial") {
    // CSS 的 circle 半径不接受百分比，所以用 px：按布局尺寸算，和画布/SVG 的半径一致。
    // 代价是节点被拉伸时渐变的半径不会跟着缩放（导出产物里通常无所谓）。
    const radius = paint.r * Math.max(node.layout.width, node.layout.height);
    return `radial-gradient(circle ${num(radius)}px at ${num(paint.cx * 100)}% ${num(paint.cy * 100)}%, ${stops})`;
  }
  // 椭圆渐变：CSS 的 ellipse 尺寸是「水平半径 垂直半径」两个值。
  // 半径同样用 px（CSS 的 ellipse 半径也不接受百分比）。
  const rx = paint.rx * node.layout.width;
  const ry = paint.ry * node.layout.height;
  return `radial-gradient(ellipse ${num(rx)}px ${num(ry)}px at ${num(paint.cx * 100)}% ${num(paint.cy * 100)}%, ${stops})`;
}
/**
 * 多层填充时的一层 CSS 背景图。
 *
 * `background-color` 只有一个，所以除最底层外的实色必须写成 `linear-gradient(色, 色)`，
 * 才能作为 background-image 参与叠层。
 */
function cssBackgroundLayer(node: DesignNode, paint: Paint, tokenVariables: Record<string, string>): string {
  if (paint.type === "solid") {
    const color = boundValue(node.bindings?.fill, paint.color, tokenVariables);
    return `linear-gradient(${color}, ${color})`;
  }
  return cssPaint(node, paint, tokenVariables);
}