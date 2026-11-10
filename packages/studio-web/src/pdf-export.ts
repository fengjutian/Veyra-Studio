import { exportPageToSvg, exportRastersToPdf, type ExportDiagnostic } from "@ufira/design-export";
import type { AssetMetadata, DesignDocument } from "@ufira/design-schema";

/**
 * PDF 导出（图像型）。
 *
 * 每一页先走 SVG 导出，再用浏览器把它画进 canvas——和「导出 PNG」是同一条
 * 渲染路径，所以 PDF 里看到的就是画布上看到的那张图。
 *
 * 位图按 2× 渲染（打印更清楚），但 PDF 页面尺寸仍按设计尺寸算（96dpi → 72dpi），
 * 所以「2× 的像素放进同样大小的页面」——清晰度上去了，尺寸没变。
 *
 * 限制说清楚：这是**图片型 PDF**，文字不可选、不可搜索。矢量 PDF（内嵌字体）是
 * 另一条路，本版没做。
 */

export interface PdfExportOptions {
  viewport: { width: number; height: number };
  title?: string;
  themeId?: string;
  /** 位图分辨率倍率，默认 2。 */
  scale?: number;
  resolveAsset?: (asset: AssetMetadata) => string | undefined;
}

export interface PdfExportResult {
  bytes: Uint8Array;
  pageCount: number;
  diagnostics: ExportDiagnostic[];
}

export async function exportDocumentToPdf(
  document: DesignDocument,
  options: PdfExportOptions,
): Promise<PdfExportResult> {
  const scale = options.scale && options.scale > 0 ? options.scale : 2;
  const diagnostics: ExportDiagnostic[] = [];
  const pages: Array<{ pixels: Uint8Array; width: number; height: number; widthPoints: number; heightPoints: number }> = [];

  for (const pageId of document.pageOrder) {
    const svg = exportPageToSvg(document, {
      pageId,
      viewport: options.viewport,
      title: options.title,
      themeId: options.themeId,
      resolveAsset: options.resolveAsset,
    });
    diagnostics.push(...svg.diagnostics);
    const pixels = await rasterize(svg.svg, options.viewport.width * scale, options.viewport.height * scale, diagnostics);
    pages.push({
      pixels,
      width: Math.round(options.viewport.width * scale),
      height: Math.round(options.viewport.height * scale),
      // 页面尺寸按设计尺寸算，与位图分辨率无关。
      widthPoints: options.viewport.width * 0.75,
      heightPoints: options.viewport.height * 0.75,
    });
  }

  const result = await exportRastersToPdf(pages, { title: options.title });
  return { bytes: result.bytes, pageCount: result.pageCount, diagnostics: [...diagnostics, ...result.diagnostics] };
}

/** SVG → canvas → 像素。跨域资源会污染画布，那种情况直接报错（不产出半张图）。 */
async function rasterize(
  svg: string,
  width: number,
  height: number,
  diagnostics: ExportDiagnostic[],
): Promise<Uint8Array> {
  const scope = globalThis as unknown as {
    document?: { createElement(tag: string): HTMLCanvasElement };
    Image?: new () => HTMLImageElement;
    URL?: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void };
    Blob?: new (parts: unknown[], options?: { type?: string }) => Blob;
  };
  if (!scope.document || !scope.Image || !scope.URL || !scope.Blob) {
    throw new Error("当前环境没有 Canvas，无法导出 PDF");
  }

  const canvas = scope.document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");

  const blob = new scope.Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = scope.URL.createObjectURL(blob);
  const image = new scope.Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("导出的 SVG 没能解码成图片"));
      image.src = url;
    });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    // ImageData 的 data 是 Uint8ClampedArray，PDF 那头要的是 Uint8Array：复制一份。
    return new Uint8Array(imageData.data);
  } catch (error) {
    diagnostics.push({
      feature: "pdf-rasterize",
      support: "unsupported",
      message: `页面没能画进画布：${error instanceof Error ? error.message : String(error)}`,
    });
    throw error;
  } finally {
    scope.URL.revokeObjectURL(url);
  }
}
