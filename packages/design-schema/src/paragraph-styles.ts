import { isCodePointBoundary } from "./rich-text";

/**
 * 段落样式。
 *
 * 与段内样式（`TextRun`）的分工：`TextRun` 描述「一段文字里局部变粗」，
 * `ParagraphStyle` 描述「整个段落是什么样子」——列表类型、缩进级别。
 */
export type ListType = "bullet" | "ordered";

/** 一个段落的样式。 */
export interface ParagraphStyle {
  /** 列表类型；缺省表示该段不是列表项。 */
  listType?: ListType;
  /** 缩进级别，0–4（对齐 Figma 的 5 级上限）。只在列表段落上有意义。 */
  indent?: number;
  /**
   * 段落缩进（px）——Figma 的 Paragraph indent。
   *
   * 与 `indent`（列表级别）的区别：级别缩进是「列表结构」，
   * 段落缩进是「这一段整体往右推多少像素」，两者叠加。
   *
   * 只对**左对齐**生效（与 Figma 一致）：居中/右对齐时布局会把它扣掉。
   */
  paragraphIndent?: number;
  /**
   * 悬挂列表（hanging list）。
   *
   * 普通列表项的标记占住正文左侧的宽度；悬挂列表的标记**不占宽度**，
   * 画在文本框左边界之外——于是文字从框的左边缘开始，标记悬在外面。
   */
  hanging?: boolean;
  /**
   * 列表间距（px）：这一段**之后**额外留出的垂直空间。
   *
   * 用来把一组列表项拉开距离（目录、导航项的呼吸感）。
   */
  listSpacing?: number;
}

/**
 * 段落样式区间。
 *
 * `from` / `to` 是 UTF-16 下标，且**必须对齐段落边界**：`from` 是某段的起点，
 * `to` 是某段的终点（不含尾随换行符）。这与 `TextRun` 刻意不同——
 * 段落样式描述整段，不允许只覆盖半段。
 */
export interface ParagraphStyleRun {
  from: number;
  to: number;
  style: ParagraphStyle;
}

/** 每一级列表缩进额外让出的水平空间（px）。 */
export const LIST_INDENT_STEP = 24;
/** 列表标记（bullet / 编号）占据的固定宽度（px）。 */
export const LIST_MARKER_WIDTH = 20;
/** 列表标记与正文之间的留白（px）：标记右边缘停在正文左侧这么多位置。 */
export const LIST_MARKER_GAP = 4;
/** 列表缩进级别上限（对齐 Figma 的 5 级）。 */
export const MAX_LIST_INDENT = 4;

/** 段落的列表类型取值。 */
export const LIST_TYPES = ["bullet", "ordered"] as const;

export function isEmptyParagraphStyle(style: ParagraphStyle): boolean {
  return style.listType === undefined
    && style.indent === undefined
    && style.paragraphIndent === undefined
    && style.hanging === undefined
    && style.listSpacing === undefined;
}

export function sameParagraphStyle(a: ParagraphStyle, b: ParagraphStyle): boolean {
  return a.listType === b.listType
    && a.indent === b.indent
    && a.paragraphIndent === b.paragraphIndent
    && a.hanging === b.hanging
    && a.listSpacing === b.listSpacing;
}

/** 一个段落在文本中的字符区间 `[start, end)`；尾随换行符不计入任何段落。 */
export interface ParagraphRange {
  index: number;
  start: number;
  end: number;
}

/**
 * 切出所有段落的字符区间。
 *
 * 换行符不属于任何段落：`"a\nb"` 得到 `[0,1)` 与 `[2,3)` 两段，
 * 换行符 `[1,2)` 被跳过。这样「区间是否对齐段落边界」只有一个判定规则。
 */
export function paragraphRanges(text: string): ParagraphRange[] {
  const ranges: ParagraphRange[] = [];
  let start = 0;
  let index = 0;
  for (let position = 0; position < text.length; position += 1) {
    if (text[position] !== "\n") continue;
    ranges.push({ index, start, end: position });
    index += 1;
    start = position + 1;
  }
  ranges.push({ index, start, end: text.length });
  return ranges;
}

