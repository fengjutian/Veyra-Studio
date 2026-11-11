import {
  LIST_INDENT_STEP,
  LIST_MARKER_GAP,
  LIST_MARKER_WIDTH,
  isEmptyRunStyle,
  mergeTextRuns,
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
  /** 节点级行高（px）；段内 run 没覆盖时用它。 */
  lineHeight?: number;
}

/** 解析后的 run 样式：节点级默认值 + 段内覆盖。 */
export interface ResolvedEditorRunStyle {
  fontWeight: number;
  fontStyle: FontStyle;
  fontSize: number;
  color: string;
  lineHeight?: number;
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
export function editorRunStyle(run: EditorRun, base: EditorBaseStyle): ResolvedEditorRunStyle {
  const lineHeight = run.style.lineHeight ?? base.lineHeight;
  return {
    fontWeight: run.style.fontWeight ?? base.fontWeight,
    fontStyle: run.style.fontStyle ?? base.fontStyle,
    fontSize: run.style.fontSize ?? base.fontSize,
    color: run.style.color ?? base.color,
    ...(lineHeight !== undefined ? { lineHeight } : {}),
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
 *
 * 每个 run 元素带一个 `data-editor-style`：里面存的是**覆盖值**（不是解析后的值）。
 * 存覆盖值才能区分「显式设成 700」与「继承节点级的 700」——提交时按它还原 runs。
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
      if (!isEmptyRunStyle(run.style)) span.setAttribute("data-editor-style", JSON.stringify(run.style));
      span.textContent = run.text;
      // 段内字号会改变行高；这里显式写成「与节点行高一致」，让编辑器与画布的行距对得上。
      span.style.fontWeight = String(style.fontWeight);
      span.style.fontStyle = style.fontStyle;
      span.style.fontSize = `${style.fontSize}px`;
      span.style.color = style.color;
      // 段内行高只抬高所在行的行盒，不改变换行位置。
      if (style.lineHeight !== undefined) span.style.lineHeight = `${style.lineHeight}px`;
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

/* ── DOM 索引：字符偏移 ↔ DOM 位置 ─────────────────────────────────────── */

/** 编辑器 DOM 里一个 run 元素及其字符区间。 */
export interface EditorRunElement {
  element: HTMLElement;
  /** 起始字符偏移（UTF-16）。 */
  from: number;
  /** 结束字符偏移（UTF-16，不含）。 */
  to: number;
}

/** 文本片段：DOM 里的一个文本节点或 `<br>`，以及它在编辑器文本里的位置。 */
interface TextFragment {
  node: Node;
  start: number;
  length: number;
}

/** 元素区间：元素在编辑器文本里占的范围。 */
interface ElementRange {
  element: HTMLElement;
  from: number;
  to: number;
}

/** DOM 索引：文本片段 + 元素区间。 */
interface EditorDomIndex {
  fragments: TextFragment[];
  elements: ElementRange[];
}

/**
 * 给编辑器 DOM 建一份「字符偏移」索引。
 *
 * 口径必须与 {@link readEditorText} 完全一致：块与块之间算一个换行符，
 * 块内的 `<br>` 也算一个换行符，标记元素既不算字符也不占位置。
 */
function editorDomIndex(root: HTMLElement): EditorDomIndex {
  const fragments: TextFragment[] = [];
  const elements: ElementRange[] = [];
  let offset = 0;
  const blocks = Array.from(root.children).filter(child => !isMarkerElement(child as HTMLElement));
  blocks.forEach((block, index) => {
    // 块与块之间是一个换行符。
    if (index > 0) offset += 1;
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        const length = (node.textContent ?? "").length;
        fragments.push({ node, start: offset, length });
        offset += length;
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as HTMLElement;
      if (isMarkerElement(element)) return;
      if (element.tagName === "BR") {
        fragments.push({ node, start: offset, length: 1 });
        offset += 1;
        return;
      }
      const start = offset;
      for (const child of Array.from(node.childNodes)) walk(child);
      elements.push({ element, from: start, to: offset });
    };
    walk(block);
  });
  return { fragments, elements };
}

/** 一个节点占多少个字符（标记不算，`<br>` 算一个）。 */
function lengthOfNode(node: Node): number {
  if (node.nodeType === 3) return (node.textContent ?? "").length;
  if (node.nodeType !== 1) return 0;
  const element = node as HTMLElement;
  if (isMarkerElement(element)) return 0;
  if (element.tagName === "BR") return 1;
  let total = 0;
  for (const child of Array.from(node.childNodes)) total += lengthOfNode(child);
  return total;
}

/** 编辑器 DOM 里每个 run 元素的字符区间（按文档顺序）。 */
export function editorRunElements(root: HTMLElement): EditorRunElement[] {
  return editorDomIndex(root).elements
    .filter(entry => entry.element.hasAttribute("data-editor-run"))
    .map(entry => ({ element: entry.element, from: entry.from, to: entry.to }));
}

/** DOM 位置 → 字符偏移。 */
function positionOffset(index: EditorDomIndex, container: Node, offset: number): number | undefined {
  const fragment = index.fragments.find(entry => entry.node === container);
  if (fragment) return fragment.start + Math.min(offset, fragment.length);
  const element = index.elements.find(entry => entry.element === container);
  if (!element) return undefined;
  // 元素容器：offset 是子节点下标，位置落在第 offset 个子节点之前。
  let total = element.from;
  const children = Array.from(container.childNodes);
  for (let position = 0; position < offset && position < children.length; position += 1) {
    total += lengthOfNode(children[position]!);
  }
  return total;
}

/** 字符偏移 → DOM 位置。 */
function positionAt(root: HTMLElement, offset: number): { node: Node; offset: number } | undefined {
  const index = editorDomIndex(root);
  for (const fragment of index.fragments) {
    if (offset <= fragment.start + fragment.length) {
      return { node: fragment.node, offset: Math.max(0, offset - fragment.start) };
    }
  }
  const last = index.fragments[index.fragments.length - 1];
  if (!last) return undefined;
  return { node: last.node, offset: last.length };
}

/**
 * 当前选区在编辑器文本里的字符区间。
 *
 * 选区不在编辑器里（或没有选区）时返回 undefined。
 * 返回的是 UTF-16 偏移，与 `runs` / `paragraphStyles` 的口径一致。
 */
export function editorSelectionOffsets(root: HTMLElement, selection: Selection | null): { from: number; to: number } | undefined {
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined;
  const index = editorDomIndex(root);
  const from = positionOffset(index, range.startContainer, range.startOffset);
  const to = positionOffset(index, range.endContainer, range.endOffset);
  if (from === undefined || to === undefined) return undefined;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

/** 把选区恢复到编辑器文本的某个区间（重建 DOM 之后用）。 */
export function restoreEditorSelection(root: HTMLElement, from: number, to: number): void {
  const doc = root.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return;
  const start = positionAt(root, from);
  const end = positionAt(root, to);
  if (!start || !end) return;
  const range = doc.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(range);
  root.focus();
}

/* ── 段内样式的还原与就地更新 ─────────────────────────────────────────── */

/** 把 #rgb / #rrggbb 转成浏览器的 rgb() 形式，便于与行内样式比较。 */
function toRgbColor(color: string): string {
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!hex) return trimmed;
  const digits = hex[1]!.length === 3 ? hex[1]!.split("").map(char => char + char).join("") : hex[1]!;
  const red = parseInt(digits.slice(0, 2), 16);
  const green = parseInt(digits.slice(2, 4), 16);
  const blue = parseInt(digits.slice(4, 6), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

/**
 * 读一个 run 元素的**覆盖值**。
 *
 * 优先读 `data-editor-style`（渲染时写进去的覆盖值）；读不到时回退到
 * 「行内样式与节点级默认值的差异」——浏览器新建的 span 没有那个属性。
 */
function readRunStyle(element: HTMLElement, base: EditorBaseStyle): TextRunStyle | undefined {
  const raw = element.getAttribute("data-editor-style");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TextRunStyle;
      return isEmptyRunStyle(parsed) ? undefined : parsed;
    } catch {
      // 属性坏了：回退到行内样式。
    }
  }
  const style: TextRunStyle = {};
  const weight = element.style.fontWeight;
  if (weight && Number(weight) !== base.fontWeight) style.fontWeight = Number(weight);
  const fontStyle = element.style.fontStyle;
  if (fontStyle && fontStyle !== base.fontStyle) style.fontStyle = fontStyle as FontStyle;
  const size = element.style.fontSize;
  if (size && parseFloat(size) !== base.fontSize) style.fontSize = parseFloat(size);
  const color = element.style.color;
  if (color && color !== toRgbColor(base.color)) style.color = color;
  const lineHeight = element.style.lineHeight;
  if (lineHeight && parseFloat(lineHeight) !== base.lineHeight) style.lineHeight = parseFloat(lineHeight);
  return isEmptyRunStyle(style) ? undefined : style;
}

/**
 * 从编辑器 DOM 还原段内样式区间。
 *
 * 提交时用它把「用户在画布上加粗的那几个字」变回文档里的 runs。
 */
export function readEditorRuns(root: HTMLElement, base: EditorBaseStyle): TextRun[] {
  const runs: TextRun[] = [];
  for (const entry of editorRunElements(root)) {
    if (entry.to <= entry.from) continue;
    const style = readRunStyle(entry.element, base);
    if (!style) continue;
    runs.push({ from: entry.from, to: entry.to, style });
  }
  return mergeTextRuns(runs);
}

/** 把覆盖值写进 run 元素：数据属性存覆盖值，行内样式存解析后的值。 */
function writeRunStyle(element: HTMLElement, style: TextRunStyle, base: EditorBaseStyle): void {
  const resolved = editorRunStyle({ text: "", style }, base);
  if (isEmptyRunStyle(style)) element.removeAttribute("data-editor-style");
  else element.setAttribute("data-editor-style", JSON.stringify(style));
  element.style.fontWeight = String(resolved.fontWeight);
  element.style.fontStyle = resolved.fontStyle;
  element.style.fontSize = `${resolved.fontSize}px`;
  element.style.color = resolved.color;
  if (resolved.lineHeight !== undefined) element.style.lineHeight = `${resolved.lineHeight}px`;
  else element.style.removeProperty("line-height");
}

/**
 * 就地更新 run 元素的样式（**不动 DOM 结构**）。
 *
 * 结构没变、只有样式变了时用它：光标与选区因此保住。
 *
 * 返回 false 表示新样式与 DOM 里的元素对不上（run 的区间被改过，
 * 一个元素要拆成两半才能表示），调用方需要重建 DOM。
 */
export function updateEditorRunStyles(root: HTMLElement, runs: readonly TextRun[], base: EditorBaseStyle): boolean {
  for (const entry of editorRunElements(root)) {
    const covering = runs.filter(run => run.from < entry.to && run.to > entry.from);
    if (!covering.length) {
      // 没有覆盖：元素回到节点级默认样式。
      writeRunStyle(entry.element, {}, base);
      continue;
    }
    if (covering.length > 1) return false;
    const run = covering[0]!;
    // 覆盖必须盖住整个元素，否则元素的样式要被切成两半——重建更稳。
    if (run.from > entry.from || run.to < entry.to) return false;
    writeRunStyle(entry.element, run.style, base);
  }
  return true;
}

/**
 * 把样式应用到一段区间，并**合并**而不是替换。
 *
 * 与 `applyTextRunStyle` 的区别：那个是整条替换（属性面板的语义——
 * 「这一段的粗细就是 700」），这个只改指定的字段，其余覆盖值保留：
 * 画布上的加粗按钮不该把选区的颜色一起抹掉。
 *
 * `clear` 里列出的字段被移除（回到节点级默认值）：用来实现「取消加粗」。
 */
export function mergeEditorRunStyle(
  text: string,
  runs: readonly TextRun[] | undefined,
  from: number,
  to: number,
  style: TextRunStyle,
  clear: readonly (keyof TextRunStyle)[] = [],
): TextRun[] {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(0, Math.min(to, text.length));
  const next: TextRun[] = [];
  for (const run of runs ?? []) {
    if (run.to <= start || run.from >= end) {
      next.push({ from: run.from, to: run.to, style: { ...run.style } });
      continue;
    }
    if (run.from < start) next.push({ from: run.from, to: start, style: { ...run.style } });
    if (run.to > end) next.push({ from: end, to: run.to, style: { ...run.style } });
  }
  if (end <= start) return mergeTextRuns(next);
  // 区间内每一段保留自己的覆盖值，再叠上新的样式。
  let offset = start;
  for (const segment of textRunSegmentsInRange(text, runs, start, end)) {
    const segmentFrom = offset;
    offset += segment.text.length;
    const merged: TextRunStyle = { ...segment.style };
    for (const key of clear) delete merged[key];
    for (const [key, value] of Object.entries(style)) {
      if (value === undefined) continue;
      (merged as Record<string, unknown>)[key] = value;
    }
    if (isEmptyRunStyle(merged)) continue;
    next.push({ from: segmentFrom, to: offset, style: merged });
  }
  return mergeTextRuns(next);
}

/** run 区间的布局是否一致（只看区间，不看样式值）。 */
export function sameRunLayout(a: readonly TextRun[], b: readonly TextRun[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((run, index) => run.from === b[index]!.from && run.to === b[index]!.to);
}

/** 段落样式区间是否一致（区间与样式值都算）。 */
export function sameParagraphLayout(a: readonly ParagraphStyleRun[], b: readonly ParagraphStyleRun[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((run, index) => {
    const other = b[index]!;
    if (run.from !== other.from || run.to !== other.to) return false;
    const keys = Object.keys(run.style) as Array<keyof typeof run.style>;
    return keys.length === Object.keys(other.style).length
      && keys.every(key => run.style[key] === other.style[key]);
  });
}
