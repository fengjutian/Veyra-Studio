import { computePageLayout, type ComputedBox } from "@ufira/design-layout";
import { TEXT_DEFAULTS, absolutePath, gradientLine, radialGeometry, pathDataFromCommands, resolveCornerRadii, resolveFills, resolveRadius, resolveStroke, textRunSegments, validateDocument, vectorPathCommands, type CornerRadii, type DesignDocument, type DesignNode, type Paint, type TextNode } from "@ufira/design-schema";
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
  // 蒙版要生成 <clipPath>，先收集再在文档末尾统一输出（SVG 允许 defs 出现在任意位置）。
  const state: MaskState = { defs: [], nextId: 1 };
  const body = renderSiblingList(document, exportRootIds(document, options.pageId, keep), boxes, options, tokenVariables, diagnostics, keep, state);
  const title = escapeXml(options.title ?? `${document.meta.name} — ${page.name}`);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(options.viewport.width)}" height="${num(options.viewport.height)}" viewBox="0 0 ${num(options.viewport.width)} ${num(options.viewport.height)}" data-page-id="${escapeXml(page.id)}">`,
    `  <title>${title}</title>`,
    renderTokenStyles(document, tokenVariables),
    body ? indent(body, 2) : "",
    state.defs.length ? `  <defs>\n${indent(state.defs.join("\n"), 4)}\n  </defs>` : "",
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
  keep: Set<string> | undefined,
  state: MaskState,
): string {
  const node = document.nodes[nodeId];
  if (!node) return "";
  if (!node.visible) {
    diagnostics.push({ nodeId, feature: "hidden-node", support: "exact", message: `Hidden node ${nodeId} was skipped` });
    return "";
  }
  // 蒙版节点自身不渲染；父级在 renderChildren 里把它转成 <clipPath>。
  if (node.mask) return "";

  // 布局引擎给出的坐标是页面绝对坐标，所以导出原点对所有节点统一平移。
  const raw = boxes[nodeId] ?? { x: node.layout.x, y: node.layout.y, width: node.layout.width, height: node.layout.height };
  const box = shiftBox(raw, options.origin);
  // 填充层：多层时样式里的 fill 置空，改由下面逐层输出的图元自己带 fill。
  const fillValues = paintValues(document, node, box, tokenVariables, state);
  const multiFill = fillValues.length > 1;
  const style = nodeStyle(document, node, tokenVariables, multiFill ? "none" : fillValues[0] ?? "none");
  // 旋转绕盒子中心，与画布/HTML 一致；导出坐标已经平移到视口，中心也一起平移。
  const rotation = node.layout.rotation ?? 0;
  const transform = rotation
    ? ` transform="rotate(${num(rotation)} ${num(box.x + box.width / 2)} ${num(box.y + box.height / 2)})"`
    : "";
  // 阴影/模糊走 <filter>；同一个 filter 挂在 <g> 上时会连子节点一起处理，与 Figma 的图层效果一致。
  const effect = node.appearance.shadow || node.appearance.blur ? registerEffect(node, state) : undefined;
  const common = `data-node-id="${escapeXml(node.id)}" style="${escapeXml(style)}"${transform}${effect ? ` filter="url(#${effect})"` : ""}`;

  if (node.type === "text") {
    // SVG 没有 text-align，用 text-anchor + x 表达盒内对齐。
    const textAlign = node.textAlign ?? TEXT_DEFAULTS.textAlign;
    const x = textAlign === "center" ? box.x + box.width / 2 : textAlign === "right" ? box.x + box.width : box.x;
    const anchor = textAlign === "center" ? " text-anchor=\"middle\"" : textAlign === "right" ? " text-anchor=\"end\"" : "";
    return `<text ${common} x="${num(x)}" y="${num(box.y)}" dominant-baseline="hanging"${anchor}>${textTspans(node)}</text>`;
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
    const commands = node.geometry ? vectorPathCommands(node.geometry.d) : [];
    if (!commands.length) {
      // 旧文档里的 vector 只有类型、没有几何：保持「空容器 + 诊断」的既有行为，
      // 导出产物因此与升级前逐字一致。
      diagnostics.push({ nodeId, feature: "vector", support: "unsupported", message: "Vector node has no path geometry and is exported as an empty container" });
    } else {
      // 路径坐标是归一化的，先换算成导出坐标系里的绝对坐标再写 d，
      // 这样导出结果与画布/命中用的是同一套几何，不依赖 `<g>` 的 transform。
      const d = pathDataFromCommands(absolutePath(commands, box));
      const vectorChildren = renderChildren(document, node, boxes, options, tokenVariables, diagnostics, keep, state);
      const vectorPaths = fillValues.length ? fillValues.map(fill => `<path d="${escapeXml(d)}" fill="${escapeXml(fill)}" />`).join("") : `<path d="${escapeXml(d)}" />`;
      return `<g ${common}>${multiFill ? vectorPaths : `<path d="${escapeXml(d)}" />`}${vectorChildren ? `\n${indent(vectorChildren, 2)}\n` : ""}</g>`;
    }
  }
  if (node.type === "instance") {
    diagnostics.push({ nodeId, feature: "component-instance", support: "approximated", message: "Instance export uses the materialized instance children" });
    const overrides = Object.keys(node.overrides ?? {}).length;
    if (overrides) {
      diagnostics.push({ nodeId, feature: "component-override", support: "exact", message: `Instance exports ${overrides} overridden node${overrides === 1 ? "" : "s"} from its materialized children` });
    }
  }

  const children = renderChildren(document, node, boxes, options, tokenVariables, diagnostics, keep, state);
  const radii = resolveCornerRadii(document, node);
  const perCorner = radii && radii.some(value => value !== radii[0]);

  if (node.type === "ellipse") {
    const cx = num(box.x + box.width / 2);
    const cy = num(box.y + box.height / 2);
    const rx = num(box.width / 2);
    const ry = num(box.height / 2);
    if (multiFill) {
      const layers = fillValues.map(fill => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${escapeXml(fill)}" />`).join("");
      return `<g ${common}>${layers}${children ? `\n${indent(children, 2)}\n` : ""}</g>`;
    }
    return `<ellipse ${common} cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" />${children ? `\n${indent(children, 2)}\n` : ""}`;
  }

  if (radii && perCorner) {
    // SVG 的 <rect rx> 只有单值，四角不同只能用路径表达（圆弧是导出产物，不是文档格式）。
    const d = roundedRectPathData(box, radii);
    const roundedLayers = multiFill
      ? fillValues.map(fill => `<path d="${escapeXml(d)}" fill="${escapeXml(fill)}" />`).join("")
      : `<path d="${escapeXml(d)}" />`;
    return `<g ${common}>${roundedLayers}${children ? `\n${indent(children, 2)}\n` : ""}</g>`;
  }

  const radius = radii ? radii[0]! : resolveRadius(document, node) ?? 0;
  const rectLayers = multiFill
    ? fillValues.map(fill => `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radius > 0 ? ` rx="${num(radius)}"` : ""} fill="${escapeXml(fill)}" />`).join("") + "  "
    : `  <rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radius > 0 ? ` rx="${num(radius)}"` : ""} />`;
  return `<g ${common}>${rectLayers}${children ? `\n${indent(children, 2)}\n` : ""}</g>`;
}

/**
 * 四角不同的矩形路径（绝对坐标）。
 *
 * 半径为 0 的角写 `A 0 0 …`：SVG 规范里退化成直线，因此不需要为每个角写分支。
 */
function roundedRectPathData(box: ComputedBox, radii: CornerRadii): string {
  const limit = Math.max(0, Math.min(box.width, box.height) / 2);
  const [topLeft, topRight, bottomRight, bottomLeft] = radii.map(value => Math.min(Math.max(value, 0), limit)) as CornerRadii;
  const { x, y, width, height } = box;
  const arc = (radius: number) => `A ${num(radius)} ${num(radius)} 0 0 1`;
  return [
    `M ${num(x + topLeft)} ${num(y)}`,
    `L ${num(x + width - topRight)} ${num(y)}`,
    `${arc(topRight)} ${num(x + width)} ${num(y + topRight)}`,
    `L ${num(x + width)} ${num(y + height - bottomRight)}`,
    `${arc(bottomRight)} ${num(x + width - bottomRight)} ${num(y + height)}`,
    `L ${num(x + bottomLeft)} ${num(y + height)}`,
    `${arc(bottomLeft)} ${num(x)} ${num(y + height - bottomLeft)}`,
    `L ${num(x)} ${num(y + topLeft)}`,
    `${arc(topLeft)} ${num(x + topLeft)} ${num(y)}`,
    "Z",
  ].join(" ");
}

function renderChildren(
  document: DesignDocument,
  node: DesignNode,
  boxes: Record<string, ComputedBox>,
  options: SvgExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep: Set<string> | undefined,
  state: MaskState,
): string {
  return renderSiblingList(document, node.childIds, boxes, options, tokenVariables, diagnostics, keep, state);
}

/**
 * 渲染一组同级节点，并把蒙版翻译成 `<clipPath>`。
 *
 * 页面直属节点和容器子节点共用这一条路径——否则页面级的蒙版会静默失效
 * （渲染与导出的蒙版语义必须一致）。
 */
function renderSiblingList(
  document: DesignDocument,
  ids: readonly string[],
  boxes: Record<string, ComputedBox>,
  options: SvgExportOptions,
  tokenVariables: Record<string, string>,
  diagnostics: ExportDiagnostic[],
  keep: Set<string> | undefined,
  state: MaskState,
): string {
  const parts: string[] = [];
  const masks: DesignNode[] = [];
  for (const childId of ids) {
    if (keep && !keep.has(childId)) continue;
    const childNode = document.nodes[childId];
    if (!childNode) continue;
    // 蒙版自身不渲染，只作为后面兄弟的 <clipPath>。
    if (childNode.mask) { masks.push(childNode); continue; }
    const rendered = renderNode(document, childId, boxes, options, tokenVariables, diagnostics, keep, state);
    if (!rendered) continue;
    if (!masks.length) { parts.push(rendered); continue; }
    // 多层蒙版：每层包一个 <g>，嵌套即叠加。
    let wrapped = rendered;
    for (const mask of masks) {
      const id = registerMaskClip(document, mask, boxes, options, state);
      wrapped = `<g clip-path="url(#${id})">\n${indent(wrapped, 2)}\n</g>`;
    }
    parts.push(wrapped);
  }
  return parts.join("\n");
}

interface MaskState {
  defs: string[];
  nextId: number;
}

/** 把蒙版几何写成 <clipPath> 并返回 id；同一个蒙版只登记一次。 */
function registerMaskClip(document: DesignDocument, mask: DesignNode, boxes: Record<string, ComputedBox>, options: SvgExportOptions, state: MaskState): string {
  const id = `mask-${state.nextId++}`;
  const raw = boxes[mask.id] ?? { x: mask.layout.x, y: mask.layout.y, width: mask.layout.width, height: mask.layout.height };
  const box = shiftBox(raw, options.origin);
  const shape = maskShape(document, mask, box);
  state.defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${shape}</clipPath>`);
  return id;
}

/** 蒙版几何：只取轮廓，不带填充/描边样式。 */
function maskShape(document: DesignDocument, mask: DesignNode, box: ComputedBox): string {
  if (mask.type === "ellipse") {
    return `<ellipse cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}" />`;
  }
  if (mask.type === "vector" && mask.geometry) {
    return `<path d="${escapeXml(pathDataFromCommands(absolutePath(vectorPathCommands(mask.geometry.d), box)))}" />`;
  }
  if (mask.type === "vector") {
    // 没有几何的旧 vector 当蒙版：按空容器处理，裁剪掉全部内容，与画布一致。
    return "";
  }
  const radii = resolveCornerRadii(document, mask);
  const perCorner = radii && radii.some(value => value !== radii[0]);
  if (perCorner) return `<path d="${escapeXml(roundedRectPathData(box, radii))}" />`;
  const radius = radii ? radii[0]! : 0;
  return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radius > 0 ? ` rx="${num(radius)}"` : ""} />`;
}

/** 把页面绝对坐标平移到导出视口的坐标系。 */
function shiftBox(box: ComputedBox, origin?: { x: number; y: number }): ComputedBox {
  if (!origin) return box;
  return { ...box, x: box.x - origin.x, y: box.y - origin.y };
}

function nodeStyle(document: DesignDocument, node: DesignNode, tokenVariables: Record<string, string>, fillValue: string): string {
  const declarations: string[] = [];
  declarations.push(`opacity:${num(node.appearance.opacity)}`);
  declarations.push(`fill:${fillValue}`);
  if (resolveStroke(document, node) || node.bindings?.stroke) {
    declarations.push(`stroke:${boundValue(node.bindings?.stroke, node.appearance.stroke ?? "transparent", tokenVariables)}`);
    declarations.push(`stroke-width:${num(node.appearance.strokeWidth ?? 1)}`);
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

/**
 * 文本内容：无段内样式时与原实现逐字一致；有 runs 时按区间输出 `<tspan>`。
 *
 * SVG 不会自动换行，这里也不引入换行（与升级前一致），只处理段内样式。
 */
function textTspans(node: TextNode): string {
  if (!node.runs?.length) return escapeXml(node.text);
  return textRunSegments(node.text, node.runs).map(segment => {
    const attributes: string[] = [];
    if (segment.style.fontWeight !== undefined) attributes.push(`font-weight="${num(segment.style.fontWeight)}"`);
    if (segment.style.fontStyle !== undefined) attributes.push(`font-style="${segment.style.fontStyle}"`);
    if (segment.style.fontSize !== undefined) attributes.push(`font-size="${num(segment.style.fontSize)}"`);
    if (segment.style.color !== undefined) attributes.push(`fill="${escapeXml(segment.style.color)}"`);
    const body = escapeXml(segment.text);
    return attributes.length ? `<tspan ${attributes.join(" ")}>${body}</tspan>` : body;
  }).join("");
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

/**
 * 阴影 / 模糊的 `<filter>`。
 *
 * `feDropShadow` 的 `stdDeviation` 与 CSS/Canvas 的模糊半径不是同一量纲：CSS 的模糊半径
 * 约等于 `2 × stdDeviation`，所以这里除以 2。别把它「修正」成直接用 blur。
 */
function registerEffect(node: DesignNode, state: MaskState): string {
  const id = `effect-${state.nextId++}`;
  const primitives: string[] = [];
  if (node.appearance.blur) {
    primitives.push(`<feGaussianBlur stdDeviation="${num(node.appearance.blur / 2)}" />`);
  }
  if (node.appearance.shadow) {
    const shadow = node.appearance.shadow;
    primitives.push(`<feDropShadow dx="${num(shadow.x)}" dy="${num(shadow.y)}" stdDeviation="${num(shadow.blur / 2)}" flood-color="${escapeXml(shadow.color)}" />`);
  }
  // 滤镜区域放大到 200%，否则偏移/模糊到元素外的部分会被裁掉。
  state.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${primitives.join("")}</filter>`);
  return id;
}
/**
 * 填充层的 SVG 值：实色 → 颜色（可带 CSS 变量），渐变 → 登记一条 `<linearGradient>`
 * 并返回 `url(#id)`。
 *
 * 渐变坐标用 `userSpaceOnUse` + 导出坐标系里的盒子，和画布/HTML 用同一套 `gradientLine`，
 * 所以三处朝向一致；`objectBoundingBox` 会在非等比盒子上把方向拉歪。
 */
function paintValues(document: DesignDocument, node: DesignNode, box: ComputedBox, tokenVariables: Record<string, string>, state: MaskState): string[] {
  return resolveFills(document, node).map(paint => paintValue(document, node, paint, box, tokenVariables, state));
}

/** 单层填充的值（多层由 {@link paintValues} 逐层生成）。 */
function paintValue(document: DesignDocument, node: DesignNode, paint: Paint, box: ComputedBox, tokenVariables: Record<string, string>, state: MaskState): string {
  if (paint.type === "solid") return boundValue(node.bindings?.fill, paint.color, tokenVariables);
  const id = `paint-${state.nextId++}`;
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset)
    .map(stop => `<stop offset="${num(stop.offset)}" stop-color="${escapeXml(stop.color)}" />`)
    .join("");
  if (paint.type === "linear") {
    const line = gradientLine(box, paint.angle);
    state.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(line.x1)}" y1="${num(line.y1)}" x2="${num(line.x2)}" y2="${num(line.y2)}">${stops}</linearGradient>`);
  } else {
    const radial = radialGeometry(box, paint);
    state.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(radial.cx)}" cy="${num(radial.cy)}" r="${num(radial.r)}">${stops}</radialGradient>`);
  }
  return `url(#${id})`;
}