/** 某个下标落在哪个段落里（越界时夹到首/末段）。 */
export function paragraphIndexAt(text: string, offset: number): number {
  const ranges = paragraphRanges(text);
  const clamped = Math.max(0, Math.min(offset, text.length));
  for (const range of ranges) {
    if (clamped >= range.start && clamped <= range.end) return range.index;
  }
  return ranges[ranges.length - 1]!.index;
}

/**
 * 把一个字符区间吸附到段落边界。
 *
 * 给到段落中间时，整段都受影响——这与 Figma 一致（在列表项中间选一个字，
 * 整个列表项都会变）。
 *
 * 右端是**开区间**：`to` 是选区的结束位置，不属于选区。所以 `to` 恰好落在
 * 某一段的起点时，那一段并没有被选中（`"a\nb\nc"` 里选 `[0,4)` 只覆盖
 * `"a"` 和 `"b"` 两段，第三段没被碰到）。光标态（`from === to`）则按
 * 光标所在段落处理。
 */
export function snapRangeToParagraphs(text: string, from: number, to: number): { from: number; to: number } {
  const ranges = paragraphRanges(text);
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const firstIndex = paragraphIndexAt(text, start);
  const lastIndex = start === end ? firstIndex : paragraphIndexAt(text, Math.max(start, end - 1));
  const first = ranges[firstIndex]!;
  const last = ranges[lastIndex]!;
  return { from: first.start, to: last.end };
}

function validateParagraphStyle(style: ParagraphStyle, index: number): string | undefined {
  if (!style || typeof style !== "object") return `paragraphStyles.${index}.style is required`;
  if (isEmptyParagraphStyle(style)) return `paragraphStyles.${index}.style must set at least one field`;
  if (style.listType !== undefined && style.listType !== "bullet" && style.listType !== "ordered") {
    return `paragraphStyles.${index}.style.listType must be bullet or ordered`;
  }
  if (style.indent !== undefined
    && (!Number.isInteger(style.indent) || style.indent < 0 || style.indent > MAX_LIST_INDENT)) {
    return `paragraphStyles.${index}.style.indent must be an integer between 0 and ${MAX_LIST_INDENT}`;
  }
  if (style.paragraphIndent !== undefined
    && (!Number.isFinite(style.paragraphIndent) || style.paragraphIndent < 0)) {
    return `paragraphStyles.${index}.style.paragraphIndent must be a non-negative number`;
  }
  if (style.listSpacing !== undefined
    && (!Number.isFinite(style.listSpacing) || style.listSpacing < 0)) {
    return `paragraphStyles.${index}.style.listSpacing must be a non-negative number`;
  }
  // 悬挂列表只对列表段落有意义：没有列表类型就没有标记可悬挂。
  if (style.hanging !== undefined && style.listType === undefined) {
    return `paragraphStyles.${index}.style.hanging requires a listType`;
  }
  // 缩进级别只对列表段落有意义：非列表段落上的缩进会被渲染器忽略，
  // 那属于「写了但没生效」的静默失败，直接在写入前拒绝。
  if (style.indent !== undefined && style.listType === undefined) {
    return `paragraphStyles.${index}.style.indent requires a listType`;
  }
  return undefined;
}

/**
 * 校验一段段落样式区间是否与文本自洽。
 *
 * 与 `validateTextRuns` 的区别：区间必须**对齐段落边界**，且互不重叠。
 * 返回错误信息而不是抛异常，因为 schema 的 refine 与运行时命令都要用它。
 */
export function validateParagraphStyles(text: string, runs: readonly ParagraphStyleRun[] | undefined): string | undefined {
  if (!runs || !runs.length) return undefined;
  const ranges = paragraphRanges(text);
  let previousTo = 0;
  for (const [index, run] of runs.entries()) {
    if (!Number.isInteger(run.from) || !Number.isInteger(run.to)) return `paragraphStyles.${index}.from/to must be integers`;
    if (run.from < 0 || run.to > text.length) return `paragraphStyles.${index} must fall inside the text (0-${text.length})`;
    if (run.from >= run.to) return `paragraphStyles.${index}.from must be smaller than paragraphStyles.${index}.to`;
    if (run.from < previousTo) return `paragraphStyles.${index} overlaps the previous run`;
    if (!isCodePointBoundary(text, run.from) || !isCodePointBoundary(text, run.to)) {
      return `paragraphStyles.${index} splits a surrogate pair`;
    }
    const start = ranges.find(range => range.start === run.from);
    const end = ranges.find(range => range.end === run.to);
    if (!start || !end) return `paragraphStyles.${index} must align to paragraph boundaries`;
    if (start.index > end.index) return `paragraphStyles.${index} must cover whole paragraphs in order`;
    const styleError = validateParagraphStyle(run.style, index);
    if (styleError) return styleError;
    previousTo = run.to;
  }
  return undefined;
}

