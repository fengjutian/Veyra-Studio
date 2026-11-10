/**
 * 最小 TrueType（sfnt）解析器。
 *
 * 矢量 PDF 要内嵌字体子集，就得知道两件事：
 *
 * 1. **字形映射**：Unicode → 字形编号（GID）。文本在 PDF 里以 GID 写出，
 *    读者靠 `ToUnicode` CMap 把它还原成可搜索、可复制的文字。
 * 2. **字形宽度**（advance width）：排版时要按真实宽度算居中与右对齐的落点，
 *    否则文字会偏。宽度还要写进 PDF 的 `/W` 数组，读者才知道每个字多宽。
 *
 * 这里只读表目录与 `head` / `maxp` / `hhea` / `hmtx` / `cmap` / `post` /
 * `OS/2`——不解析 `glyf`（字形轮廓由 PDF 读者直接从内嵌字体里读）。
 *
 * 规格见 `docs/vector-pdf.md`。
 */

/** 一个解析出来的 sfnt 字体。 */
export interface SfntFont {
  /** 每 em 的单位数（通常 1000 或 2048）。 */
  unitsPerEm: number;
  /** 字形总数。 */
  numGlyphs: number;
  /** 上伸部（字体单位），基线之上的高度。 */
  ascent: number;
  /** 下伸部（字体单位，通常是负数）。 */
  descent: number;
  /** 字体外框（字体单位）。 */
  bbox: { xMin: number; yMin: number; xMax: number; yMax: number };
  /** 倾斜角（度）。 */
  italicAngle: number;
  /** 大写字母高度（字体单位）；字体没给时按 0.7em 估。 */
  capHeight: number;
  /** 是否是 CFF（PostScript 轮廓）字体。 */
  isCff: boolean;
  /** Unicode 码点 → 字形编号；没有对应字形时返回 0（`.notdef`）。 */
  glyphIdFor(codePoint: number): number;
  /** 字形的前进宽度（字体单位）。 */
  advanceWidth(glyphId: number): number;
}

/** sfnt 里的一张表。 */
interface TableRecord {
  offset: number;
  length: number;
}

class Reader {
  constructor(private readonly bytes: Uint8Array) {}

  u8(offset: number): number {
    return this.bytes[offset] ?? 0;
  }

  u16(offset: number): number {
    return (this.u8(offset) << 8) | this.u8(offset + 1);
  }

  i16(offset: number): number {
    const value = this.u16(offset);
    return value > 0x7fff ? value - 0x10000 : value;
  }

  u32(offset: number): number {
    return ((this.u8(offset) << 24) | (this.u8(offset + 1) << 16) | (this.u8(offset + 2) << 8) | this.u8(offset + 3)) >>> 0;
  }

  /** 有符号 32 位（`post` 表的倾斜角是 16.16 定点数）。 */
  i32(offset: number): number {
    return this.u32(offset) | 0;
  }
}

/** 解析失败时抛出的错误（带原因，便于诊断）。 */
export class SfntParseError extends Error {
  constructor(message: string, readonly reason: "not-sfnt" | "missing-table" | "bad-cmap") {
    super(message);
    this.name = "SfntParseError";
  }
}

/** 读表目录。 */
function readTables(bytes: Uint8Array): Map<string, TableRecord> {
  const reader = new Reader(bytes);
  const tables = new Map<string, TableRecord>();
  const numTables = reader.u16(4);
  for (let index = 0; index < numTables; index += 1) {
    const base = 12 + index * 16;
    const tag = String.fromCharCode(reader.u8(base), reader.u8(base + 1), reader.u8(base + 2), reader.u8(base + 3));
    tables.set(tag, { offset: reader.u32(base + 8), length: reader.u32(base + 12) });
  }
  return tables;
}

/** 从 cmap 里挑一张子表：优先 (3,10) 的 format 12，其次 (3,1) 的 format 4，最后 (0,*)。 */
function pickCmapSubtable(reader: Reader, tables: Map<string, TableRecord>): number {
  const cmap = tables.get("cmap");
  if (!cmap) throw new SfntParseError("字体没有 cmap 表", "missing-table");
  const base = cmap.offset;
  const numTables = reader.u16(base + 2);
  let best = -1;
  let bestScore = -1;
  for (let index = 0; index < numTables; index += 1) {
    const record = base + 4 + index * 8;
    const platformId = reader.u16(record);
    const encodingId = reader.u16(record + 2);
    const offset = base + reader.u32(record + 4);
    const format = reader.u16(offset);
    // 打分：格式能解析 + 平台优先 Unicode。
    let score = -1;
    if (format === 12) score = platformId === 3 && encodingId === 10 ? 100 : 90;
    else if (format === 4) score = platformId === 3 && encodingId === 1 ? 80 : platformId === 0 ? 70 : 60;
    else if (format === 6) score = 50;
    else if (format === 0) score = 40;
    if (score > bestScore) {
      bestScore = score;
      best = offset;
    }
  }
  if (best < 0) throw new SfntParseError("cmap 里没有可用的子表", "bad-cmap");
  return best;
}

