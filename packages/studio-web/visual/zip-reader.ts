/**
 * 最小 ZIP 读取器（只支持 store，不压缩）。
 *
 * 探针用它把下载下来的包读回来：光看「文件生成了」不算验证，得确认里面的
 * 条目名、字节和 CRC 都对。
 *
 * 注意：这是**独立于写入器**的第二份实现——写入器和读取器共用一份代码的话，
 * 两边犯同一个错就永远测不出来。
 */

export interface ReadZipEntry {
  path: string;
  bytes: Uint8Array;
  crc: number;
}

export function readZip(archive: Uint8Array): ReadZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();

  const end = archive.byteLength - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("ZIP 结尾没有中央目录结束记录");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);

  const entries: ReadZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("中央目录条目签名不对");
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("本地文件头签名不对");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const bytes = new Uint8Array(archive.subarray(dataStart, dataStart + size));

    entries.push({ path, bytes, crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
