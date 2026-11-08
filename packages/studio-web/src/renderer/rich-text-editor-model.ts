import {
  LIST_INDENT_STEP,
  LIST_MARKER_GAP,
  LIST_MARKER_WIDTH,
  resolveParagraphs,
  textRunSegmentsInRange,
  type FontStyle,
  type ParagraphStyleRun,
  type TextRun,
  type TextRunStyle,
} from "@ufira/design-schema";

/**
 * 内联文本编辑器的纯逻辑。
 *
 * 编辑器是 `contenteditable` 的结构化 DOM（每段一块），但「文本 → 段落描述」
 * 与「DOM → 文本」这两步最容易出错（少一个换行、标记被算进文本、run 边界切错），
 * 所以拆到这里单独测。
 *
 * 规格见 `docs/inline-text-editing.md`。
 */

/** 编辑器里的一段样式片段。 */
export interface EditorRun {
  text: string;
  style: TextRunStyle;
}

/** 编辑器里的一个段落。 */
export interface EditorParagraph {
  /** 段落序号（与 `paragraphRanges` 一致）。 */
  index: number;
  /** 段落文本（不含尾随换行符）。 */
  text: string;
  /** 段内样式片段（已按段落切分）。 */
  runs: EditorRun[];
  /** 列表类型；非列表段落为 undefined。 */
  listType?: "bullet" | "ordered";
  /** 列表标记文本（`•` 或编号）；非列表段落为 undefined。 */
  marker?: string;
  /** 列表缩进级别。 */
  indent: number;
}

/** 节点级默认样式（段内 run 没覆盖的字段用它）。 */
export interface EditorBaseStyle {
  fontWeight: number;
  fontStyle: FontStyle;
  fontSize: number;
  color: string;
}

/**
 * 把文本切成编辑器的段落描述。
 *
 * 段落边界与列表信息来自 `resolveParagraphs()`（与画布、导出同一份逻辑），
 * 段内样式用 `textRunSegmentsInRange()` 按段切片——全量切一次再按段分发是错的，
 * 因为一段的 run 可能横跨段落边界。
 */
export function editorParagraphs(
  text: string,
  runs: readonly TextRun[] | undefined,
  paragraphStyles: readonly ParagraphStyleRun[] | undefined,
): EditorParagraph[] {
  const resolved = resolveParagraphs(text, paragraphStyles);
  return resolved.map(paragraph => {
    const segments = textRunSegmentsInRange(text, runs, paragraph.start, paragraph.end);
    return {
      index: paragraph.index,
      text: paragraph.text,
      runs: segments.map(segment => ({ text: segment.text, style: { ...segment.style } })),
      ...(paragraph.style.listType ? { listType: paragraph.style.listType } : {}),
      ...(paragraph.marker ? { marker: paragraph.marker } : {}),
      indent: paragraph.style.indent ?? 0,
    };
  });
}

/** 一个 run 的最终样式：run 覆盖节点级默认值。 */
export function editorRunStyle(run: EditorRun, base: EditorBaseStyle): Required<Omit<EditorBaseStyle, "color">> & { color: string } {
  return {
    fontWeight: run.style.fontWeight ?? base.fontWeight,
    fontStyle: run.style.fontStyle ?? base.fontStyle,
    fontSize: run.style.fontSize ?? base.fontSize,
    color: run.style.color ?? base.color,
  };
}

/** 段落的左缩进（px）：与画布几何一致。 */
export function editorParagraphIndent(paragraph: EditorParagraph): number {
  return paragraph.indent * LIST_INDENT_STEP;
}

/** 标记元素的宽度（px）：标记右对齐在正文左侧一个间隙处。 */
export const EDITOR_MARKER_WIDTH = LIST_MARKER_WIDTH - LIST_MARKER_GAP;

/**
 * 把编辑器 DOM 渲染成段落块。
 *
 * DOM 是**不受控**的：调用方只在挂载时构建一次，之后由浏览器接管编辑。
 * 段落块用 `data-editor-paragraph` 标号，标记用 `data-editor-marker` 标号
 * （提交时按它跳过，用户误删标记也不影响文本）。
 */
export function renderEditorParagraphs(
  root: HTMLElement,
  paragraphs: readonly EditorParagraph[],
  base: EditorBaseStyle,
): void {
  root.textContent = "";
  for (const paragraph of paragraphs) {
    const block = root.ownerDocument.createElement("div");
    block.className = "rte-paragraph";
    block.setAttribute("data-editor-paragraph", String(paragraph.index));
    // 缩进与画布几何一致：级别缩进由 padding 让出，标记区宽度由标记自身占位
    // （宽度 + 间隙 = LIST_MARKER_WIDTH），正文起点与画布的 left 一致。
    block.style.paddingLeft = `${editorParagraphIndent(paragraph)}px`;
    if (paragraph.listType) {
      const marker = root.ownerDocument.createElement("span");
      marker.className = "rte-marker";
      marker.setAttribute("contenteditable", "false");
      marker.setAttribute("data-editor-marker", "true");
      marker.textContent = paragraph.marker ?? "";
      // 标记右对齐在标记区里：宽度固定，右边缘与正文之间留一个间隙。
      marker.style.width = `${EDITOR_MARKER_WIDTH}px`;
      marker.style.marginRight = `${LIST_MARKER_GAP}px`;
      marker.style.textAlign = "right";
      block.appendChild(marker);
    }
    for (const run of paragraph.runs) {
      if (!run.text) continue;
      const style = editorRunStyle(run, base);
      const span = root.ownerDocument.createElement("span");
      span.className = "rte-run";
      span.setAttribute("data-editor-run", "true");
      span.textContent = run.text;
      // 段内字号会改变行高；这里显式写成「与节点行高一致」，让编辑器与画布的行距对得上。
      span.style.fontWeight = String(style.fontWeight);
      span.style.fontStyle = style.fontStyle;
      span.style.fontSize = `${style.fontSize}px`;
      span.style.color = style.color;
      block.appendChild(span);
    }
    root.appendChild(block);
  }
}

/**
 * 从编辑器 DOM 还原文本。
 *
 * 规则：
 * - 顶层每个块是一个段落，块之间是 `\n`；
 * - 块内的 `<br>` 是段内换行（`Shift+Enter` 产生）；
 * - 标记元素跳过（它不是内容）。
 */
export function readEditorText(root: HTMLElement): string {
  const blocks = Array.from(root.children).filter(child => !isMarkerElement(child as HTMLElement));
  return blocks.map(block => collectBlockText(block)).join("\n");
}

/** 标记元素：既不参与文本，也不参与段落切分。 */
function isMarkerElement(element: HTMLElement): boolean {
  return element.hasAttribute("data-editor-marker");
}

/** 收集一个段落块的文本：`<br>` 变 `\n`，标记跳过。 */
function collectBlockText(block: Element): string {
  const parts: string[] = [];
  collectNodeText(block, parts);
  return parts.join("");
}

function collectNodeText(node: Node, parts: string[]): void {
  if (node.nodeType === 3) {
    parts.push(node.textContent ?? "");
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as HTMLElement;
  if (isMarkerElement(element)) return;
  if (element.tagName === "BR") {
    parts.push("\n");
    return;
  }
  for (const child of Array.from(node.childNodes)) collectNodeText(child, parts);
}