/** 解析一张 cmap 子表，返回「码点 → GID」的查表函数。 */
function parseCmap(reader: Reader, offset: number): (codePoint: number) => number {
  const format = reader.u16(offset);
  if (format === 0) {
    return (codePoint: number) => (codePoint >= 0 && codePoint < 256 ? reader.u8(offset + 6 + codePoint) : 0);
  }
  if (format === 4) {
    const segCount = reader.u16(offset + 6) / 2;
    const endBase = offset + 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    return (codePoint: number) => {
      if (codePoint > 0xffff) return 0;
      for (let segment = 0; segment < segCount; segment += 1) {
        const end = reader.u16(endBase + segment * 2);
        if (codePoint > end) continue;
        const start = reader.u16(startBase + segment * 2);
        if (codePoint < start) return 0;
        const delta = reader.i16(deltaBase + segment * 2);
        const rangeOffset = reader.u16(rangeBase + segment * 2);
        if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
        const glyphIndexAddress = rangeBase + segment * 2 + rangeOffset + (codePoint - start) * 2;
        const glyph = reader.u16(glyphIndexAddress);
        if (glyph === 0) return 0;
        return (glyph + delta) & 0xffff;
      }
      return 0;
    };
  }
  if (format === 6) {
    const first = reader.u16(offset + 6);
    const count = reader.u16(offset + 8);
    return (codePoint: number) => {
      const index = codePoint - first;
      if (index < 0 || index >= count) return 0;
      return reader.u16(offset + 10 + index * 2);
    };
  }
  if (format === 12) {
    const groups = reader.u32(offset + 12);
    return (codePoint: number) => {
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const group = offset + 16 + middle * 12;
        const start = reader.u32(group);
        const end = reader.u32(group + 4);
        if (codePoint < start) high = middle - 1;
        else if (codePoint > end) low = middle + 1;
        else return reader.u32(group + 8) + (codePoint - start);
      }
      return 0;
    };
  }
  throw new SfntParseError(`不支持的 cmap 格式 ${format}`, "bad-cmap");
}

/**
 * 解析一个 sfnt 字体。
 *
 * CFF（OTTO）字体也能解析出映射与宽度，但 PDF 里的嵌入方式不同
 * （`CIDFontType0` + `FontFile3`），本模块只负责数据，嵌入由调用方决定。
 */
export function parseSfnt(bytes: Uint8Array): SfntFont {
  if (bytes.byteLength < 12) throw new SfntParseError("字体文件太短", "not-sfnt");
  const reader = new Reader(bytes);
  const tables = readTables(bytes);
  const head = tables.get("head");
  const maxp = tables.get("maxp");
  const hhea = tables.get("hhea");
  const hmtx = tables.get("hmtx");
  if (!head || !maxp || !hhea || !hmtx) throw new SfntParseError("字体缺少必需表（head/maxp/hhea/hmtx）", "missing-table");

  const unitsPerEm = reader.u16(head.offset + 18) || 1000;
  const numGlyphs = reader.u16(maxp.offset + 4);
  const ascent = reader.i16(hhea.offset + 4);
  const descent = reader.i16(hhea.offset + 6);
  const numberOfHMetrics = reader.u16(hhea.offset + 34);

  const bbox = {
    xMin: reader.i16(head.offset + 36),
    yMin: reader.i16(head.offset + 38),
    xMax: reader.i16(head.offset + 40),
    yMax: reader.i16(head.offset + 42),
  };

  const post = tables.get("post");
  const italicAngle = post ? reader.i32(post.offset + 4) / 65536 : 0;
  const os2 = tables.get("OS/2");
  const capHeight = os2 ? reader.i16(os2.offset + 88) || Math.round(unitsPerEm * 0.7) : Math.round(unitsPerEm * 0.7);

  const cmapOffset = pickCmapSubtable(reader, tables);
  const glyphIdFor = parseCmap(reader, cmapOffset);

  const advanceWidth = (glyphId: number): number => {
    if (glyphId < 0 || glyphId >= numGlyphs) return 0;
    const index = Math.min(glyphId, numberOfHMetrics - 1);
    return reader.u16(hmtx.offset + index * 4);
  };

  const isCff = String.fromCharCode(reader.u8(0), reader.u8(1), reader.u8(2), reader.u8(3)) === "OTTO";

  return { unitsPerEm, numGlyphs, ascent, descent, bbox, italicAngle, capHeight, isCff, glyphIdFor, advanceWidth };
}

/** 判断是不是 sfnt（TrueType / OpenType）容器。 */
export function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const tag = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return tag === "\u0000\u0001\u0000\u0000" || tag === "OTTO" || tag === "true";
}
