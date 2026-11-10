import {
  LIST_INDENT_STEP,
  LIST_MARKER_WIDTH,
  MAX_LIST_INDENT,
  absolutePath,
  applyThemeTokens,
  computeBooleanGeometry,
  ellipticalGeometry,
  ellipticalGradientMatrix,
  gradientLine,
  pathDataFromCommands,
  radialGeometry,
  resolveFills,
  resolveParagraphs,
  textRunSegments,
  textRunSegmentsInRange,
  validateDocument,
  vectorPathCommands,
  type AssetMetadata,
  type DesignDocument,
  type DesignNode,
  type Paint,
  type TextNode,
} from "@ufira/design-schema";
import {
  boundValue,
  createTokenVariables,
  documentUsesBlendMode,
  maskClipPath,
  nodeStyle,
  num,
  safeAssetUrl,
} from "./html";
import { exportNodeSet, exportRootIds } from "./selection";
import type { ExportDiagnostic } from "./types";

/**
 * 设计 → 代码：把一页导出成 React 组件。
 *
 * ## 为什么不是「再写一套导出」
 *
 * 样式计算只有一份（`html.ts` 的 `nodeStyle`），HTML 与 React 导出共用它。
 * 两边各自只做**序列化**：HTML 拼成 CSS 文本，React 转成 style 对象。
 * 规则写两遍的话，改一处忘一处，导出的组件就会和设计稿长得不一样——
 * 而「长得一样」正是这个功能存在的理由。
 *
 * 端到端探针（`packages/studio-web/visual/react-export-probe.ts`）会在真实浏览器里
 * 把 React 组件与 HTML 导出各渲染一遍，逐像素比对。
 *
 * ## 什么变成了 prop
 *
 * 文字内容与图片地址是**内容**，其余是**样式**：内容提出来当 prop，样式留在代码里。
 * 这也是设计稿转代码的通行做法——改文案不该去改样式表。
 *
 * 有段内样式（`runs`）或段落样式的文本节点不做 prop 化：它们的结构与文字是一体的，
 * 提成字符串 prop 就丢了分段信息。这类情况会记一条诊断，不装作做了。
 */

export interface ReactExportOptions {
  pageId: string;
  viewport: { width: number; height: number };
  /** 组件名；不给就用页面名。 */
  componentName?: string;
  /** 主题 id：导出前把该主题的 token 覆盖合并进来；不传用基础值。 */
  themeId?: string;
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
  /** 只导出包含这些节点的分支；不传则导出整页。 */
  nodeIds?: string[];
  /** 视口原点：导出坐标会减去该偏移，用来把选区裁剪到画布左上角。 */
  origin?: { x: number; y: number };
}

export interface ReactExportProp {
  name: string;
  /** 目前只有字符串（文字内容、图片地址）。 */
  type: "string";
  /** 人话说明：这个 prop 对应哪个节点。 */
  description: string;
  /** 导出时的默认值。 */
  defaultValue?: string;
}

export interface ReactExportResult {
  /** 组件源码（TSX）。 */
  code: string;
  componentName: string;
  props: ReactExportProp[];
  diagnostics: ExportDiagnostic[];
}

interface RenderContext {
  document: DesignDocument;
  options: ReactExportOptions;
  tokenVariables: Record<string, string>;
  diagnostics: ExportDiagnostic[];
  props: ReactExportProp[];
  /** 已占用的 prop 名，避免重名。 */
  propNames: Set<string>;
  /** SVG 渐变 id 的序号：同一份产物里 id 必须唯一。 */
  gradientSeq: number;
}

