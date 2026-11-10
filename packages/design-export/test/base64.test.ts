import assert from "node:assert/strict";
import test from "node:test";
import { base64FromBytes, base64ToBytes } from "../src/base64";

test("base64 编解码互为逆运算", () => {
  const original = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...base64ToBytes(base64FromBytes(original))], [...original]);
});

test("长度不是 3 的倍数时补齐正确", () => {
  for (const length of [1, 2, 3, 4, 5, 6, 7]) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = index * 17;
    assert.deepEqual([...base64ToBytes(base64FromBytes(bytes))], [...bytes], `长度 ${length} 往返不一致`);
  }
});

test("解码时忽略空白与换行", () => {
  const encoded = base64FromBytes(new Uint8Array([1, 2, 3, 4, 5, 6]));
  const wrapped = `${encoded.slice(0, 4)}\n${encoded.slice(4)}`;
  assert.deepEqual([...base64ToBytes(wrapped)], [1, 2, 3, 4, 5, 6]);
});

test("空输入解出空数组", () => {
  assert.equal(base64ToBytes("").length, 0);
});
