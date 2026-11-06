import { createHostTextMeasurer, type TextMeasurementRequest, type TextMeasurer } from "@ufira/design-layout";

/**
 * Measures text with a real font engine.
 *
 * A canvas 2D context resolves the actual glyph advances for the requested font,
 * which is what the layout engine needs to size hugging text and to wrap lines.
 * Results are cached per (font, text, width) because measurement is the hot path
 * during layout.
 */
export function createBrowserTextMeasurer(): TextMeasurer {
  const context = createContext();
  const cache = new Map<string, { width: number; height: number }>();
  const measurer = createHostTextMeasurer(request => measure(context, request, cache));
  return measurer;
}

function createContext(): CanvasRenderingContext2D | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  return canvas.getContext("2d") ?? undefined;
}

function measure(
  context: CanvasRenderingContext2D | undefined,
  request: TextMeasurementRequest,
  cache: Map<string, { width: number; height: number }>,
): { width: number; height: number } {
  const key = `${request.fontFamily}|${request.fontSize}|${request.lineHeight}|${request.availableWidth ?? ""}|${request.text}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = context
    ? measureWithCanvas(context, request)
    : measureWithoutCanvas(request);

  cache.set(key, size);
  return size;
}

function measureWithCanvas(
  context: CanvasRenderingContext2D,
  request: TextMeasurementRequest,
): { width: number; height: number } {
  context.font = `${request.fontSize}px ${request.fontFamily}`;
  context.textBaseline = "alphabetic";

  const paragraphs = request.text.split("\n");
  let longest = 0;
  const lineWidths: number[] = [];

  for (const paragraph of paragraphs) {
    const lines = wrapByWidth(context, paragraph, request.availableWidth);
    for (const line of lines) {
      const width = context.measureText(line).width;
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
function wrapByWidth(context: CanvasRenderingContext2D, text: string, availableWidth?: number): string[] {
  if (!availableWidth || availableWidth <= 0) return [text];
  if (!text) return [""];
  if (context.measureText(text).width <= availableWidth) return [text];

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(/(\s+)/)) {
    const candidate = current + word;
    if (current && context.measureText(candidate).width > availableWidth) {
      lines.push(current);
      current = word.trimStart();
    } else {
      current = candidate;
    }

    while (context.measureText(current).width > availableWidth && current.length > 1) {
      let cut = current.length - 1;
      while (cut > 1 && context.measureText(current.slice(0, cut)).width > availableWidth) cut -= 1;
      lines.push(current.slice(0, cut));
      current = current.slice(cut);
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function measureWithoutCanvas(request: TextMeasurementRequest): { width: number; height: number } {
  const longest = request.text.split("\n").reduce((max, line) => Math.max(max, line.length * request.fontSize * 0.55), 0);
  const width = request.availableWidth && request.availableWidth > 0 ? Math.min(longest, request.availableWidth) : longest;
  return { width, height: request.text.split("\n").length * request.lineHeight };
}
