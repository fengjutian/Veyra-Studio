import { tokenColor, type DesignDocument, type DesignNode, type NodeId } from "@ufira/design-schema";

/**
 * 可访问性检查（当前覆盖对比度）。
 *
 * 不启动浏览器也能做的部分：从文档里解析文本色与最近的背景色，按 WCAG 2.x 的
 * 相对亮度公式算对比度，低于阈值就报出来。这里不做渲染，因此结果是"设计意图"
 * 层面的——导出的 HTML/SVG 会继承同样的颜色，检查结论对交付物同样成立。
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 解析 #rgb / #rrggbb；其它写法返回 undefined（包括 token、透明、渐变）。 */
export function parseHexColor(value: string | undefined): Rgb | undefined {
  if (!value) return undefined;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const hex = match[1]!;
  const expand = (part: string) => Number.parseInt(part.length === 1 ? part + part : part, 16);
  if (hex.length === 3) return { r: expand(hex[0]!), g: expand(hex[1]!), b: expand(hex[2]!) };
  return { r: expand(hex.slice(0, 2)), g: expand(hex.slice(2, 4)), b: expand(hex.slice(4, 6)) };
}

/** WCAG 相对亮度。 */
export function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** 两色的对比度（1–21）。任意一色解析失败时返回 undefined。 */
export function contrastRatio(foreground: string | undefined, background: string | undefined): number | undefined {
  const front = parseHexColor(foreground);
  const back = parseHexColor(background);
  if (!front || !back) return undefined;
  const lighter = Math.max(relativeLuminance(front), relativeLuminance(back));
  const darker = Math.min(relativeLuminance(front), relativeLuminance(back));
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 定义的"大字号"：≥24px，或 ≥18.66px 且加粗。大字号阈值是 3:1。 */
export function isLargeText(fontSize: number, fontWeight: number): boolean {
  return fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
}

/** 普通正文 4.5:1，大字号 3:1。 */
export function contrastThreshold(fontSize: number, fontWeight: number): number {
  return isLargeText(fontSize, fontWeight) ? 3 : 4.5;
}

export interface ContrastIssue {
  nodeId: NodeId;
  text: string;
  foreground: string;
  background: string;
  ratio: number;
  threshold: number;
}

const PAGE_BACKGROUND = "#ffffff";

/** 文本节点的有效前景色：token 绑定优先，其次自身 fill。 */
function effectiveFill(document: DesignDocument, node: DesignNode): string | undefined {
  return tokenColor(document, node.bindings?.fill) ?? node.appearance.fill;
}

/**
 * 最近的、可解析的背景色。
 *
 * 沿父链找第一个有 fill 的节点（token 也算），都没有就用页面白底。透明度、渐变、
 * 图片背景不在当前检查范围内——它们需要真实渲染才能判断。
 */
export function effectiveBackground(document: DesignDocument, node: DesignNode): string {
  let current: NodeId | undefined = node.parentId;
  const visited = new Set<NodeId>();
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
    const ancestor: DesignNode | undefined = document.nodes[current];
    if (!ancestor) break;
    const fill = effectiveFill(document, ancestor);
    if (fill && parseHexColor(fill)) return fill;
    current = ancestor.parentId;
  }
  return PAGE_BACKGROUND;
}

/** 收集对比度不足的文本节点；结果按对比度从低到高，便于优先处理。 */
export function collectContrastIssues(document: DesignDocument): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "text" || !node.text.trim()) continue;
    const foreground = effectiveFill(document, node);
    const background = effectiveBackground(document, node);
    const ratio = contrastRatio(foreground, background);
    if (ratio === undefined) continue;
    const threshold = contrastThreshold(node.fontSize, node.fontWeight ?? 400);
    if (ratio < threshold) {
      issues.push({ nodeId: node.id, text: node.text, foreground: foreground ?? "", background, ratio, threshold });
    }
  }
  return issues.sort((left, right) => left.ratio - right.ratio);
}