export function exportPageToReact(documentInput: DesignDocument, options: ReactExportOptions): ReactExportResult {
  const document = applyThemeTokens(validateDocument(documentInput), options.themeId);
  const page = document.pages[options.pageId];
  if (!page) throw new Error(`Page ${options.pageId} does not exist`);
  if (!finiteSize(options.viewport)) throw new Error("Viewport dimensions must be finite non-negative numbers");

  const diagnostics: ExportDiagnostic[] = [];
  const context: RenderContext = {
    document,
    options,
    tokenVariables: createTokenVariables(document),
    diagnostics,
    props: [],
    propNames: new Set(),
    gradientSeq: 0,
  };

  const keep = options.nodeIds ? exportNodeSet(document, options.nodeIds) : undefined;
  const body = renderSiblingList(context, exportRootIds(document, options.pageId, keep), undefined, keep, 3);
  const componentName = pascalCase(options.componentName ?? page.name ?? "Design");
  const rootStyle = rootStyleObject(document, options, context.tokenVariables);

  const code = [
    "// 由 AI Design Studio 导出（设计 → 代码）。",
    "// 样式来自设计稿的绝对布局；文字内容与图片地址提成了 props，改 prop 就是改内容。",
    "",
    'import type { CSSProperties } from "react";',
    "",
    "/** CSS 变量（--token-*）不在 CSSProperties 里，所以补一个模板索引签名。 */",
    "type Style = CSSProperties & { [key: `--${string}`]: string | number };",
    "",
    ...propsInterface(context, componentName),
    "",
    ...componentFunction(context, componentName, rootStyle, body),
    "",
  ].join("\n");

  return { code, componentName, props: context.props, diagnostics };
}

/** 根容器样式：对应 HTML 导出里的 `.design-page` + `:root`。 */
function rootStyleObject(
  document: DesignDocument,
  options: ReactExportOptions,
  tokenVariables: Record<string, string>,
): Record<string, string | number> {
  const style: Record<string, string | number> = {
    position: "relative",
    overflow: "hidden",
    width: `${Number(options.viewport.width.toFixed(4))}px`,
    height: `${Number(options.viewport.height.toFixed(4))}px`,
    boxSizing: "border-box",
  };
  // 混合只应该在页面内部发生：不然会跟页面外的背景（浏览器窗口底色）混在一起。
  if (documentUsesBlendMode(document)) style.isolation = "isolate";
  // CSS 变量定义在根元素上（自定义属性会继承），子节点里的 `var(--x)` 因此能取到值。
  for (const [name, variable] of Object.entries(tokenVariables)) {
    const token = document.tokens[name];
    if (!token) continue;
    if (typeof token.value !== "string" && typeof token.value !== "number") continue;
    style[variable] = typeof token.value === "number" ? String(token.value) : token.value.replace(/[;{}]/g, "").trim();
  }
  return style;
}

function propsInterface(context: RenderContext, componentName: string): string[] {
  const lines = [`export interface ${componentName}Props {`];
  for (const prop of context.props) {
    lines.push(`  /** ${prop.description} */`);
    lines.push(`  ${prop.name}?: ${prop.type};`);
  }
  lines.push("  /** 根节点附加的类名。 */");
  lines.push("  className?: string;");
  lines.push("}");
  return lines;
}

function componentFunction(
  context: RenderContext,
  componentName: string,
  rootStyle: Record<string, string | number>,
  body: string,
): string[] {
  // 默认值写在解构里：调用方不传 prop 时就是设计稿里的内容。
  const destructured = context.props.length
    ? `{ ${[...context.props.map(prop => `${prop.name} = ${prop.defaultValue === undefined ? "undefined" : JSON.stringify(prop.defaultValue)}`), "className"].join(", ")} }`
    : "{ className }";
  return [
    `export function ${componentName}(${destructured}: ${componentName}Props) {`,
    "  const style: Style = {",
    styleBody(rootStyle, 2),
    "  };",
    "  return (",
    "    <div",
    "      className={className}",
    "      style={style}",
    "    >",
    body,
    "    </div>",
    "  );",
    "}",
  ];
}

