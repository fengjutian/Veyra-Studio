import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSfnt, SfntParseError } from "../src/truetype";

/** 最小 sfnt 解析器：字形映射与前进宽度。 */

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = join(here, "fixtures", "PressStart2P-Regular.ttf");
const bytes = new Uint8Array(readFileSync(fixture));

test("sfnt：读出头、maxp、hhea 的基本量", () => {
  const font = parseSfnt(bytes);
  assert.equal(font.unitsPerEm, 1000);
  assert.ok(font.numGlyphs > 0);
  assert.ok(font.ascent > 0);
  // 下伸部可能是 0（像素字体没有下伸部），但不能是正数。
  assert.ok(font.descent <= 0);
  assert.equal(font.isCff, false);
});

test("sfnt：字符能查到字形编号", () => {
  const font = parseSfnt(bytes);
  const a = font.glyphIdFor("a".codePointAt(0)!);
  const b = font.glyphIdFor("b".codePointAt(0)!);
  assert.ok(a > 0, "字母 a 应该有字形");
  assert.ok(b > 0, "字母 b 应该有字形");
  assert.notEqual(a, b);
  // 不存在的字符落到 .notdef（0）。
  assert.equal(font.glyphIdFor(0x4e2d), 0);
});

test("sfnt：前进宽度能读到，且与字形对应", () => {
  const font = parseSfnt(bytes);
  const width = font.advanceWidth(font.glyphIdFor("a".codePointAt(0)!));
  assert.ok(width > 0);
  // 超出字形总数的编号宽度为 0。
  assert.equal(font.advanceWidth(font.numGlyphs + 10), 0);
});

test("sfnt：不是 sfnt 的文件明确报错", () => {
  assert.throws(() => parseSfnt(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), (error: unknown) => {
    assert.ok(error instanceof SfntParseError);
    return true;
  });
});
