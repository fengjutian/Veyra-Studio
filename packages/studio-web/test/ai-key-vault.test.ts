import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_KEY_VAULT_STORAGE_KEY,
  clearStoredVault,
  hasStoredVault,
  openKeyRing,
  readStoredVault,
  sealKeyRing,
  type VaultStorage,
} from "../src/ai-key-vault";

function memoryStorage(): VaultStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: key => { map.delete(key); },
  };
}

test("加密后磁盘上只有密文，没有明文密钥", async () => {
  const storage = memoryStorage();
  await sealKeyRing({ keys: ["sk-secret-one", "sk-secret-two"], activeIndex: 1 }, "口令我", storage);
  const raw = storage.getItem(AI_KEY_VAULT_STORAGE_KEY) ?? "";
  assert.ok(raw.length > 0, "没有写进磁盘");
  assert.doesNotMatch(raw, /sk-secret-one/);
  assert.doesNotMatch(raw, /sk-secret-two/);
  assert.doesNotMatch(raw, /口令我/);
  // 记录里要写明用的什么算法与派生方式，将来能认出来。
  const vault = readStoredVault(storage);
  assert.equal(vault?.algorithm, "AES-GCM");
  assert.equal(vault?.kdf, "PBKDF2-SHA256");
  assert.ok((vault?.iterations ?? 0) >= 100_000, "迭代次数太少");
});

test("口令对了能解开，密钥环原样回来", async () => {
  const storage = memoryStorage();
  await sealKeyRing({ keys: ["sk-a", "sk-b"], activeIndex: 1 }, "口令", storage);
  const vault = readStoredVault(storage)!;
  const ring = await openKeyRing(vault, "口令");
  assert.deepEqual(ring, { keys: ["sk-a", "sk-b"], activeIndex: 1 });
});

test("口令不对解不开（不会给出半截数据）", async () => {
  const storage = memoryStorage();
  await sealKeyRing({ keys: ["sk-a"], activeIndex: 0 }, "对的", storage);
  const vault = readStoredVault(storage)!;
  assert.equal(await openKeyRing(vault, "错的"), undefined);
  assert.equal(await openKeyRing(vault, ""), undefined);
});

test("密文被改过也解不开", async () => {
  const storage = memoryStorage();
  await sealKeyRing({ keys: ["sk-a"], activeIndex: 0 }, "口令", storage);
  const vault = readStoredVault(storage)!;
  const bytes = base64Bytes(vault.ciphertext);
  bytes[0] = bytes[0]! ^ 0xff;
  const tampered = { ...vault, ciphertext: toBase64(bytes) };
  assert.equal(await openKeyRing(tampered, "口令"), undefined);
});

test("同一个密钥环加密两次，密文不同（盐与 IV 都是随机的）", async () => {
  const storage = memoryStorage();
  const first = await sealKeyRing({ keys: ["sk-a"], activeIndex: 0 }, "口令", storage);
  const second = await sealKeyRing({ keys: ["sk-a"], activeIndex: 0 }, "口令", storage);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
});

test("没有密钥或没有口令时不落盘", async () => {
  const storage = memoryStorage();
  await assert.rejects(() => sealKeyRing({ keys: [], activeIndex: 0 }, "口令", storage), /没有可保存的密钥/);
  await assert.rejects(() => sealKeyRing({ keys: ["sk-a"], activeIndex: 0 }, "", storage), /口令不能为空/);
  assert.equal(hasStoredVault(storage), false);
});

test("可以删掉磁盘上的密文", async () => {
  const storage = memoryStorage();
  await sealKeyRing({ keys: ["sk-a"], activeIndex: 0 }, "口令", storage);
  assert.equal(hasStoredVault(storage), true);
  clearStoredVault(storage);
  assert.equal(hasStoredVault(storage), false);
  assert.equal(readStoredVault(storage), undefined);
});

test("存储里是坏 JSON 时当作没有密文", () => {
  const storage = memoryStorage();
  storage.setItem(AI_KEY_VAULT_STORAGE_KEY, "{不是 JSON");
  assert.equal(readStoredVault(storage), undefined);
  assert.equal(hasStoredVault(storage), false);
});

// 小工具：测试里要把 base64 改掉一个字节。
function base64Bytes(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  const output = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let index = 0;
  for (let position = 0; position < clean.length; position += 4) {
    const first = alphabet.indexOf(clean[position]!);
    const second = alphabet.indexOf(clean[position + 1] ?? "A");
    const third = clean[position + 2] === "=" ? 0 : alphabet.indexOf(clean[position + 2] ?? "A");
    const fourth = clean[position + 3] === "=" ? 0 : alphabet.indexOf(clean[position + 3] ?? "A");
    output[index++] = (first << 2) | (second >> 4);
    if (index < output.length) output[index++] = ((second & 15) << 4) | (third >> 2);
    if (index < output.length) output[index++] = ((third & 3) << 6) | fourth;
  }
  return output;
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2];
    output += alphabet[((first & 0b11) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? "=" : alphabet[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? "=" : alphabet[third & 0b111111];
  }
  return output;
}