/** 兄弟节点列表；蒙版会变成一层带裁剪的包装。 */
function renderSiblingList(
  context: RenderContext,
  ids: readonly string[],
  parent: DesignNode | undefined,
  keep: Set<string> | undefined,
  depth: number,
): string {
  const parts: string[] = [];
  const masks: DesignNode[] = [];
  for (const childId of ids) {
    if (keep && !keep.has(childId)) continue;
    const child = context.document.nodes[childId];
    if (!child) continue;
    if (child.mask) {
      masks.push(child);
      continue;
    }
    const rendered = renderNode(context, childId, parent, keep, depth);
    if (!rendered) continue;
    let wrapped = rendered;
    for (const mask of masks) {
      const clip = maskClipPath(context.document, mask);
      if (!clip) continue;
      const wrapper = [
        `${"  ".repeat(depth)}<div`,
        `${"  ".repeat(depth)}  style={{ position: "absolute", inset: 0, clipPath: ${JSON.stringify(`path('${clip}')`)} }}`,
        `${"  ".repeat(depth)}>`,
        indentBlock(wrapped, depth + 1),
        `${"  ".repeat(depth)}</div>`,
      ].join("\n");
      wrapped = wrapper;
    }
    parts.push(wrapped);
  }
  return parts.join("\n");
}

function renderNode(
  context: RenderContext,
  nodeId: string,
  parent: DesignNode | undefined,
  keep: Set<string> | undefined,
  depth: number,
): string {
  const document = context.document;
  const node = document.nodes[nodeId];
  if (!node) return "";
  // 蒙版节点自身不渲染；父级在兄弟循环里把它转成裁剪容器。
  if (node.mask) return "";
  const style = styleObject(nodeStyle(document, node, parent, context.tokenVariables, context.options.origin));
  // HTML 导出靠两条全局规则兜底：`* { box-sizing: border-box }` 与
  // `.design-node { min-width: 0; min-height: 0 }`。React 没有全局选择器，
  // 这两条得逐节点写上，否则带描边的节点会大出 2px，导出的组件就和设计稿对不上。
  style.boxSizing = "border-box";
  style.minWidth = 0;
  style.minHeight = 0;
  const attributes = [`data-node-id=${JSON.stringify(node.id)}`, `style={${styleLiteral(style, depth * 2 + 2)}}`];

  if (node.type === "text") {
    if (!node.paragraphStyles?.length) {
      const propName = registerTextProp(context, node);
      const children = propName ? `{${propName}}` : textChildren(node, depth + 1);
      return element("p", attributes, children, depth);
    }
    return element("div", attributes, paragraphBlocks(context, node, depth + 1), depth);
  }

  if (node.type === "image") {
    const asset = document.assets[node.assetId];
    const rawUrl = asset ? context.options.resolveAsset?.(asset) : undefined;
    if (!rawUrl || !safeAssetUrl(rawUrl)) {
      context.diagnostics.push({
        nodeId: node.id,
        feature: "image-asset",
        support: "unsupported",
        message: rawUrl ? "Unsafe image URL was rejected" : `No export URL was provided for asset ${node.assetId}`,
      });
      return element("div", [...attributes, `role="img"`, `aria-label=${JSON.stringify(node.name)}`], "", depth, true);
    }
    const propName = registerImageProp(context, node, rawUrl);
    return element("img", [...attributes, `src={${propName}}`, `alt=${JSON.stringify(node.name)}`], "", depth, true);
  }

  if (node.type === "boolean") {
    const commands = computeBooleanGeometry(document, node, {}, node.layout);
    if (!commands?.length) {
      context.diagnostics.push({ nodeId: node.id, feature: "boolean", support: "unsupported", message: "Boolean group produced an empty shape" });
      return element("div", attributes, "", depth);
    }
    return renderVector(context, node as unknown as DesignNode & { type: "vector" }, attributes, commands, depth);
  }

  if (node.type === "vector") {
    const commands = node.geometry ? vectorPathCommands(node.geometry.d) : [];
    if (!commands.length) {
      context.diagnostics.push({ nodeId: node.id, feature: "vector", support: "unsupported", message: "Vector node has no path geometry and is exported as an empty container" });
      return element("div", attributes, "", depth);
    }
    return renderVector(context, node, attributes, commands, depth);
  }

  if (node.type === "instance") {
    context.diagnostics.push({ nodeId: node.id, feature: "component-instance", support: "approximated", message: "Instance export currently uses only materialized instance children" });
  }

  const children = renderChildren(context, node, keep, depth + 1);
  return element("div", attributes, children, depth);
}

