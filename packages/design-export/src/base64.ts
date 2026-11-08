/**
 * 纯 JS 的 base64 编码。
 *
 * 不依赖 `btoa` 或 Node 的 `Buffer`：同一个实现要能在浏览器工作台和 node 测试里
 * 得到逐字节一致的结果（`btoa` 对大数组会爆栈，`Buffer` 在浏览器里不存在）。
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 把字节编码成 base64（带 `=` 补齐）。 */
export function base64FromBytes(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : BASE64_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : BASE64_ALPHABET[third & 0b111111];
  }
  return output;
}
