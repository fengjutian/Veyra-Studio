/**
 * 导出落盘的统一出口。
 *
 * 浏览器里「导出」是 `<a download>`：文件落到浏览器自己的下载目录，用户既看不见
 * 路径，也管不了落在哪。桌面端（Tauri）里「导出」是原生「另存为」：用户自己选
 * 目录与文件名，存完把真实路径回报给界面。
 *
 * 两种环境的差异收在这一处，调用方只管问「存没存成、存在哪」：
 *
 * ```ts
 * const saved = await saveText("首页.html", html, "text/html");
 * setMessage(saveMessage(saved, "HTML 已导出"));
 * ```
 *
 * 浏览器分支的行为与改造前完全一致（`<a download>`），所以网页端的导出体验不受影响。
 */

import { isDesktop, saveFileOnDesktop } from "./desktop-bridge";

export interface SaveResult {
  /** 文件是否真的落到磁盘上了。用户取消保存时为 false。 */
  saved: boolean;
  /** 桌面端的真实落盘路径；浏览器分支没有这个概念（下载目录由浏览器管）。 */
  path?: string;
}

/** 保存二进制产物（PNG / PDF / ZIP 等）。 */
export async function saveBytes(name: string, bytes: Uint8Array, mime: string): Promise<SaveResult> {
  if (isDesktop()) {
    const path = await saveFileOnDesktop(name, bytes);
    return { saved: path !== undefined, path };
  }
  downloadInBrowser(name, bytes, mime);
  return { saved: true };
}

/** 保存文本产物（HTML / SVG / JSON / TSX 等）。 */
export async function saveText(name: string, content: string, mime: string): Promise<SaveResult> {
  return saveBytes(name, new TextEncoder().encode(content), mime);
}

/** 保存 data URL 产物（PNG 导出走这条路）。 */
export async function saveDataUrl(name: string, dataUrl: string): Promise<SaveResult> {
  if (isDesktop()) {
    const path = await saveFileOnDesktop(name, dataUrlBytes(dataUrl));
    return { saved: path !== undefined, path };
  }
  // 浏览器：保持原样，把 data URL 直接交给 `<a download>`。
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = name;
  link.click();
  return { saved: true };
}

/**
 * 导出后的提示文案。
 *
 * 桌面端把真实路径带上，用户能确认文件落在哪；用户取消时说「已取消」而不是
 * 报成功——取消保存后说「已导出」是骗人。
 */
export function saveMessage(result: SaveResult, text: string): string {
  if (!result.saved) return "已取消导出";
  return result.path ? `${text} · ${result.path}` : text;
}

/** 浏览器的下载：造一个 blob URL，点一下临时链接。 */
function downloadInBrowser(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** data URL → 字节。画布导出出来的是 base64 的 PNG。 */
function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return new Uint8Array();
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!header.includes(";base64")) {
    // 极少见的非 base64 data URL：按 UTF-8 文本处理。
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
