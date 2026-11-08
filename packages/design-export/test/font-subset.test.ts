import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FontSubsetError, instantiateFontSubsetter, isSfntFont } from "../src/index";

/**
 * 字体子集化（HarfBuzz hb_subset）。
 *
 * 规格见 `docs/font-management.md`。
 *
 * 用的是 `harfbuzzjs` 包里的独立 `harfbuzz-subset.wasm`——wasm 字节在这里
 * 从文件系统读（Node 侧）；浏览器侧由 studio-web 的 font-subset-client 注入。
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "PressStart2P-Regular.ttf");

/** wasm 字节：Node 侧从 node_modules 读。 */
function wasmBytes(): Uint8Array {
  return new Uint8Array(readFileSync(require.resolve("harfbuzzjs/dist/harfbuzz-subset.wasm")));
}

/** 读出 sfnt 的表目录。 */
function sfntTables(bytes: Uint8Array): Map<string, { offset: number; length: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index += 1) {
    const base = 12 + index * 16;
    const tag = String.fromCharCode(bytes[base]!, bytes[base + 1]!, bytes[base + 2]!, bytes[base + 3]!);
    tables.set(tag, { offset: view.getUint32(base + 8), length: view.getUint32(base + 12) });
  }
  return tables;
}

/** 解析 cmap，收集字体里还留着的码点。 */
function cmapCodePoints(bytes: Uint8Array): number[] {
  const tables = sfntTables(bytes);
  const cmap = tables.get("cmap");
  assert.ok(cmap, "子集字体里应该有 cmap 表");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const subtableCount = view.getUint16(cmap.offset + 2);
  const candidates: Array<{ offset: number; format: number }> = [];
  for (let index = 0; index < subtableCount; index += 1) {
    const base = cmap.offset + 4 + index * 8;
    const platformId = view.getUint16(base);
    const encodingId = view.getUint16(base + 2);
    const offset = view.getUint32(base + 4);
    const format = view.getUint16(cmap.offset + offset);
    // 优先全字符集（platform 3 / encoding 10），否则取 BMP（platform 3 / encoding 1）。
    if (platformId === 3 && encodingId === 10) candidates.push({ offset: cmap.offset + offset, format });
    else if (platformId === 3 && encodingId === 1 && !candidates.some(item => item.format === 12)) {
      candidates.push({ offset: cmap.offset + offset, format });
    }
  }
  const chosen = candidates.find(item => item.format === 12) ?? candidates[0];
  assert.ok(chosen, "cmap 里应该有可解析的子表");

  const points: number[] = [];
  if (chosen.format === 4) {
    const segCount = view.getUint16(chosen.offset + 6) / 2;
    const endCodes = chosen.offset + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let segment = 0; segment < segCount; segment += 1) {
      const end = view.getUint16(endCodes + segment * 2);
      const start = view.getUint16(startCodes + segment * 2);
      const delta = view.getInt16(idDeltas + segment * 2);
      const rangeOffset = view.getUint16(idRangeOffsets + segment * 2);
      if (start === 0xffff) continue;
      for (let code = start; code <= end && code !== 0x10000; code += 1) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const glyphIndexAddress = idRangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
          glyph = view.getUint16(glyphIndexAddress);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) points.push(code);
      }
    }
  } else {
    const groups = view.getUint32(chosen.offset + 12);
    for (let group = 0; group < groups; group += 1) {
      const base = chosen.offset + 16 + group * 12;
      const start = view.getUint32(base);
      const end = view.getUint32(base + 4);
      const startGlyph = view.getUint32(base + 8);
      for (let code = start; code <= end; code += 1) {
        if (startGlyph + (code - start) !== 0) points.push(code);
      }
    }
  }
  return points;
}

test("detects the sfnt font format", () => {
  const bytes = new Uint8Array(readFileSync(fixture));
  assert.equal(isSfntFont(bytes), true);
  // woff / woff2 的文件头不是 sfnt。
  assert.equal(isSfntFont(new Uint8Array([0x77, 0x4f, 0x46, 0x32])), false);
  assert.equal(isSfntFont(new Uint8Array([0x4f, 0x54, 0x54, 0x4f])), true);
});

test("cuts the font down to the characters that are used", async () => {
  const subsetter = await instantiateFontSubsetter(wasmBytes());
  const original = new Uint8Array(readFileSync(fixture));
  const subset = subsetter.subset(original, "abc");

  // 体积必须明显变小：原字体 118,204 字节。
  assert.ok(subset.byteLength < original.byteLength / 4, `子集后是 ${subset.byteLength} 字节，仍然太大`);
  assert.ok(subset.byteLength > 0);

  // 输出仍是合法的 sfnt 字体。
  assert.equal(isSfntFont(subset), true);

  // cmap 里只剩用到的字符。
  const points = cmapCodePoints(subset);
  assert.deepEqual([...points].sort((a, b) => a - b), [97, 98, 99]);
});

test("keeps the character that is asked for", async () => {
  const subsetter = await instantiateFontSubsetter(wasmBytes());
  const original = new Uint8Array(readFileSync(fixture));
  const subset = subsetter.subset(original, "Hi!");
  const points = cmapCodePoints(subset);
  assert.deepEqual([...points].sort((a, b) => a - b), [33, 72, 105]);
});

test("refuses a compressed font format", async () => {
  const subsetter = await instantiateFontSubsetter(wasmBytes());
  const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
  assert.throws(() => subsetter.subset(woff2, "a"), (error: unknown) => {
    assert.ok(error instanceof FontSubsetError);
    assert.equal(error.reason, "unsupported-format");
    return true;
  });
});

test("refuses an empty character set", async () => {
  const subsetter = await instantiateFontSubsetter(wasmBytes());
  const original = new Uint8Array(readFileSync(fixture));
  assert.throws(() => subsetter.subset(original, ""), (error: unknown) => {
    assert.ok(error instanceof FontSubsetError);
    assert.equal(error.reason, "empty-text");
    return true;
  });
});
