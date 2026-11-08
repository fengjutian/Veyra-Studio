import { TEXT_DEFAULTS, type TextNode } from "@ufira/design-schema";
import type { Size, TextMeasurer, TextMeasurementRequest } from "./types";
import { measureRichText, type RichTextStyle } from "./rich-text-layout";

/**
 * Average advance width ratio per character, expressed as a fraction of font size.
 * Latin glyphs in common UI fonts sit near 0.5, CJK glyphs are full-width (1.0).
 */
const LATIN_ADVANCE_RATIO = 0.55;
const CJK_ADVANCE_RATIO = 1;
const SPACE_ADVANCE_RATIO = 0.28;

/** Bold glyphs are a little wider than their regular counterparts. */
const BOLD_ADVANCE_FACTOR = 1.06;
const BOLD_WEIGHT_THRESHOLD = 600;

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK Symbols
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
];

function isCjk(codePoint: number): boolean {
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/**
 * Advance width of a single code point, in em units.
 */
export function advanceRatio(codePoint: number): number {
  if (codePoint === 0x20) return SPACE_ADVANCE_RATIO;
  if (isCjk(codePoint)) return CJK_ADVANCE_RATIO;
  return LATIN_ADVANCE_RATIO;
}

/**
 * How much wider each glyph gets because of the font weight.
 *
 * The estimator has no real font metrics, so bold is approximated as a small
 * uniform stretch. Hosts that measure real fonts do not need this.
 */
export function fontAdvanceScale(fontWeight: number): number {
  return fontWeight >= BOLD_WEIGHT_THRESHOLD ? BOLD_ADVANCE_FACTOR : 1;
}

/**
 * Width of one code point, in pixels, including weight and letter spacing.
 *
 * CSS letter spacing is added after every character, including the last one.
 */
function characterWidth(codePoint: number, fontSize: number, scale: number, letterSpacing: number): number {
  return advanceRatio(codePoint) * fontSize * scale + letterSpacing;
}

/**
 * Splits text into visual lines given an available width.
 *
 * The estimator cannot know real glyph advances, so it measures per code point and
 * breaks at the last code point that still fits. Explicit newlines always break.
 * Letter spacing and font weight are part of the width of every character.
 */
export function wrapTextLines(text: string, fontSize: number, availableWidth?: number, letterSpacing = 0, fontWeight: number = TEXT_DEFAULTS.fontWeight): string[] {
  const paragraphs = text.split("\n");
  if (!availableWidth || availableWidth <= 0) return paragraphs;
  const scale = fontAdvanceScale(fontWeight);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let current = "";
    let currentWidth = 0;
    for (const character of Array.from(paragraph)) {
      const width = characterWidth(character.codePointAt(0) ?? 0, fontSize, scale, letterSpacing);
      if (current && currentWidth + width > availableWidth) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      current += character;
      currentWidth += width;
    }
    lines.push(current);
  }
  return lines;
}

/**
 * A deterministic, host-independent text measurer.
 *
 * It approximates glyph advances instead of measuring real fonts, so it must not be
 * treated as pixel-accurate. Use it as the fallback when no host measurer is
 * available, and pass a real measurer for pixel-accurate layout.
 */
export function createEstimateTextMeasurer(): TextMeasurer {
  return {
    measure(node: TextNode, availableWidth?: number): Size {
      const letterSpacing = node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing;
      const fontWeight = node.fontWeight ?? TEXT_DEFAULTS.fontWeight;
      const fontStyle = node.fontStyle ?? TEXT_DEFAULTS.fontStyle;
      if (node.runs?.length) {
        // 富文本必须按区间量宽：一段加粗文字比常规文字更宽，忽略它 hug 高度就会算错。
        const measured = measureRichText({
          text: node.text,
          runs: node.runs,
          fontWeight,
          fontStyle,
          fontSize: node.fontSize,
          lineHeight: node.lineHeight,
          letterSpacing,
          availableWidth,
          measure: (value, style) => estimateWidth(value, style),
        });
        return { width: measured.width, height: measured.height };
      }
      const scale = fontAdvanceScale(fontWeight);
      const lines = wrapTextLines(node.text, node.fontSize, availableWidth, letterSpacing, fontWeight);
      const longest = lines.reduce((max, line) => {
        const width = Array.from(line).reduce((sum, character) => sum + characterWidth(character.codePointAt(0) ?? 0, node.fontSize, scale, letterSpacing), 0);
        return Math.max(max, width);
      }, 0);
      const width = availableWidth && availableWidth > 0 ? Math.min(longest, availableWidth) : longest;
      return { width, height: Math.max(1, lines.length) * node.lineHeight };
    },
  };
}

/** 估算器量一段同款样式的文字（不含字距，字距由 rich-text-layout 统一补）。 */
function estimateWidth(text: string, style: RichTextStyle): number {
  const scale = fontAdvanceScale(style.fontWeight);
  return Array.from(text).reduce((sum, character) => sum + advanceRatio(character.codePointAt(0) ?? 0) * style.fontSize * scale, 0);
}

/**
 * Builds a measurer that delegates to a host-provided measurement callback.
 *
 * The host callback receives the full request (text, font, available width) and
 * returns the measured size. Use it to bridge a browser, canvas or platform API
 * into the host-independent layout engine.
 */
export function createHostTextMeasurer(
  measure: (request: TextMeasurementRequest) => Size,
): TextMeasurer {
  return {
    measure(node: TextNode, availableWidth?: number): Size {
      const size = measure({
        text: node.text,
        fontFamily: node.fontFamily,
        fontSize: node.fontSize,
        lineHeight: node.lineHeight,
        fontWeight: node.fontWeight ?? TEXT_DEFAULTS.fontWeight,
        fontStyle: node.fontStyle ?? TEXT_DEFAULTS.fontStyle,
        letterSpacing: node.letterSpacing ?? TEXT_DEFAULTS.letterSpacing,
        ...(node.runs?.length ? { runs: node.runs } : {}),
        availableWidth,
      });
      return {
        width: Number.isFinite(size.width) ? Math.max(0, size.width) : 0,
        height: Number.isFinite(size.height) ? Math.max(0, size.height) : 0,
      };
    },
  };
}