function renderChildren(
  context: RenderContext,
  node: DesignNode,
  keep: Set<string> | undefined,
  depth: number,
): string {
  return renderSiblingList(context, node.childIds, node, keep, depth);
}

/** 一个 JSX 元素（带缩进）。 */
function element(tag: string, attributes: string[], children: string, depth: number, selfClosing = false): string {
  const pad = "  ".repeat(depth);
  const head = attributes.map(attribute => `${pad}  ${attribute}`).join("\n");
  if (!children) {
    return selfClosing
      ? [`${pad}<${tag}`, head, `${pad}/>`].join("\n")
      : [`${pad}<${tag}`, head, `${pad}></${tag}>`].join("\n");
  }
  // 多行的子内容已经按自己的深度排好版；单行的（`{title}`、文字）按当前深度缩进。
  const body = children.includes("\n") ? children : `${pad}  ${children}`;
  return [`${pad}<${tag}`, head, `${pad}>`, body, `${pad}</${tag}>`].join("\n");
}

/**
 * 矢量节点输出内联 `<svg>`。
 *
 * 与 HTML 导出同一套几何与渐变写法，只是属性名换成 JSX 的驼峰写法。
 */
function renderVector(
  context: RenderContext,
  node: DesignNode & { type: "vector" },
  attributes: string[],
  commands: ReturnType<typeof vectorPathCommands>,
  depth: number,
): string {
  const document = context.document;
  const width = Math.max(node.layout.width, 1);
  const height = Math.max(node.layout.height, 1);
  const d = pathDataFromCommands(absolutePath(commands, { x: 0, y: 0, width, height }));
  const fills = resolveFills(document, node);
  const defs: string[] = [];
  const hasStroke = Boolean(node.appearance.stroke || node.bindings?.stroke);
  const stroke = hasStroke ? boundValue(node.bindings?.stroke, node.appearance.stroke ?? "transparent", context.tokenVariables) : "none";
  const strokeWidth = node.appearance.strokeWidth ?? 1;
  const attributesOf = (paint: Paint | undefined, index: number): string => {
    let fill = "none";
    if (paint?.type === "solid") {
      fill = boundValue(node.bindings?.fill, paint.color, context.tokenVariables);
    } else if (paint) {
      // 内联 <svg> 里不能用 CSS 渐变函数，只能生成一条 gradient；坐标用 viewBox 的本地空间。
      context.gradientSeq += 1;
      const id = `paint-${context.gradientSeq}`;
      const local = { x: 0, y: 0, width, height };
      const stops = [...paint.stops].sort((a, b) => a.offset - b.offset)
        .map(stop => `<stop key="${stop.offset}" offset=${JSON.stringify(num(stop.offset))} stopColor=${JSON.stringify(stop.color)} />`)
        .join("");
      if (paint.type === "linear") {
        const line = gradientLine(local, paint.angle);
        defs.push(`<linearGradient id=${JSON.stringify(id)} gradientUnits="userSpaceOnUse" x1=${JSON.stringify(num(line.x1))} y1=${JSON.stringify(num(line.y1))} x2=${JSON.stringify(num(line.x2))} y2=${JSON.stringify(num(line.y2))}>${stops}</linearGradient>`);
      } else if (paint.type === "radial") {
        const radial = radialGeometry(local, paint);
        defs.push(`<radialGradient id=${JSON.stringify(id)} gradientUnits="userSpaceOnUse" cx=${JSON.stringify(num(radial.cx))} cy=${JSON.stringify(num(radial.cy))} r=${JSON.stringify(num(radial.r))}>${stops}</radialGradient>`);
      } else {
        const ellipse = ellipticalGeometry(local, paint);
        const matrix = ellipticalGradientMatrix(ellipse, paint.angle ?? 0);
        defs.push(`<radialGradient id=${JSON.stringify(id)} gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform=${JSON.stringify(`matrix(${matrix.map(num).join(" ")})`)}>${stops}</radialGradient>`);
      }
      fill = `url(#${id})`;
    }
    const parts = [`d=${JSON.stringify(d)}`, `fill=${JSON.stringify(fill)}`];
    // 描边只画一次：多层填充重复的是路径本身，不是描边。
    if (index === 0) {
      parts.push(`stroke=${JSON.stringify(stroke)}`);
      if (hasStroke) parts.push(`stroke-width=${JSON.stringify(num(strokeWidth))}`);
    }
    return parts.join(" ");
  };
  const paths = fills.length
    ? fills.map((paint, index) => `<path key="${index}" ${attributesOf(paint, index)} />`)
    : [`<path ${attributesOf(undefined, 0)} />`];
  const pad = "  ".repeat(depth + 1);
  const svgStyle = styleLiteral({ display: "block", width: "100%", height: "100%", overflow: "visible" }, 0);
  const svgAttributes = [
    `viewBox=${JSON.stringify(`0 0 ${num(width)} ${num(height)}`)}`,
    `preserveAspectRatio="none"`,
    `style={${svgStyle}}`,
  ].map(attribute => `${pad}  ${attribute}`);
  const defsBlock = defs.length ? [`${pad}  <defs>`, ...defs.map(item => `${pad}    ${item}`), `${pad}  </defs>`] : [];
  const svg = [
    `${pad}<svg`,
    ...svgAttributes,
    `${pad}>`,
    ...defsBlock,
    ...paths.map(item => `${pad}  ${item}`),
    `${pad}</svg>`,
  ].join("\n");
  return element("div", attributes, svg, depth);
}

