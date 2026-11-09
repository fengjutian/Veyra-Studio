import assert from "node:assert/strict";
import test from "node:test";
import { crc32, createZip } from "../src/zip";

/**
 * 零依赖 ZIP 写入器。
 *
 * 测试里自己把 ZIP 读回来：结构对不对（本地头、中央目录、CRC、偏移），
 * 不能只靠「写完没报错」。
 */

/** 从 ZIP 里读回来的一个条目。 */
interface ReadEntry {
  path: string;
  bytes: Uint8Array;
  crc: number;
}

/** 最小 ZIP 读取器：只支持 store（不压缩），够用来验自己写的包。 */
function readZip(archive: Uint8Array): ReadEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const decoder = new TextDecoder();

  // 结尾的中央目录记录（EOCD）固定在最后 22 字节（没有注释时）。
  const end = archive.byteLength - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, "结尾应该有中央目录结束记录");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);

  const entries: ReadEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014b50, "中央目录条目签名不对");
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const path = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));

    // 本地文件头：文件名长度可能与中央目录里的不同，必须各自读。
    assert.equal(view.getUint32(localOffset, true), 0x04034b50, "本地文件头签名不对");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const bytes = archive.subarray(dataStart, dataStart + size);

    entries.push({ path, bytes: new Uint8Array(bytes), crc });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("computes the standard crc-32", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array([])), 0);
});

test("writes a zip that can be read back", () => {
  const first = new TextEncoder().encode("<!doctype html><title>Demo</title>");
  const second = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const archive = createZip([
    { path: "index.html", bytes: first },
    { path: "assets/pixel.png", bytes: second },
  ]);

  const entries = readZip(archive);
  assert.deepEqual(entries.map(entry => entry.path), ["index.html", "assets/pixel.png"]);
  assert.deepEqual(Array.from(entries[0]!.bytes), Array.from(first));
  assert.deepEqual(Array.from(entries[1]!.bytes), Array.from(second));
  assert.equal(entries[0]!.crc, crc32(first));
  assert.equal(entries[1]!.crc, crc32(second));
});

test("produces the same bytes for the same input", () => {
  const entries = [{ path: "index.html", bytes: new TextEncoder().encode("hello") }];
  assert.deepEqual(Array.from(createZip(entries)), Array.from(createZip(entries)));
});

test("handles an empty archive", () => {
  const archive = createZip([]);
  assert.deepEqual(readZip(archive), []);
});

test("keeps non-ascii names readable", () => {
  const archive = createZip([{ path: "资源/图.png", bytes: new Uint8Array([1, 2]) }]);
  assert.deepEqual(readZip(archive).map(entry => entry.path), ["资源/图.png"]);
});
