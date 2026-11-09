/**
 * 零依赖 ZIP 写入（store 模式，不压缩）。
 *
 * 资源包对外分发需要一个压缩包，而浏览器端不能直接「下载一个目录」。
 * 这里自己写 ZIP：条目用 store（不压缩），几十行代码，没有新依赖。
 *
 * 为什么不用压缩：包里的主要内容是 PNG / JPEG / WOFF2——本来就是压缩过的
 * 格式，再压一遍几乎不省，而 deflate 要引入压缩器实现与异步流。
 *
 * 时间戳固定在 1980-01-01：同样的输入必须产出同样的字节，否则回归测试
 * 没法比对，用户也会拿到一个每次都不同的包。
 */

/** ZIP 里的一个条目。 */
export interface ZipEntry {
  /** 包内路径（用 `/` 分隔）。 */
  path: string;
  bytes: Uint8Array;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** 通用位标志：bit 11 = 文件名是 UTF-8。 */
const FLAG_UTF8_NAMES = 0x0800;

/** 固定时间戳（1980-01-01 00:00:00），让产物可复现。 */
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** CRC-32 表（多项式 0xedb88320）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32（ZIP 用的那个，不是 Adler-32）。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 把若干文件打成一个 ZIP。
 *
 * 条目按给定顺序写入——不改顺序，方便测试与人工比对。
 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_HEADER_SIGNATURE, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, FLAG_UTF8_NAMES, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, DOS_TIME, true);
    localView.setUint16(12, DOS_DATE, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, CENTRAL_HEADER_SIGNATURE, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, 20, true);
    headerView.setUint16(8, FLAG_UTF8_NAMES, true);
    headerView.setUint16(10, 0, true);
    headerView.setUint16(12, DOS_TIME, true);
    headerView.setUint16(14, DOS_DATE, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, entry.bytes.length, true);
    headerView.setUint32(24, entry.bytes.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true);
    headerView.setUint16(32, 0, true);
    headerView.setUint16(34, 0, true);
    headerView.setUint16(36, 0, true);
    headerView.setUint32(38, 0, true);
    headerView.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, entry.bytes);
    central.push(header);
    offset += local.length + entry.bytes.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  const total = offset + centralSize + end.length;
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  for (const part of central) {
    result.set(part, cursor);
    cursor += part.length;
  }
  result.set(end, cursor);
  return result;
}
