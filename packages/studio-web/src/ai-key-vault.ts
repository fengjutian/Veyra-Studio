import { base64FromBytes, base64ToBytes } from "@ufira/design-export";

/**
 * 密钥落盘（口令加密）。
 *
 * ## 为什么要有这个
 *
 * 密钥原来只活在标签页的 `sessionStorage` 里：安全，但换个设备、换个标签页就得
 * 重填一遍——实际用起来等于「没有」。这里提供另一条路：**用口令加密后落盘**。
 *
 * ## 安全属性
 *
 * - 磁盘上只有**密文**：AES-GCM 加密，密钥由口令经 PBKDF2-SHA256 派生。
 * - **口令不落盘**，也不进 `localStorage`；关掉标签页后，磁盘上的密文对没有口令
 *   的人没有用。
 * - 口令错了就是解不开（GCM 会校验认证标签），不会「解出半截数据」。
 * - 密钥**仍然不进**设计文档、事务日志、导出文件——落盘只影响密钥自己。
 *
 * ## 为什么不做得更「方便」
 *
 * 「记住口令」等于把密钥明文放回磁盘，那就白加密了。所以每次开新标签页要输一次
 * 口令：这是有意的取舍。
 *
 * 用了浏览器原生的 Web Crypto（`crypto.subtle`），没有新增依赖；Node 里也有同一套
 * API，所以这套逻辑在测试里能跑真加解密，不是「假装加密」。
 */

/** 只用到这三个方法，方便在没有 DOM 的环境里测试。 */
export interface VaultStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const AI_KEY_VAULT_STORAGE_KEY = "studio:ai-key-vault";

/** 记录格式版本；以后换算法时老记录能被认出来。 */
export const VAULT_VERSION = 1;

/** PBKDF2 迭代次数。OWASP 对 PBKDF2-HMAC-SHA256 的建议是 600k（2023），210k 是
 * 兼顾浏览器响应速度的下限（一次性操作，慢几百毫秒可以接受）。 */
export const VAULT_ITERATIONS = 210_000;

export interface EncryptedKeyRing {
  version: number;
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  /** 盐（base64）。 */
  salt: string;
  /** 初始向量（base64）。 */
  iv: string;
  /** 密文（base64）。 */
  ciphertext: string;
}

export interface KeyRing {
  keys: string[];
  activeIndex: number;
}

/** 把密钥环加密后写进磁盘存储。 */
export async function sealKeyRing(
  ring: KeyRing,
  passphrase: string,
  storage?: VaultStorage,
): Promise<EncryptedKeyRing> {
  const keys = ring.keys.map(key => key.trim()).filter(Boolean);
  if (!keys.length) throw new Error("没有可保存的密钥");
  if (!passphrase) throw new Error("口令不能为空");
  const crypto = requireCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(crypto, passphrase, salt, VAULT_ITERATIONS);
  const payload = new TextEncoder().encode(JSON.stringify({
    keys,
    activeIndex: Math.min(Math.max(0, ring.activeIndex), keys.length - 1),
  }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload));
  const vault: EncryptedKeyRing = {
    version: VAULT_VERSION,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: VAULT_ITERATIONS,
    salt: base64FromBytes(salt),
    iv: base64FromBytes(iv),
    ciphertext: base64FromBytes(ciphertext),
  };
  resolveStorage(storage)?.setItem(AI_KEY_VAULT_STORAGE_KEY, JSON.stringify(vault));
  return vault;
}

/**
 * 解开磁盘上的密文。
 *
 * 口令不对（或密文被改坏）时返回 `undefined`——GCM 的认证标签会拒绝这两种情况，
 * 不会给出半截数据。
 */
export async function openKeyRing(vault: EncryptedKeyRing, passphrase: string): Promise<KeyRing | undefined> {
  if (!vault || vault.version !== VAULT_VERSION || vault.algorithm !== "AES-GCM") return undefined;
  if (!passphrase) return undefined;
  const crypto = requireCrypto();
  try {
    const salt = base64ToBytes(vault.salt);
    const iv = base64ToBytes(vault.iv);
    const key = await deriveKey(crypto, passphrase, salt, vault.iterations);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      base64ToBytes(vault.ciphertext),
    );
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext))) as { keys?: unknown; activeIndex?: unknown };
    const keys = Array.isArray(parsed.keys) ? parsed.keys.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
    if (!keys.length) return undefined;
    const activeIndex = typeof parsed.activeIndex === "number" && Number.isInteger(parsed.activeIndex) ? parsed.activeIndex : 0;
    return { keys, activeIndex: Math.min(Math.max(0, activeIndex), keys.length - 1) };
  } catch {
    return undefined;
  }
}

/** 磁盘上有没有存过密文。 */
export function hasStoredVault(storage?: VaultStorage): boolean {
  return Boolean(readStoredVault(storage));
}

/** 读出磁盘上的密文记录；没有或坏了就返回 undefined。 */
export function readStoredVault(storage?: VaultStorage): EncryptedKeyRing | undefined {
  const raw = resolveStorage(storage)?.getItem(AI_KEY_VAULT_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as EncryptedKeyRing;
    if (!parsed || typeof parsed.ciphertext !== "string" || typeof parsed.salt !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 删掉磁盘上的密文。 */
export function clearStoredVault(storage?: VaultStorage): void {
  resolveStorage(storage)?.removeItem(AI_KEY_VAULT_STORAGE_KEY);
}

/** 口令 → AES-GCM 密钥。 */
async function deriveKey(
  crypto: Crypto,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function requireCrypto(): Crypto {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) throw new Error("当前环境没有 Web Crypto，无法加密保存密钥");
  return crypto;
}

/** 默认写进 localStorage（磁盘）；没有 localStorage 时返回 undefined。 */
function resolveStorage(storage?: VaultStorage): VaultStorage | undefined {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: VaultStorage }).localStorage;
  } catch {
    return undefined;
  }
}