/** 文本里一段区间中换行符的数量。 */
function countNewlines(value: string): number {
  let total = 0;
  for (const character of value) if (character === "\n") total += 1;
  return total;
}


/**
 * 排序并把相邻同款样式的区间合并。
 *
 * 「相邻」指的是**段落相邻**：两个区间之间可以隔着换行符，只要中间只有换行
 * （没有正文），就属于连续的两段，可以合并成一条记录。
 */
export function mergeParagraphStyles(runs: readonly ParagraphStyleRun[], text?: string): ParagraphStyleRun[] {
  const sorted = runs
    .filter(run => run.to > run.from)
    .map(run => ({ from: run.from, to: run.to, style: { ...run.style } }))
    .sort((a, b) => a.from - b.from);
  const merged: ParagraphStyleRun[] = [];
  for (const run of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.to <= run.from && sameParagraphStyle(last.style, run.style) && gapIsParagraphBreak(last.to, run.from, text)) {
      last.to = run.to;
      continue;
    }
    merged.push(run);
  }
  return merged;
}

/** 两个区间之间是否只有段落分隔（换行），没有正文。 */
function gapIsParagraphBreak(from: number, to: number, text: string | undefined): boolean {
  if (from === to) return true;
  if (text === undefined) return false;
  return !text.slice(from, to).replace(/\n/g, "").length;
}

/**
 * 一个区间覆盖了哪些段落。
 *
 * 区间可以跨多个段落（连续的同款段落会合并成一条记录），所以「区间 ↔ 段落」
 * 不是一对一的关系，切开区间时必须按段落切，不能按字符切——
 * 否则切出来的半截区间不再对齐段落边界，文档会直接不合法。
 */
function paragraphIndicesOf(text: string, run: ParagraphStyleRun): number[] {
  const ranges = paragraphRanges(text);
  const indices: number[] = [];
  for (const range of ranges) {
    if (range.end <= range.start) continue;
    if (run.from <= range.start && run.to >= range.end) indices.push(range.index);
  }
  return indices;
}

/** 把若干段落序号（必须连续）合成一条区间记录。 */
function runFromParagraphs(ranges: ParagraphRange[], indices: number[], style: ParagraphStyle): ParagraphStyleRun | undefined {
  if (!indices.length) return undefined;
  const first = ranges[indices[0]!];
  const last = ranges[indices[indices.length - 1]!];
  if (!first || !last) return undefined;
  return { from: first.start, to: last.end, style: { ...style } };
}

/**
 * 把样式施加到一段区间上（**替换**语义，不是叠加）。
 *
 * 区间会先吸附到段落边界，因此施加后仍然是「整段」的语义。
 *
 * 替换而非叠加是必须的：段落样式的区间**不允许重叠**（校验会拒绝），
 * 而叠加语义必然产生重叠。命中的旧区间被切开——落在范围外的部分保留。
 *
 * 传入的 `style` 是**增量**：没写的字段沿用被覆盖段落自己的原值。
 * `listType: "none"` 表示取消列表（缩进级别同时归零）。
 *
 * `indentDelta` 是**相对**缩进：每一段按自己的原级别加/减，而不是统一设成
 * 同一个绝对值——Figma 的 Tab/Shift+Tab 就是这个语义（选区里各级别各升一级）。
 *
 * 选区跨多段时，**每一段各自以自己的原值为基准**做增量：
 * 选区里既有编号段又有项目符号段时，只改缩进级别不会把它们变成同一种列表。
 */
