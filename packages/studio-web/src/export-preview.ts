import { base64FromBytes } from "@ufira/studio-application";
import type { ExportFormat } from "./export-report";

/**
 * 导出预览的内容。
 *
 * HTML 预览是把导出器产出的完整文档塞进 sandboxed iframe（`sandbox=""`：
 * 不执行脚本、不给同源权限），SVG/PNG 预览则用 data URL 交给 `<img>`。
 * 预览和真正下载的是同一份产物，不会出现"预览好看、下载走样"。
 */
export type PreviewContent =
  | { kind: "html"; html: string }
  | { kind: "image"; dataUrl: string; width?: number; height?: number };

export interface ExportPreview {
  format: ExportFormat;
  title: string;
  content: PreviewContent;
}

/** SVG 文本转 data URL；中文等非 ASCII 内容按 UTF-8 编码，避免 btoa 直接报错。 */
export function svgPreviewDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${base64FromBytes(new TextEncoder().encode(svg))}`;
}

/** 预览标题带上格式和范围，避免"我看到的是整页还是选区"说不清。 */
export function previewTitle(format: ExportFormat, scopeLabel: string): string {
  return `${format.toUpperCase()} 预览${scopeLabel}`;
}

/**
 * 把预览尺寸限制在给定上限内，等比缩放。
 *
 * 大画布按原尺寸塞进弹窗会把内容挤成一条缝，所以缩到能一眼看全的比例；
 * 尺寸未知时原样返回。
 */
export function fitPreviewSize(size: { width: number; height: number }, max = 720): { width: number; height: number } {
  if (size.width <= 0 || size.height <= 0) return size;
  const scale = Math.min(1, max / Math.max(size.width, size.height));
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
}
