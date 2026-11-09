import type { ImageNode } from "@ufira/design-schema";

/**
 * 图片插入的浏览器侧工具。
 *
 * 这里只放不碰 React 的纯逻辑（哈希、尺寸、样式映射、文件校验），
 * 这样 node 测试能直接覆盖，而不必把整个工作台塞进 jsdom。
 */

/** 插入图片时节点包围盒的上限（px）；更大的图按比例缩到这个框里。 */
export const IMAGE_INSERT_MAX_SIZE = 480;

/** 单张图片允许的最大字节数；超限时明确报错，而不是把 IndexedDB 塞爆。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * 支持插入的图片格式。
 *
 * 这份清单必须和 `design-export` 的资源 URL 白名单一致：导出器只接受
 * `data:image/(png|jpeg|gif|webp|svg+xml)`，插进来的格式如果导出不了，用户会拿到
 * 一张只有空框的交付物，所以不如在插入时就说清楚。
 *
 * SVG 走 `<img src="data:image/svg+xml;base64,…">` 与画布 `drawImage`，
 * 两者都**不执行脚本**，所以外部 SVG 里的 `<script>` 不会跑起来。
 */
export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;

export function isSupportedImageType(type: string): boolean {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());
}

/** 资源 id 由内容哈希推导：同一张图重复插入会落到同一个资源上。 */
export function assetIdForHash(hash: string): string {
  return `asset:${hash.slice(0, 16)}`;
}

/** 图片字节的 SHA-256，和仓库校验资源用的是同一种摘要。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 SHA-256，无法导入图片");
  const digest = await subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 按原图比例算出插入后的节点尺寸。
 *
 * 小图保持原尺寸（不放大），大图等比缩到 `max` 以内；宽高至少 1px，
 * 避免零尺寸节点让布局引擎和命中测试退化成不可选中的点。
 */
export function fitImageBox(size: { width: number; height: number }, max = IMAGE_INSERT_MAX_SIZE): { width: number; height: number } {
  const width = Number.isFinite(size.width) && size.width > 0 ? size.width : 1;
  const height = Number.isFinite(size.height) && size.height > 0 ? size.height : 1;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 读取图片的原始像素尺寸。
 *
 * 浏览器用 `createImageBitmap`；SVG 常常没有像素级固有尺寸（只有 viewBox），
 * 这时从文本里解析；都拿不到就退回一个固定尺寸，让插入流程继续走完。
 */
export async function readImageSize(file: Blob, fallback = { width: 240, height: 160 }): Promise<{ width: number; height: number }> {
  const create = (globalThis as { createImageBitmap?: (source: Blob) => Promise<{ width: number; height: number; close?: () => void }> }).createImageBitmap;
  if (create) {
    try {
      const bitmap = await create(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      if (size.width > 0 && size.height > 0) return size;
    } catch {
      // 解码失败（含没有固有尺寸的 SVG）继续往下走文本解析。
    }
  }
  if (file.type === "image/svg+xml") {
    const text = await file.text().catch(() => "");
    const size = svgIntrinsicSize(text);
    if (size) return size;
  }
  return fallback;
}

/**
 * 从 SVG 文本里读固有尺寸。
 *
 * 优先 `width`/`height`（支持 px 与无单位），其次 `viewBox` 的宽高；
 * 百分比尺寸没有确定像素值，忽略。解析失败返回 `undefined`，不猜。
 */
export function svgIntrinsicSize(text: string): { width: number; height: number } | undefined {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!tag) return undefined;
  const attribute = (name: string): string | undefined => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const pixels = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const match = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value);
    if (!match) return undefined;
    const size = Number(match[1]);
    return Number.isFinite(size) && size > 0 ? size : undefined;
  };
  const width = pixels(attribute("width"));
  const height = pixels(attribute("height"));
  if (width && height) return { width, height };

  const viewBox = attribute("viewBox") ?? attribute("viewbox");
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) {
      // 只缺一边时用 viewBox 的另一边补上（等比）。
      return { width: width ?? parts[2]!, height: height ?? parts[3]! };
    }
  }
  return undefined;
}

/** `fit` 到 CSS 背景的映射；画布和导出的语义因此一致。 */
export function imageBackgroundStyle(fit: ImageNode["fit"]): { backgroundSize: string; backgroundPosition: string; backgroundRepeat: "no-repeat" } {
  return {
    backgroundSize: fit === "fill" ? "100% 100%" : fit === "contain" ? "contain" : "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  };
}

/** 插入前的文件校验；返回错误文案，通过则返回 undefined。 */
export function imageFileError(file: File, byteLength: number): string | undefined {
  if (!file.type.startsWith("image/")) return "只能插入图片文件";
  if (!isSupportedImageType(file.type)) return "导出只支持 PNG、JPEG、GIF、WebP、SVG，暂不能插入这个格式";
  if (!byteLength) return "图片内容为空";
  if (byteLength > MAX_IMAGE_BYTES) return `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB，请先压缩再插入`;
  return undefined;
}

/* ── 字体文件 ─────────────────────────────────────────────────────── */

/** 支持上传的字体格式。浏览器对 ttf/otf 的 MIME 上报不统一，因此按扩展名兜底。 */
export const SUPPORTED_FONT_EXTENSIONS: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

/** 单个字体文件的上限：字体比图片小得多，超过这个数多半是打包错了。 */
export const MAX_FONT_BYTES = 10 * 1024 * 1024;

/** 扩展名 → MIME；不认识返回 undefined。 */
export function fontMimeFromFileName(name: string): string | undefined {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_FONT_EXTENSIONS[extension];
}

/** 由文件名猜一个族名：去扩展名，下划线/连字符换成空格。用户仍可在弹窗里改。 */
export function fontFamilyFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return base || "Untitled Font";
}

/** 上传前的字体文件校验；返回错误文案，通过则 undefined。 */
export function fontFileError(file: File, byteLength: number, mimeType: string | undefined): string | undefined {
  if (!mimeType) return "只支持 .woff2 / .woff / .ttf / .otf 字体文件";
  if (!byteLength) return "字体文件内容为空";
  if (byteLength > MAX_FONT_BYTES) return `字体文件超过 ${MAX_FONT_BYTES / 1024 / 1024} MB`;
  void file;
  return undefined;
}