/** 文本内容：有段内样式时按区间切 `<span>`。 */
function textChildren(node: TextNode, depth: number): string {
  const pad = "  ".repeat(depth);
  if (!node.runs?.length) return `${pad}${jsxText(node.text)}`;
  return textRunSegments(node.text, node.runs).map(segment => {
    const style: Record<string, string | number> = {};
    if (segment.style.fontWeight !== undefined) style.fontWeight = segment.style.fontWeight;
    if (segment.style.fontStyle !== undefined) style.fontStyle = segment.style.fontStyle;
    if (segment.style.fontSize !== undefined) style.fontSize = `${Number(segment.style.fontSize.toFixed(4))}px`;
    if (segment.style.color !== undefined) style.color = segment.style.color;
    if (!Object.keys(style).length) return `${pad}${jsxText(segment.text)}`;
    return `${pad}<span style={${styleLiteral(style, 0)}}>${jsxText(segment.text)}</span>`;
  }).join("\n");
}

/** 一段文字的内容（`[from, to)` 区间）。 */
function textRangeChildren(node: TextNode, from: number, to: number): string {
  if (!node.runs?.length) return jsxText(node.text.slice(from, to));
  return textRunSegmentsInRange(node.text, node.runs, from, to).map(segment => {
    const style: Record<string, string | number> = {};
    if (segment.style.fontWeight !== undefined) style.fontWeight = segment.style.fontWeight;
    if (segment.style.fontStyle !== undefined) style.fontStyle = segment.style.fontStyle;
    if (segment.style.fontSize !== undefined) style.fontSize = `${Number(segment.style.fontSize.toFixed(4))}px`;
    if (segment.style.color !== undefined) style.color = segment.style.color;
    if (!Object.keys(style).length) return jsxText(segment.text);
    return `<span style={${styleLiteral(style, 0)}}>${jsxText(segment.text)}</span>`;
  }).join("");
}