export function setParagraphStyle(
  text: string,
  runs: readonly ParagraphStyleRun[] | undefined,
  from: number,
  to: number,
  style: {
    listType?: ListType | "none";
    indent?: number;
    indentDelta?: number;
    paragraphIndent?: number;
    hanging?: boolean;
    listSpacing?: number;
  },
): ParagraphStyleRun[] {
  const snapped = snapRangeToParagraphs(text, from, to);
  const ranges = paragraphRanges(text);
  const covered = ranges.filter(range => range.start >= snapped.from && range.end <= snapped.to && range.end > range.start);
  const coveredIndices = new Set(covered.map(range => range.index));
  // 先把被覆盖的段落从旧区间里摘掉（落在范围外的段落保留）。
  const next: ParagraphStyleRun[] = [];
  for (const run of runs ?? []) {
    const kept = paragraphIndicesOf(text, run).filter(index => !coveredIndices.has(index));
    // 保留的段落按连续段分组：每组写成一条区间记录。
    let group: number[] = [];
    for (const index of kept) {
      if (group.length && group[group.length - 1] !== index - 1) {
        const piece = runFromParagraphs(ranges, group, run.style);
        if (piece) next.push(piece);
        group = [];
      }
      group.push(index);
    }
    const piece = runFromParagraphs(ranges, group, run.style);
    if (piece) next.push(piece);
  }
  // 再按段写入：每一段以自己的原值为基准做增量。
  for (const range of covered) {
    const base = paragraphStyleAt(runs, range.start, range.end) ?? {};
    const merged: ParagraphStyle = { ...base };
    if (style.listType === "none") {
      delete merged.listType;
      delete merged.indent;
      delete merged.hanging;
      delete merged.paragraphIndent;
      delete merged.listSpacing;
    } else if (style.listType !== undefined) {
      merged.listType = style.listType;
    }
    if (style.indent !== undefined) merged.indent = style.indent;
    // 归零/关掉就删掉字段：留着 `0` 或 `false` 会让「样式为空」的判断失真。
    if (style.paragraphIndent !== undefined) {
      if (style.paragraphIndent > 0) merged.paragraphIndent = style.paragraphIndent;
      else delete merged.paragraphIndent;
    }
    if (style.hanging !== undefined) {
      if (style.hanging) merged.hanging = true;
      else delete merged.hanging;
    }
    if (style.listSpacing !== undefined) {
      if (style.listSpacing > 0) merged.listSpacing = style.listSpacing;
      else delete merged.listSpacing;
    }
    if (style.indentDelta !== undefined && merged.listType) {
      // 相对缩进按每段自己的级别加减；非列表段落没有级别可加，保持原样。
      merged.indent = Math.max(0, Math.min(MAX_LIST_INDENT, (merged.indent ?? 0) + style.indentDelta));
    }
    if (!isEmptyParagraphStyle(merged)) next.push({ from: range.start, to: range.end, style: merged });
  }
  return mergeParagraphStyles(next, text);
}

/**
 * 文本被改写后把段落样式区间重新对齐到新文本。
 *
 * 段落样式是**段落级**的，所以对齐不能只看字符偏移——改一个段落里的字，
 * 那个段落的列表样式必须还在。因此这里按「字符是否还在」来对齐：
 *
 * 1. 用「最长公共前缀 + 最长公共后缀」定位改动区间；
 * 2. 落在公共前缀里的字符位置不变，落在公共后缀里的字符整体平移，
 *    落在改动区间里的字符视为消失；
 * 3. 旧段落里还活着的字符落在新文本的哪些段落上，样式就跟到那里。
 *
 * 由此得到三个直观的结果：
 * - 在段落中间改字：段落还在，样式跟着走；
 * - 在段落中间插入换行：原来的一段变成两段，两段都继承列表样式；
 * - 把整段删掉：样式一起消失（没有段落可挂）。
 *
 * 结果重新吸附到新文本的段落边界，因此校验规则（区间必须对齐边界）仍然成立。
 */
