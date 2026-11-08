import type { AssetId, FontStyle } from "./types";

/**
 * 字体声明。
 *
 * 文档里只登记「用了哪个字体文件」，不内联字节——字节仍是资源表里的哈希资源，
 * 与图片共用同一套去重与校验；`assetId` 缺省表示该字体依赖系统安装。
 */
export interface DocumentFont {
  family: string;
  /** 上传字体文件的资源 id；缺省 = 系统字体。 */
  assetId?: AssetId;
  /** 这个字体文件提供的字重，缺省 400。 */
  weight?: number;
  /** 这个字体文件提供的字形，缺省 normal。 */
  style?: FontStyle;
}

/** 可以在资源表里出现的字体 MIME（浏览器对 ttf/otf 的类型上报并不统一，因此两种都收）。 */
export const FONT_MIME_TYPES = [
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "font/collection",
  "application/font-woff",
  "application/font-sfnt",
  "application/x-font-ttf",
  "application/x-font-otf",
  "application/x-font-truetype",
] as const;

export function isFontMimeType(mimeType: string): boolean {
  return (FONT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

/** 字体的唯一键：同一族名可以有多份不同字重/字形的文件。 */
export function fontKey(font: Pick<DocumentFont, "family" | "weight" | "style">): string {
  return `${font.family.trim()}\u0000${font.weight ?? 400}\u0000${font.style ?? "normal"}`;
}

/** 文档里某族名的全部声明。 */
export function documentFontsFor(document: { fonts?: DocumentFont[] }, family: string): DocumentFont[] {
  return (document.fonts ?? []).filter(font => font.family === family);
}
