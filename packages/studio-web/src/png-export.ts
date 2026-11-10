import { exportPageToSvg, type ExportDiagnostic } from "@ufira/design-export";
import type { AssetMetadata } from "@ufira/design-schema";
import { saveDataUrl, type SaveResult } from "./file-sink";

export interface PngExportResult {
  dataUrl: string;
  width: number;
  height: number;
  diagnostics: ExportDiagnostic[];
}

/**
 * Rasterizes a page to PNG using the browser's own renderer.
 *
 * The page is exported to SVG first and then drawn onto a canvas. This keeps the
 * exported image consistent with the SVG deliverable and avoids shipping a
 * headless browser to the workbench. Images that are inline data URLs keep the
 * canvas clean; a remote URL taints it, so that case is reported instead of
 * silently producing a broken image.
 */
export async function exportPageToPng(
  document: Parameters<typeof exportPageToSvg>[0],
  options: { pageId: string; viewport: { width: number; height: number }; title?: string; themeId?: string; scale?: number; nodeIds?: string[]; origin?: { x: number; y: number }; resolveAsset?: (asset: AssetMetadata) => string | undefined },
): Promise<PngExportResult> {
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const svgResult = exportPageToSvg(document, options);
  const diagnostics = [...svgResult.diagnostics];

  const canvas = createCanvas(options.viewport.width * scale, options.viewport.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");

  const image = await loadSvgImage(svgResult.svg, diagnostics);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/png");
  } catch (error) {
    diagnostics.push({
      feature: "png-rasterize",
      support: "unsupported",
      message: `The canvas could not be exported because it is tainted by an external resource: ${error instanceof Error ? error.message : String(error)}`,
    });
    throw new Error("PNG export failed because an external image tainted the canvas");
  }

  return { dataUrl, width: canvas.width, height: canvas.height, diagnostics };
}

function loadSvgImage(svg: string, diagnostics: ExportDiagnostic[]): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      diagnostics.push({ feature: "png-rasterize", support: "unsupported", message: "The exported SVG could not be decoded as an image" });
      reject(new Error("The exported SVG could not be decoded as an image"));
    };
    image.src = url;
  });
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = globalThis.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Saves a data URL as a file.
 *
 * Desktop (Tauri) gets the native "Save As" dialog; the browser keeps the
 * download it has always had. The difference lives in `file-sink`.
 */
export async function downloadDataUrl(filename: string, dataUrl: string): Promise<SaveResult> {
  return saveDataUrl(filename, dataUrl);
}
