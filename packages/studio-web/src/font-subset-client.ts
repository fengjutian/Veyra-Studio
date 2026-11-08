import subsetWasmUrl from "harfbuzzjs/dist/harfbuzz-subset.wasm?url";
import { instantiateFontSubsetter, type FontSubsetter } from "@ufira/design-export";
import { setFontSubsetProvider } from "@ufira/studio-application";

/**
 * 浏览器端的字体子集化器（HarfBuzz wasm）。
 *
 * wasm 有 683 KB，所以**只在真的要子集化时才拉**：模块本身只是拿到一个 URL，
 * 真正的 fetch 发生在 {@link loadFontSubsetter} 被调用时。同一页面里只加载一次
 * （wasm 实例不能并发复用同一个实例化结果之外的资源，这里缓存 Promise 即可）。
 *
 * 规格见 `docs/font-management.md`。
 */

let pending: Promise<FontSubsetter> | undefined;

/**
 * 载入子集化器（懒加载 wasm）。
 *
 * 失败时清掉缓存，下次调用会重新尝试——不能因为一次网络抖动就把能力永久关掉。
 */
export function loadFontSubsetter(): Promise<FontSubsetter> {
  if (!pending) {
    pending = fetch(subsetWasmUrl)
      .then(response => {
        if (!response.ok) throw new Error(`子集化 wasm 拉取失败（HTTP ${response.status}）`);
        return response.arrayBuffer();
      })
      .then(bytes => instantiateFontSubsetter(bytes))
      .catch(error => {
        pending = undefined;
        throw error;
      });
  }
  return pending;
}

/** 子集化 wasm 的资源 URL（诊断与测试用）。 */
export const fontSubsetWasmUrl = subsetWasmUrl;

/**
 * 把子集化能力注册到导出链路。
 *
 * 注册的是**承诺**而不是实例：wasm 只在真的遇到超限字体时才加载，
 * 平时导出不会多付这几百 KB 的下载。
 */
export function registerFontSubsetter(): void {
  setFontSubsetProvider(() => loadFontSubsetter());
}
