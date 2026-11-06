import type { TextNode } from "@ufira/design-schema";
import type { Size, TextMeasurer, TextMeasurementRequest } from "./types";

/**
 * Average advance width ratio per character, expressed as a fraction of font size.
 * Latin glyphs in common UI fonts sit near 0.5, CJK glyphs are full-width (1.0).
 */
const LATIN_ADVANCE_RATIO = 0.55;
const CJK_ADVANCE_RATIO = 1;
const SPACE_ADVANCE_RATIO = 0.28;

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
 * Splits text into visual lines given an available width.
 *
 * The estimator cannot know real glyph advances, so it measures per code point and
 * breaks at the last code point that still fits. Explicit newlines always break.
 */
export function wrapTextLines(text: string, fontSize: number, availableWidth?: number): string[] {
  const paragraphs = text.split("\n");
  if (!availableWidth || availableWidth <= 0) return paragraphs;
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    let current = "";
    let currentWidth = 0;
    for (const character of Array.from(paragraph)) {
      const width = advanceRatio(character.codePointAt(0) ?? 0) * fontSize;
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
      const lines = wrapTextLines(node.text, node.fontSize, availableWidth);
      const longest = lines.reduce((max, line) => {
        const width = Array.from(line).reduce((sum, character) => sum + advanceRatio(character.codePointAt(0) ?? 0) * node.fontSize, 0);
        return Math.max(max, width);
      }, 0);
      const width = availableWidth && availableWidth > 0 ? Math.min(longest, availableWidth) : longest;
      return { width, height: Math.max(1, lines.length) * node.lineHeight };
    },
  };
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
        availableWidth,
      });
      return {
        width: Number.isFinite(size.width) ? Math.max(0, size.width) : 0,
        height: Number.isFinite(size.height) ? Math.max(0, size.height) : 0,
      };
    },
  };
}
