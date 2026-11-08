import { textRunSegments, type FontStyle, type TextRun } from "@ufira/design-schema";

/** 解析后的字符样式：节点级默认值 + 段内覆盖。 */
export interface RichTextStyle {
  fontWeight: number;
  fontStyle: FontStyle;
  /** 字号（px）。段内字号会同时改变宽度与行高。 */
  fontSize: number;
  color?: string;
}

export interface RichTextSegment {
  text: string;
  style: RichTextStyle;
  /** 相对行首的 x 偏移；换行由调用方决定，渲染器只负责平移。 */
  x: number;
}

export interface RichTextLine {
  segments: RichTextSegment[];
  width: number;
  /** 这一行的高度：节点行高与该行最大字号的较大者——大字号不会被上一行压住。 */
  height: number;
}

export interface RichTextLayoutInput {
  text: string;
  runs?: readonly TextRun[];
  /** 节点级默认样式，段内没有覆盖时用它。 */
  fontWeight: number;
  fontStyle: FontStyle;
  /** 节点级字号；段内没有覆盖时用它。 */
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
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
  return a.fontWeight === b.fontWeight && a.fontStyle === b.fontStyle && a.fontSize === b.fontSize && a.color === b.color;
}

/**
 * 把 text + runs 拆成「段落 → 字符 → 样式」的平面结构。
 *
 * 按码点拆（`Array.from`）而不是按 UTF-16 单元，否则一个 emoji 会被当成两个字符，
 * 换行可能落在它中间。
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
function buildLine(input: RichTextLayoutInput, chars: StyledChar[], from: number, to: number): RichTextLine {
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

/** 行高 = max(节点行高, 该行最大字号)；字号变大时行盒跟着变高，不会被相邻行压住。 */
function lineHeightFor(input: RichTextLayoutInput, chars: StyledChar[], from: number, to: number): number {
  let maxFontSize = 0;
  for (let index = from; index < to; index += 1) maxFontSize = Math.max(maxFontSize, chars[index]!.style.fontSize);
  return Math.max(1, input.lineHeight, maxFontSize);
}

/**
 * 纯函数换行：画布、浏览器测量器、布局引擎共用这一份，避免「画布换行位置和导出不一致」。
 *
 * 逐字符累加宽度；到达行宽时回退到本行最后一个空格断行（拉丁文优先断词，
 * 一个词本身超宽才按字符硬断，中文没有空格因此天然按字断行）。
 */
export function layoutRichText(input: RichTextLayoutInput): RichTextLine[] {
  const paragraphs = toParagraphs(input);
  const available = input.availableWidth;
  const lines: RichTextLine[] = [];

  for (const chars of paragraphs) {
    if (!chars.length) {
      lines.push({ segments: [], width: 0, height: Math.max(1, input.lineHeight) });
      continue;
    }
    if (!available || available <= 0) {
      lines.push(buildLine(input, chars, 0, chars.length));
      continue;
    }

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
        lines.push(buildLine(input, chars, start, trimTrailingSpaces(chars, start, chars.length)));
        break;
      }
      // 断行点：优先上一处空格，并且把断点处的空格留在行尾之外（CSS 也不会画出行尾空格）；
      // 没有空格（或空格就是行首）就硬断在溢出字符之前。
      const breakAt = lastSpace > start ? lastSpace : end;
      lines.push(buildLine(input, chars, start, Math.max(start + 1, breakAt)));
      start = lastSpace > start ? lastSpace + 1 : end;
      while (start < chars.length && chars[start]!.value === " ") start += 1;
    }
  }
  return lines;
}

/** 富文本的尺寸：最长行宽（按可用宽度截断）与**各行高度之和**（大字号行会更高）。 */
export function measureRichText(input: RichTextLayoutInput): { width: number; height: number; lineCount: number } {
  const lines = layoutRichText(input);
  const longest = lines.reduce((max, line) => Math.max(max, line.width), 0);
  const width = input.availableWidth && input.availableWidth > 0 ? Math.min(longest, input.availableWidth) : longest;
  const height = lines.reduce((sum, line) => sum + line.height, 0);
  return { width, height: Math.max(1, height), lineCount: Math.max(1, lines.length) };
}
