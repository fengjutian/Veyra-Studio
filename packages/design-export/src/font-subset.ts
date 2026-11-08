/**
 * 字体子集化（HarfBuzz `hb_subset`）。
 *
 * 中文字体动辄几 MB，而导出物内联有 1 MB 的上限——不裁字形就内联不进去，
 * 交付物打开时会走回退字形。`subset-font` 这个 npm 包是 Node-only（依赖 fs），
 * `fonteditor-core` 的 `write({ subset })` 又不裁字形（实测：Arial 1,045,720 B
 * 只留 8 个字符仍是 365,520 B）。
 *
 * 这里直接用 `harfbuzzjs` 包里那份**独立的 `harfbuzz-subset.wasm`**：
 * 它导出了 `hb_subset` 的 C API，wasm 字节由调用方注入——
 * 浏览器端用 Vite 的 `?url` 拿到 URL 再 fetch，Node 端用 fs 读文件，
 * 核心逻辑两边完全一样（不用 fs，也不用 Buffer）。
 *
 * 规格见 `docs/font-management.md`。
 */

/** wasm 内存的最小形状（这个包没有 DOM lib，不能直接用 `WebAssembly.Memory`）。 */
interface WasmMemory {
  buffer: ArrayBuffer;
}

/** 实例化 wasm 需要的最小全局形状。 */
interface WasmGlobal {
  instantiate(source: ArrayBuffer | Uint8Array): Promise<{ instance: { exports: unknown } }>;
}

/** `hb_subset` wasm 暴露的 C API（只列出用到的那些）。 */
export interface SubsetWasmExports {
  memory: WasmMemory;
  malloc(size: number): number;
  free(pointer: number): void;
  _initialize(): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_input_set(input: number, set: number): number;
  hb_set_add(set: number, value: number): void;
  hb_set_clear(set: number): void;
  hb_set_invert(set: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

/** `hb_memory_mode_t`：HB_MEMORY_MODE_WRITABLE。 */
const HB_MEMORY_MODE_WRITABLE = 2;
/** `hb_subset_sets_t`：布局特性集合。 */
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

/** 一个可用的子集化器。 */
export interface FontSubsetter {
  /** 把字体裁到只剩 `text` 里用到的字符。 */
  subset(font: Uint8Array, text: string): Uint8Array;
}

/** 子集化失败时抛出的错误（带原因，便于诊断）。 */
export class FontSubsetError extends Error {
  constructor(message: string, readonly reason: "unsupported-format" | "empty-text" | "subset-failed") {
    super(message);
    this.name = "FontSubsetError";
  }
}

/**
 * sfnt（TrueType / OpenType）的文件头。
 *
 * 只有 sfnt 能直接喂给 harfbuzz：woff / woff2 是压缩格式，
 * 要先解压（`fontverter` 那一层）才能裁字形——本模块不做那一步，
 * 遇到压缩格式就明确报错，而不是悄悄返回原字体。
 */
export function isSfntFont(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  // 0x00010000 = TrueType；"OTTO" = CFF OpenType；"true" = 老的 TrueType 标签。
  return (
    bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00
    || bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f
    || bytes[0] === 0x74 && bytes[1] === 0x72 && bytes[2] === 0x75 && bytes[3] === 0x65
  );
}

/**
 * 实例化 wasm，得到子集化器。
 *
 * wasm 字节由调用方注入：浏览器端是 fetch 来的 `?url` 资源，
 * Node 端是 fs 读出来的文件——核心不关心它从哪来。
 */
export async function instantiateFontSubsetter(wasm: ArrayBuffer | Uint8Array): Promise<FontSubsetter> {
  const runtime = (globalThis as { WebAssembly?: WasmGlobal }).WebAssembly;
  if (!runtime) throw new Error("当前环境没有 WebAssembly，无法做字体子集化");
  const { instance } = await runtime.instantiate(wasm);
  const exports = instance.exports as unknown as SubsetWasmExports;
  exports._initialize();
  return createFontSubsetter(exports);
}

/** 用已经实例化好的 wasm 导出创建一个子集化器（便于测试与复用实例）。 */
export function createFontSubsetter(exports: SubsetWasmExports): FontSubsetter {
  return {
    subset(font: Uint8Array, text: string): Uint8Array {
      if (!isSfntFont(font)) {
        throw new FontSubsetError("只有 TrueType / OpenType（sfnt）能直接子集化，woff / woff2 需要先解压", "unsupported-format");
      }
      const characters = Array.from(new Set(Array.from(text, character => character.codePointAt(0) ?? 0)));
      if (!characters.length) {
        throw new FontSubsetError("没有要保留的字符，无法子集化", "empty-text");
      }

      // wasm 内存会在子集化过程中增长，之前拿到的 typed array 视图会失效——
      // 所以每次用都重新取一份（与 subset-font 的处理一致）。
      const heap = (): Uint8Array => new Uint8Array(exports.memory.buffer);

      const input = exports.hb_subset_input_create_or_fail();
      if (input === 0) throw new FontSubsetError("hb_subset_input_create_or_fail 返回 0", "subset-failed");
      try {
        // 保留全部布局特性（等价于 --layout-features=*）：
        // 清空集合再取反 = 集合里有全部特性。
        const layoutFeatures = exports.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
        exports.hb_set_clear(layoutFeatures);
        exports.hb_set_invert(layoutFeatures);

        const unicodes = exports.hb_subset_input_unicode_set(input);
        exports.hb_set_clear(unicodes);
        for (const codePoint of characters) exports.hb_set_add(unicodes, codePoint);

        const fontPointer = exports.malloc(font.byteLength);
        heap().set(font, fontPointer);
        const blob = exports.hb_blob_create(fontPointer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
        const face = exports.hb_face_create(blob, 0);
        exports.hb_blob_destroy(blob);

        let subset = 0;
        try {
          subset = exports.hb_subset_or_fail(face, input);
          if (subset === 0) throw new FontSubsetError("hb_subset_or_fail 返回 0，字体可能已损坏", "subset-failed");
          const result = exports.hb_face_reference_blob(subset);
          const offset = exports.hb_blob_get_data(result, 0);
          const length = exports.hb_blob_get_length(result);
          if (!length) throw new FontSubsetError("子集化结果是空的", "subset-failed");
          const bytes = heap().slice(offset, offset + length);
          exports.hb_blob_destroy(result);
          return bytes;
        } finally {
          if (subset) exports.hb_face_destroy(subset);
          exports.hb_face_destroy(face);
          exports.free(fontPointer);
        }
      } finally {
        exports.hb_subset_input_destroy(input);
      }
    },
  };
}
