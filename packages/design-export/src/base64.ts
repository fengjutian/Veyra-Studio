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

/**
 * 把 base64 解回字节。
 *
 * 与 {@link base64FromBytes} 互为逆运算：同一个实现要能在浏览器工作台和 node
 * 测试里得到逐字节一致的结果（`atob` 对二进制字符串要额外处理，`Buffer` 在浏览器
 * 里不存在）。
 *
 * 解码时忽略空白与换行——base64 常被塞进 JSON 或 PEM 之类的文本里。
 */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, "");
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, "=");
  const padding = (/\=+$/.exec(padded)?.[0].length ?? 0);
  const output = new Uint8Array(Math.max(0, (padded.length / 4) * 3 - padding));
  let index = 0;
  for (let position = 0; position < padded.length; position += 4) {
    const first = BASE64_ALPHABET.indexOf(padded[position]!);
    const second = BASE64_ALPHABET.indexOf(padded[position + 1] ?? "A");
    const third = padded[position + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(padded[position + 2] ?? "A");
    const fourth = padded[position + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(padded[position + 3] ?? "A");
    if (first < 0 || second < 0) break;
    output[index++] = (first << 2) | (second >> 4);
    if (index < output.length) output[index++] = ((second & 15) << 4) | (third >> 2);
    if (index < output.length) output[index++] = ((third & 3) << 6) | fourth;
  }
  return output;
}