export function remapParagraphStyles(
  oldText: string,
  newText: string,
  runs: readonly ParagraphStyleRun[] | undefined,
): ParagraphStyleRun[] {
  if (!runs?.length) return [];
  const oldRanges = paragraphRanges(oldText);
  const newRanges = paragraphRanges(newText);
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;
  const tailStart = oldText.length - suffix;
  const delta = newText.length - oldText.length;

  /**
   * 旧字符位置 → 新字符位置；返回 undefined 表示这个字符在改动里消失了。
   *
   * 位置映射是单调的，所以一个旧段落只需要看它的两端与改动区间的关系，
   * 不必逐字符扫描。
   */
  const mapPosition = (position: number): number | undefined => {
    if (position < prefix) return position;
    if (position >= tailStart) return position + delta;
    return undefined;
  };

  /**
   * 一个旧段落在新文本里覆盖的段落序号区间。
   *
   * 段落里可能同时有「改动前」和「改动后」的字符（中间插了换行），
   * 两段都要算进去，所以返回的是区间而不是单个序号。
   */
  const mapParagraph = (oldIndex: number): { first: number; last: number } | undefined => {
    const range = oldRanges[oldIndex]!;
    const head = mapPosition(range.start);
    const tail = mapPosition(range.end - 1);
    if (head === undefined && tail === undefined) return undefined;
    const first = head !== undefined ? paragraphIndexAt(newText, head) : paragraphIndexAt(newText, tail!);
    const last = tail !== undefined ? paragraphIndexAt(newText, tail) : paragraphIndexAt(newText, head!);
    return { first: Math.min(first, last), last: Math.max(first, last) };
  };

  const remapped: ParagraphStyleRun[] = [];
  for (const run of runs) {
    const firstOld = paragraphIndexAt(oldText, run.from);
    const lastOld = paragraphIndexAt(oldText, Math.max(run.from, run.to - 1));
    let first: number | undefined;
    let last: number | undefined;
    for (let index = firstOld; index <= lastOld; index += 1) {
      const mapped = mapParagraph(index);
      if (!mapped) continue;
      first = first === undefined ? mapped.first : Math.min(first, mapped.first);
      last = last === undefined ? mapped.last : Math.max(last, mapped.last);
    }
    if (first === undefined || last === undefined) continue;
    const start = newRanges[first];
    const end = newRanges[last];
    if (!start || !end) continue;
    remapped.push({ from: start.start, to: end.end, style: { ...run.style } });
  }
  return mergeParagraphStyles(normalizeParagraphStyles(remapped), newText);
}

/**
 * 归一化区间：排序、合并相邻同款、切掉重叠部分。
 *
 * 重叠在文本改写后可能出现（两个旧段落合成一个新段落），
 * 此时保留靠后的那个——它覆盖的范围更贴近用户看到的内容。
 */
export function normalizeParagraphStyles(runs: readonly ParagraphStyleRun[]): ParagraphStyleRun[] {
  const sorted = runs
    .filter(run => run.to > run.from)
    .map(run => ({ from: run.from, to: run.to, style: { ...run.style } }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const result: ParagraphStyleRun[] = [];
  for (const run of sorted) {
    const last = result[result.length - 1];
    if (!last) {
      result.push(run);
      continue;
    }
    if (run.from >= last.to) {
      result.push(run);
      continue;
    }
    if (sameParagraphStyle(last.style, run.style)) {
      last.to = Math.max(last.to, run.to);
      continue;
    }
    // 重叠且样式不同：保留靠后的（覆盖范围更大），把前一个截断。
    if (run.from > last.from) last.to = run.from;
    else result.pop();
  }
  return result;
}

/**
 * 某个段落上的样式（供渲染与导出查）。
 *
 * 区间必须整段覆盖该段落才算数——这与「区间对齐段落边界」的校验规则配套。
 */
export function paragraphStyleAt(
  runs: readonly ParagraphStyleRun[] | undefined,
  paragraphStart: number,
  paragraphEnd: number,
): ParagraphStyle | undefined {
  for (const run of runs ?? []) {
    if (run.from <= paragraphStart && run.to >= paragraphEnd) return { ...run.style };
  }
  return undefined;
}

/** 罗马数字（小写 / 大写）。标准减法记法：4 → iv，9 → ix。 */
export function romanNumerals(value: number): string {
  const table: readonly (readonly [number, string])[] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let remaining = Math.max(1, Math.floor(value));
  let out = "";
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      out += symbol;
      remaining -= amount;
    }
  }
  return out;
}

