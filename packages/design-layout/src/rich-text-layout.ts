import { resolveParagraphs, textRunSegments, type FontStyle, type ParagraphStyleRun, type TextRun } from "@ufira/design-schema";

/** 解析后的字符样式：节点级默认值 + 段内覆盖。 */
export interface RichTextStyle {
  fontWeight: number;
  fontStyle: FontStyle;
  /** 字号（px）。段内字号会同时改变宽度与行高。 */
  fontSize: number;
  color?: string;
  /**
   * 段内行高覆盖（px）。
   *
   * 只作为**行盒高度下限**参与该行的高度计算，不改变换行位置——
   * 换行只看字号与宽度，行高只把行撑高。
   */
  lineHeight?: number;
}

export interface RichTextSegment {
  text: string;
  style: RichTextStyle;
  /** 相对行首的 x 偏移；换行由调用方决定，渲染器只负责平移。 */
  x: number;
}

export interface RichTextLine {
  segments: RichTextSegment[];
  /** 文字本身的宽度（不含左侧缩进）。 */
  width: number;
  /** 这一行的高度：max(节点行高, 行内行高覆盖, 行内最大字号)——大字号不会被上一行压住。 */
  height: number;
  /** 所属段落序号（与 schema 的段落序号一致）。 */
  paragraphIndex: number;
  /** 该行文字相对节点左边界的左偏移（px）：列表缩进 + 标记区宽度。 */
  left: number;
  /** 列表标记文本（bullet 或编号）；只有段落的首行带标记。 */
  marker?: string;
  /** 标记区宽度（px）；非列表段落为 0。 */
  markerWidth: number;
  /**
   * 悬挂列表：标记不占正文宽度，画在文本框**外**（框左侧）。
   * 渲染器据此把标记画到框外，而不是画进正文里。
   */
  hanging?: boolean;
}

export interface RichTextLayoutInput {
  text: string;
  runs?: readonly TextRun[];
  /** 段落样式区间：决定每段的缩进与列表标记。 */
  paragraphStyles?: readonly ParagraphStyleRun[];
  /** 节点级默认样式，段内没有覆盖时用它。 */
  fontWeight: number;
  fontStyle: FontStyle;
  /** 节点级字号；段内没有覆盖时用它。 */
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  /**
   * 盒内对齐。
   *
   * 段落缩进（px）只对左对齐生效（与 Figma 一致），所以居中/右对齐时
   * 要把它从左偏移里扣掉。
   */
  align?: "left" | "center" | "right";
  /** 不给宽度就不换行（只按显式 `\n` 断行）。 */
  availableWidth?: number;
  /** 量一段**同一样式**的文字宽度。字距由本模块按字符数补，回调里不要重复加。 */
  measure: (text: string, style: RichTextStyle) => number;
}

interface StyledChar {
  value: string;
  style: RichTextStyle;
}

function sameStyle(a: RichTextStyle, b: RichTextStyle): boolean {
  return a.fontWeight === b.fontWeight
    && a.fontStyle === b.fontStyle
    && a.fontSize === b.fontSize
    && a.color === b.color
    && a.lineHeight === b.lineHeight;
}

/**
 * 把 text + runs 拆成「段落 → 字符 → 样式」的平面结构。
 *
 * 按码点拆（`Array.from`）而不是按 UTF-16 单元，否则一个 emoji 会被当成两个字符，
 * 换行可能落在它中间。
 *
 * 段落序号与 schema 的 `paragraphRanges` 一致：两处都按 `\n` 切，末尾的换行符
 * 后面算一个空段落，所以下标可以一一对应。
 */
function toParagraphs(input: RichTextLayoutInput): StyledChar[][] {
  const segments = textRunSegments(input.text, input.runs);
  const paragraphs: StyledChar[][] = [[]];
  for (const segment of segments) {
    const style: RichTextStyle = {
      fontWeight: segment.style.fontWeight ?? input.fontWeight,
      fontStyle: segment.style.fontStyle ?? input.fontStyle,
      fontSize: segment.style.fontSize ?? input.fontSize,
      ...(segment.style.color ? { color: segment.style.color } : {}),
      ...(segment.style.lineHeight !== undefined ? { lineHeight: segment.style.lineHeight } : {}),
    };
    for (const value of Array.from(segment.text)) {
      if (value === "\n") paragraphs.push([]);
      else paragraphs[paragraphs.length - 1]!.push({ value, style });
    }
  }
  return paragraphs;
}

function charWidth(input: RichTextLayoutInput, char: StyledChar): number {
  return input.measure(char.value, char.style) + input.letterSpacing * Array.from(char.value).length;
}

/** 行尾空格不参与排版（与 CSS 一致）；整行都是空格时保留一个字符，避免行宽凭空消失。 */
function trimTrailingSpaces(chars: StyledChar[], from: number, to: number): number {
  let end = to;
  while (end > from + 1 && chars[end - 1]!.value === " ") end -= 1;
  return end;
}

/** 把段落里的 [from, to) 组装成一行：相邻同样式合并，x 偏移按累计宽度算。 */
function buildLine(input: RichTextLayoutInput, chars: StyledChar[], from: number, to: number): Omit<RichTextLine, "paragraphIndex" | "left" | "marker" | "markerWidth" | "hanging"> {
  const segments: RichTextSegment[] = [];
  let x = 0;
  let index = from;
  while (index < to) {
    const style = chars[index]!.style;
    let text = "";
    while (index < to && sameStyle(chars[index]!.style, style)) {
      text += chars[index]!.value;
      index += 1;
    }
    segments.push({ text, style, x });
    x += input.measure(text, style) + input.letterSpacing * Array.from(text).length;
  }
  return { segments, width: x, height: lineHeightFor(input, chars, from, to) };
}

