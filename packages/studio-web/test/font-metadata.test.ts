import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFontMetadata } from "../src/font-metadata";

/**
 * 字体文件里的族名与字重。
 *
 * 规格见 `docs/font-inline.md`。
 */

const here = dirname(fileURLToPath(import.meta.url));
// 测试字体与 design-export 的导出测试共用同一份（OFL-1.1，Press Start 2P）。
const FONT_BYTES = new Uint8Array(readFileSync(join(here, "..", "..", "design-export", "test", "fixtures", "PressStart2P-Regular.ttf")));

test("reads the family name and the weight out of the font file", async () => {
  const metadata = await readFontMetadata(FONT_BYTES, "font/ttf");
  assert.equal(metadata?.family, "Press Start 2P");
  assert.equal(metadata?.weight, 400);
  assert.equal(metadata?.style, undefined);
});

test("returns nothing for bytes that are not a font", async () => {
  const metadata = await readFontMetadata(new Uint8Array([1, 2, 3, 4]), "font/ttf");
  assert.equal(metadata, undefined);
});

test("returns nothing for a mime type it cannot read", async () => {
  const metadata = await readFontMetadata(FONT_BYTES, "application/octet-stream");
  assert.equal(metadata, undefined);
});

test("returns nothing for an empty file", async () => {
  const metadata = await readFontMetadata(new Uint8Array([]), "font/ttf");
  assert.equal(metadata, undefined);
});
