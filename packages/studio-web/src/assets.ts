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
 * 浏览器用 `createImageBitmap`；不可用或解码失败时退回一个固定尺寸，
 * 让插入流程继续走完，用户随后可以在属性面板里改宽高。
 */
export async function readImageSize(file: Blob, fallback = { width: 240, height: 160 }): Promise<{ width: number; height: number }> {
  const create = (globalThis as { createImageBitmap?: (source: Blob) => Promise<{ width: number; height: number; close?: () => void }> }).createImageBitmap;
  if (!create) return fallback;
  try {
    const bitmap = await create(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close?.();
    return size.width > 0 && size.height > 0 ? size : fallback;
  } catch {
    return fallback;
  }
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
  if (!byteLength) return "图片内容为空";
  if (byteLength > MAX_IMAGE_BYTES) return `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB，请先压缩再插入`;
  return undefined;
}
