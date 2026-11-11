import { primaryFillColor, textFillColor, tokenColor, type DesignDocument, type DesignNode, type NodeId, type TextNode } from "@ufira/design-schema";

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
  // 渐变文本没法逐像素算对比度，按首个色标近似。
  return primaryFillColor(document, node);
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

/**
 * 文本节点**实际渲染出来**的颜色分段。
 *
 * 节点级填充色是底色，段内样式（`runs`）按区间覆盖它——画布、导出、编辑器
 * 都是这个语义（见 `renderer/scene.ts`）。所以对比度必须按段算：只看节点填充色
 * 会漏判「底色浅但整段被 runs 改成深色」的文本。
 *
 * 漏判的后果不只是少报一条：编排循环会盯着这个假问题反复改，改多少遍那个
 * 「问题」都在——真实 Provider 验收里就是这么撞上震荡的。
 */
function colorRanges(document: DesignDocument, node: TextNode): Array<{ color: string; from: number; to: number }> {
  const length = Math.min(node.text.length, MAX_ANALYZED_CHARS);
  // 文字色与渲染端同一套规则（第一层填充 → 渐变取首个色标 → 默认文字色），
  // 否则「没有填充的文本」会被当成无色，真实渲染出来却是深色的。
  const base = textFillColor(document, node);
  const colors: string[] = new Array(length).fill(base ?? "");
  for (const run of node.runs ?? []) {
    if (!run.style?.color) continue;
    const from = Math.max(0, Math.min(length, run.from));
    const to = Math.max(from, Math.min(length, run.to));
    for (let index = from; index < to; index += 1) colors[index] = run.style.color;
  }
  const ranges: Array<{ color: string; from: number; to: number }> = [];
  for (let index = 0; index < length; index += 1) {
    const last = ranges[ranges.length - 1];
    if (last && last.color === colors[index]) last.to = index + 1;
    else ranges.push({ color: colors[index]!, from: index, to: index + 1 });
  }
  return ranges;
}

/** 一次只分析这么多字符：超长文本按开头截断，避免一次检查变成 O(n²)。 */
const MAX_ANALYZED_CHARS = 2000;

/** 收集对比度不足的文本节点；结果按对比度从低到高，便于优先处理。 */
export function collectContrastIssues(document: DesignDocument): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "text" || !node.text.trim()) continue;
    const background = effectiveBackground(document, node);
    const threshold = contrastThreshold(node.fontSize, node.fontWeight ?? 400);
    for (const range of colorRanges(document, node)) {
      if (!range.color) continue;
      const ratio = contrastRatio(range.color, background);
      if (ratio === undefined) continue;
      if (ratio >= threshold) continue;
      issues.push({
        nodeId: node.id,
        text: node.text.slice(range.from, range.to).replace(/\s+/g, " ").trim(),
        foreground: range.color,
        background,
        ratio,
        threshold,
      });
    }
  }
  return issues.sort((left, right) => left.ratio - right.ratio);
}