/**
 * 按段落拆块。
 *
 * 与 HTML 导出同一套语义：列表段落用真正的 `<ul>` / `<ol>`（浏览器负责画标记），
 * 普通段落用 `<p>`。
 */
function paragraphBlocks(context: RenderContext, node: TextNode, depth: number): string {
  const paragraphs = resolveParagraphs(node.text, node.paragraphStyles);
  const blocks: string[] = [];
  const pad = "  ".repeat(depth);
  let index = 0;
  // 段落缩进只对左对齐生效（与 Figma 一致）：居中/右对齐时画布会把它扣掉。
  const indentApplies = (node.textAlign ?? "left") === "left";
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index]!;
    if (!paragraph.style.listType) {
      const style: Record<string, string | number> = {};
      if (indentApplies && paragraph.paragraphIndent > 0) style.paddingLeft = `${Number(paragraph.paragraphIndent.toFixed(4))}px`;
      if (paragraph.spaceAfter > 0) style.marginBottom = `${Number(paragraph.spaceAfter.toFixed(4))}px`;
      blocks.push(`${pad}<p style={${styleLiteral(style, 0)}}>${textRangeChildren(node, paragraph.start, paragraph.end)}</p>`);
      index += 1;
      continue;
    }
    const listType = paragraph.style.listType;
    const items: string[] = [];
    while (index < paragraphs.length && paragraphs[index]!.style.listType === listType) {
      const item = paragraphs[index]!;
      const indent = item.style.indent ?? 0;
      // 悬挂列表的标记不占正文宽度：它画在列表框之外，所以标记区宽度为 0。
      const markerWidth = item.hanging ? 0 : LIST_MARKER_WIDTH;
      const style: Record<string, string | number> = {
        paddingLeft: `${Number((indent * LIST_INDENT_STEP + markerWidth + item.paragraphIndent).toFixed(4))}px`,
      };
      if (listType === "ordered") style.listStyleType = orderedListStyle(indent);
      if (item.spaceAfter > 0) style.marginBottom = `${Number(item.spaceAfter.toFixed(4))}px`;
      const value = listType === "ordered" && item.ordinal !== undefined ? ` value=${JSON.stringify(item.ordinal)}` : "";
      items.push(`${pad}  <li${value} style={${styleLiteral(style, 0)}}>${textRangeChildren(node, item.start, item.end)}</li>`);
      index += 1;
    }
    const tag = listType === "ordered" ? "ol" : "ul";
    const listStyle = styleLiteral({ margin: 0, paddingLeft: 0, listStylePosition: "outside" }, 0);
    blocks.push([
      `${pad}<${tag} style={${listStyle}}>`,
      ...items,
      `${pad}</${tag}>`,
    ].join("\n"));
  }
  return blocks.join("\n");
}

/** 有序列表的编号格式：随缩进级别在数字 / 字母 / 罗马数字之间循环。 */
function orderedListStyle(indent: number): string {
  switch (Math.max(0, Math.min(indent, MAX_LIST_INDENT)) % 3) {
    case 0: return "decimal";
    case 1: return "lower-alpha";
    default: return "lower-roman";
  }
}

/** 文字节点 → prop。返回 prop 名；不适合 prop 化时返回 undefined 并记诊断。 */
function registerTextProp(context: RenderContext, node: TextNode): string | undefined {
  if (node.runs?.length) {
    context.diagnostics.push({
      nodeId: node.id,
      feature: "text-prop",
      support: "approximated",
      message: "带段内样式的文本没有提成 prop：分段结构与文字是一体的，拆开就丢了分段信息",
    });
    return undefined;
  }
  const name = uniquePropName(context, camelCase(node.name || node.id), "text");
  context.props.push({
    name,
    type: "string",
    description: `节点「${node.name}」的文字。`,
    defaultValue: node.text,
  });
  return name;
}

/** 图片节点 → prop（地址）。 */
function registerImageProp(context: RenderContext, node: DesignNode, url: string): string {
  const name = uniquePropName(context, `${camelCase(node.name || node.id)}Src`, "image");
  context.props.push({
    name,
    type: "string",
    description: `节点「${node.name}」的图片地址。`,
    defaultValue: url,
  });
  return name;
}