/** 小写字母（Excel 式进位：26 → z，27 → aa）。 */
export function alphaNumerals(value: number): string {
  let remaining = Math.max(1, Math.floor(value));
  let out = "";
  while (remaining > 0) {
    const rest = (remaining - 1) % 26;
    out = String.fromCharCode(97 + rest) + out;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return out;
}

/**
 * 编号文本：按缩进级别选格式。
 *
 * Figma 的编号格式随缩进级别**循环**：数字 → 小写字母 → 小写罗马 → 回到数字。
 */
export function formatOrderedMarker(value: number, indent: number): string {
  const level = Math.max(0, Math.min(indent, MAX_LIST_INDENT));
  switch (level % 3) {
    case 0: return `${value}.`;
    case 1: return `${alphaNumerals(value)}.`;
    default: return `${romanNumerals(value)}.`;
  }
}

/** bullet 标记文本；各级别一致（Figma 明确如此）。 */
export const BULLET_MARKER = "•";

/** 解析后的一个段落：样式 + 几何 + 标记。 */
export interface ResolvedParagraph {
  index: number;
  start: number;
  end: number;
  /** 段落文本（不含尾随换行符）。 */
  text: string;
  style: ParagraphStyle;
  /** 列表缩进（px）：`indent * LIST_INDENT_STEP`。 */
  listIndent: number;
  /** 标记区宽度（px）；非列表段落为 0。 */
  markerWidth: number;
  /** 文字左偏移（px）= listIndent + markerWidth。 */
  left: number;
  /** 列表标记文本（bullet 或编号）；非列表段落为 undefined。 */
  marker?: string;
  /** 编号的数值形式（1、2、3…）；bullet 与普通段落为 undefined。 */
  ordinal?: number;
  /** 段落缩进（px）；居中/右对齐时布局会把它扣掉。 */
  paragraphIndent: number;
  /** 这一段之后的列表间距（px）。 */
  spaceAfter: number;
  /** 悬挂列表：标记不占正文宽度，画在文本框外。 */
  hanging: boolean;
}

/**
 * 解析全文的段落样式与几何。
 *
 * 编号在这里**现算**，不存进文档：计数器按缩进级别维护，编号段落递增本级计数，
 * 更深级别的计数在遇到上级编号段落时清零；非编号段落（bullet 或普通段落）
 * 会清零本级及更深级别的计数——这样两段独立的列表各自从 1 开始。
 */
export function resolveParagraphs(
  text: string,
  styles: readonly ParagraphStyleRun[] | undefined,
): ResolvedParagraph[] {
  const ranges = paragraphRanges(text);
  const counters = new Map<number, number>();
  return ranges.map(range => {
    const style = paragraphStyleAt(styles, range.start, range.end) ?? {};
    const listType = style.listType;
    const level = listType ? Math.max(0, Math.min(style.indent ?? 0, MAX_LIST_INDENT)) : 0;
    let marker: string | undefined;
    let ordinal: number | undefined;
    if (listType === "ordered") {
      const next = (counters.get(level) ?? 0) + 1;
      counters.set(level, next);
      for (const key of [...counters.keys()]) if (key > level) counters.delete(key);
      marker = formatOrderedMarker(next, level);
      ordinal = next;
    } else {
      for (const key of [...counters.keys()]) if (key >= level) counters.delete(key);
      if (listType === "bullet") marker = BULLET_MARKER;
    }
    const listIndent = level * LIST_INDENT_STEP;
    const hanging = style.hanging === true && Boolean(listType);
    // 悬挂列表的标记不占正文宽度：文字从框的左边缘开始，标记悬在框外。
    const markerWidth = listType && !hanging ? LIST_MARKER_WIDTH : 0;
    const paragraphIndent = style.paragraphIndent ?? 0;
    const spaceAfter = style.listSpacing ?? 0;
    return {
      index: range.index,
      start: range.start,
      end: range.end,
      text: text.slice(range.start, range.end),
      style,
      listIndent,
      markerWidth,
      paragraphIndent,
      spaceAfter,
      hanging,
      left: listIndent + markerWidth + paragraphIndent,
      ...(marker ? { marker } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
    };
  });
}