/**
 * 行高 = max(节点行高, 该行所有 run 的行高覆盖, 该行最大字号)。
 *
 * 三者取最大而不是迭代求解：字号变大时行盒跟着变高，不会被相邻行压住；
 * 段内行高覆盖只是把所在行的行盒抬到指定高度下限。
 *
 * 段内行高**不参与换行**：换行只看字号与宽度，所以「把一行撑高」不会让后面的行
 * 折返位置改变，只会让整段往下推。
 */
function lineHeightFor(input: RichTextLayoutInput, chars: StyledChar[], from: number, to: number): number {
  let maxFontSize = 0;
  let maxLineHeight = 0;
  for (let index = from; index < to; index += 1) {
    const style = chars[index]!.style;
    maxFontSize = Math.max(maxFontSize, style.fontSize);
    if (style.lineHeight !== undefined) maxLineHeight = Math.max(maxLineHeight, style.lineHeight);
  }
  return Math.max(1, input.lineHeight, maxLineHeight, maxFontSize);
}

/**
 * 纯函数换行：画布、浏览器测量器、布局引擎共用这一份，避免「画布换行位置和导出不一致」。
 *
 * 逐字符累加宽度；到达行宽时回退到本行最后一个空格断行（拉丁文优先断词，
 * 一个词本身超宽才按字符硬断，中文没有空格因此天然按字断行）。
 *
 * 段落样式在这里生效：列表段落整体右移（缩进 + 标记区），可用宽度相应减少，
 * 所以「加一级缩进」会真的让文字提前换行——这正是 Figma 的行为。
 */
export function layoutRichText(input: RichTextLayoutInput): RichTextLine[] {
  const paragraphs = toParagraphs(input);
  const resolved = resolveParagraphs(input.text, input.paragraphStyles);
  const lines: RichTextLine[] = [];

  paragraphs.forEach((chars, paragraphIndex) => {
    const info = resolved[paragraphIndex];
    // 段落缩进只对左对齐生效：居中/右对齐时把它从左偏移里扣掉。
    const paragraphIndent = info?.paragraphIndent ?? 0;
    const left = (info?.left ?? 0) - (input.align && input.align !== "left" ? paragraphIndent : 0);
    const marker = info?.marker;
    const markerWidth = info?.markerWidth ?? 0;
    // 缩进吃掉一部分可用宽度：文字不能越过文本框右边界。
    const available = input.availableWidth && input.availableWidth > 0
      ? Math.max(1, input.availableWidth - left)
      : undefined;
    // 标记只画在段落的首行；折行后的行与首行文字左对齐（与 CSS 的列表一致）。
    let firstLine = true;
    const push = (line: Omit<RichTextLine, "paragraphIndex" | "left" | "marker" | "markerWidth" | "hanging">) => {
      lines.push({
        ...line,
        paragraphIndex,
        left,
        markerWidth,
        ...(marker && firstLine ? { marker } : {}),
        ...(info?.hanging ? { hanging: true } : {}),
      });
      firstLine = false;
    };

    if (!chars.length) {
      push({ segments: [], width: 0, height: Math.max(1, input.lineHeight) });
    } else if (!available) {
      push(buildLine(input, chars, 0, chars.length));
    } else {
      let start = 0;
      while (start < chars.length) {
        let width = 0;
        let lastSpace = -1;
        let end = start;
        while (end < chars.length) {
          const next = charWidth(input, chars[end]!);
          if (width + next > available && end > start) break;
          width += next;
          if (chars[end]!.value === " ") lastSpace = end;
          end += 1;
        }
        if (end >= chars.length) {
          push(buildLine(input, chars, start, trimTrailingSpaces(chars, start, chars.length)));
          break;
        }
        // 断行点：优先上一处空格，并且把断点处的空格留在行尾之外（CSS 也不会画出行尾空格）；
        // 没有空格（或空格就是行首）就硬断在溢出字符之前。
        const breakAt = lastSpace > start ? lastSpace : end;
        push(buildLine(input, chars, start, Math.max(start + 1, breakAt)));
        start = lastSpace > start ? lastSpace + 1 : end;
        while (start < chars.length && chars[start]!.value === " ") start += 1;
      }
    }
    // 段末的列表间距：加到本段最后一行的行高上——后续行因此整体下移，
    // 而这一行自己的文字位置不变。
    const spaceAfter = info?.spaceAfter ?? 0;
    if (spaceAfter > 0 && lines.length) {
      const last = lines[lines.length - 1]!;
      last.height += spaceAfter;
    }
  });
  return lines;
}

/** 富文本的尺寸：最长行宽（按可用宽度截断）与**各行高度之和**（大字号行会更高）。 */
export function measureRichText(input: RichTextLayoutInput): { width: number; height: number; lineCount: number } {
  const lines = layoutRichText(input);
  // 缩进的段落整体更靠右，hug 宽度要把左偏移算进去，否则节点会比文字窄。
  const longest = lines.reduce((max, line) => Math.max(max, line.left + line.width), 0);
  const width = input.availableWidth && input.availableWidth > 0 ? Math.min(longest, input.availableWidth) : longest;
  const height = lines.reduce((sum, line) => sum + line.height, 0);
  return { width, height: Math.max(1, height), lineCount: Math.max(1, lines.length) };
}