/** 找一个没被占用的 prop 名。 */
function uniquePropName(context: RenderContext, base: string, fallback: string): string {
  const safe = base && /^[\p{L}_$]/u.test(base) ? base : fallback;
  let candidate = safe;
  let suffix = 2;
  while (context.propNames.has(candidate)) candidate = `${safe}${suffix++}`;
  context.propNames.add(candidate);
  return candidate;
}

/** CSS 声明串 → style 对象。 */
function styleObject(css: string): Record<string, string | number> {
  const style: Record<string, string | number> = {};
  for (const declaration of css.split(";")) {
    const trimmed = declaration.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) continue;
    const property = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!property || !value) continue;
    style[reactStyleKey(property)] = reactStyleValue(value);
  }
  return style;
}

/** CSS 属性名 → React style 键（驼峰）。自定义属性保持原样。 */
function reactStyleKey(property: string): string {
  if (property.startsWith("--")) return property;
  return property.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
}

/**
 * CSS 值 → React style 值。
 *
 * 纯数字转成数字类型：`font-weight: 700` 若写成字符串 `"700"`，TypeScript 会
 * 报类型错误（`Property.FontWeight` 不接受任意字符串）。React 只给**数字**
 * 补 `px`，而这里会变成数字的值只有 `opacity` 与 `font-weight`——两个都是无单位量。
 */
function reactStyleValue(value: string): string | number {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** style 对象 → JS 字面量的内部行（不含最外层花括号）。 */
function styleBody(style: Record<string, string | number>, indent: number): string {
  const inner = " ".repeat(indent + 2);
  return Object.entries(style)
    .map(([key, value]) => `${inner}${propertyKey(key)}: ${JSON.stringify(value)},`)
    .join("\n");
}

/** style 对象 → JS 字面量。条目少时写成一行，多了才展开。 */
function styleLiteral(style: Record<string, string | number>, indent: number): string {
  const entries = Object.entries(style);
  if (!entries.length) return "{}";
  if (entries.length <= 3) {
    return `{ ${entries.map(([key, value]) => `${propertyKey(key)}: ${JSON.stringify(value)}`).join(", ")} }`;
  }
  const pad = " ".repeat(indent);
  return `{\n${styleBody(style, indent)}\n${pad}}`;
}

/** 对象键：合法标识符直接写，其它加引号（CSS 变量就是这种）。 */
function propertyKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

/** JSX 文本：安全字符直接写，其它用字符串表达式（`{` 与 `}` 会截断 JSX）。 */
function jsxText(text: string): string {
  if (!/[<>{}&]/.test(text)) return text;
  return `{${JSON.stringify(text)}}`;
}

/**
 * 名字 → 驼峰 prop 名。
 *
 * 字母（含中日韩文字）与数字算作词的一部分：中文设计稿的节点名直接可用，
 * 不用先翻译一遍。其余字符当分隔符。
 */
function camelCase(value: string): string {
  const words = value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";
  const head = words[0]!.toLowerCase();
  const tail = words.slice(1).map(word => word[0]!.toUpperCase() + word.slice(1)).join("");
  return `${head}${tail}`;
}

/**
 * 名字 → 组件名（帕斯卡）。
 *
 * 不复用 {@link camelCase}：那会把首字母之后的小写也吃掉，`CanvasFixture`
 * 会被压成 `Canvasfixture`。这里只把每个词的首字母大写。
 */
function pascalCase(value: string): string {
  const words = value
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "Design";
  return words.map(word => word[0]!.toUpperCase() + word.slice(1)).join("");
}

/** 给多行文本加缩进。 */
function indentBlock(value: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return value.split("\n").map(line => (line ? `${pad}${line}` : line)).join("\n");
}

function finiteSize(size: { width: number; height: number }): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width >= 0 && size.height >= 0;
}
