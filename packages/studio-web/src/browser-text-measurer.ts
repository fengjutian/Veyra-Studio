import { createCachedTextMeasurer, createHostTextMeasurer, measureRichText, resolveFontFamily, type CachedTextMeasurer, type RichTextStyle, type TextMeasurementRequest, type TextMeasurer } from "@ufira/design-layout";

/**
 * Measures text with a real font engine.
 *
 * A canvas 2D context resolves the actual glyph advances for the requested font,
 * which is what the layout engine needs to size hugging text and to wrap lines.
 * Results go through the shared bounded cache so repeated layout passes do not
 * re-measure the same text.
 */
export function createBrowserTextMeasurer(): TextMeasurer {
  const context = createContext();
  const cached = createCachedTextMeasurer(createHostTextMeasurer(request => measure(context, request)), { limit: 512 });
  activeCache = cached;
  return cached;
}

/**
 * Drops every cached measurement.
 *
 * Web fonts load asynchronously: measurements taken before the font arrives use a
 * fallback face and are wrong afterwards. The app calls this once fonts are ready
 * so the next layout pass measures with the real face.
 */
export function resetBrowserTextMeasurementCache(): void {
  activeCache?.clear();
}

let activeCache: CachedTextMeasurer | undefined;

function createContext(): CanvasRenderingContext2D | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  return canvas.getContext("2d") ?? undefined;
}

function measure(
  context: CanvasRenderingContext2D | undefined,
  request: TextMeasurementRequest,
): { width: number; height: number } {
  return context ? measureWithCanvas(context, request) : measureWithoutCanvas(request);
}

/**
 * The CSS font shorthand for a request.
 *
 * The canvas font property follows CSS, so weight and style belong in the string;
 * a bold or italic text measures differently and must not share a cache entry.
 * The family goes through the shared fallback stack so a missing font still has a
 * predictable width instead of measuring whichever face the browser picks.
 */
function fontShorthand(request: TextMeasurementRequest): string {
  return fontFor(request, request.fontSize, request.fontWeight, request.fontStyle);
}

/** 指定字号/字重/字形的 CSS font 简写；段内样式切换字体时逐段换。 */
function fontFor(request: TextMeasurementRequest, fontSize: number, fontWeight: number, fontStyle: string): string {
  const style = fontStyle === "italic" ? "italic " : "";
  return `${style}${fontWeight} ${fontSize}px ${resolveFontFamily(request.fontFamily)}`;
}

/**
 * Width of one line including letter spacing.
 *
 * CSS adds letter spacing after every character, including the last one.
 */
function measureLine(context: CanvasRenderingContext2D, text: string, letterSpacing: number): number {
  const base = context.measureText(text).width;
  if (!letterSpacing) return base;
  return base + letterSpacing * Array.from(text).length;
}

function measureWithCanvas(
  context: CanvasRenderingContext2D,
  request: TextMeasurementRequest,
): { width: number; height: number } {
  context.textBaseline = "alphabetic";

  if (request.runs?.length || request.paragraphStyles?.length) {
    // 富文本：逐段换字体量宽，换行也必须走同一套（否则 hug 高度和画布行数会打架）。
    // 段落样式（缩进）会吃掉可用宽度，同样必须走这条路径。
    const measured = measureRichText({
      text: request.text,
      runs: request.runs,
      paragraphStyles: request.paragraphStyles,
      fontWeight: request.fontWeight,
      fontStyle: request.fontStyle,
      fontSize: request.fontSize,
      lineHeight: request.lineHeight,
      letterSpacing: request.letterSpacing,
      availableWidth: request.availableWidth,
      measure: (value: string, style: RichTextStyle) => {
        context.font = fontFor(request, style.fontSize, style.fontWeight, style.fontStyle);
        return context.measureText(value).width;
      },
    });
    return { width: measured.width, height: measured.height };
  }

  context.font = fontShorthand(request);
  const paragraphs = request.text.split("\n");
  let longest = 0;
  const lineWidths: number[] = [];

  for (const paragraph of paragraphs) {
    const lines = wrapByWidth(context, paragraph, request.availableWidth, request.letterSpacing);
    for (const line of lines) {
      const width = measureLine(context, line, request.letterSpacing);
      lineWidths.push(width);
      longest = Math.max(longest, width);
    }
  }

  const lineCount = Math.max(1, lineWidths.length);
  const width = request.availableWidth && request.availableWidth > 0
    ? Math.min(longest, request.availableWidth)
    : longest;

  return { width, height: lineCount * request.lineHeight };
}

/**
 * Breaks a single paragraph into lines that fit the available width.
 * Words longer than the limit are broken by character so nothing overflows silently.
 */
function wrapByWidth(context: CanvasRenderingContext2D, text: string, availableWidth?: number, letterSpacing = 0): string[] {
  if (!availableWidth || availableWidth <= 0) return [text];
  if (!text) return [""];
  if (measureLine(context, text, letterSpacing) <= availableWidth) return [text];

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/(\s+)/)) {
    const candidate = current + word;
    if (current && measureLine(context, candidate, letterSpacing) > availableWidth) {
      lines.push(current);
      current = word.trimStart();
    } else {
      current = candidate;
    }

    while (measureLine(context, current, letterSpacing) > availableWidth && current.length > 1) {
      let cut = current.length - 1;
      while (cut > 1 && measureLine(context, current.slice(0, cut), letterSpacing) > availableWidth) cut -= 1;
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function measureWithoutCanvas(request: TextMeasurementRequest): { width: number; height: number } {
  const spacing = request.letterSpacing * Array.from(request.text).length;
  const longest = request.text.split("\n").reduce((max, line) => Math.max(max, line.length * request.fontSize * 0.55 + spacing), 0);
  const width = request.availableWidth && request.availableWidth > 0 ? Math.min(longest, request.availableWidth) : longest;
  return { width, height: request.text.split("\n").length * request.lineHeight };
}
