/**
 * 磁盘备份的加密信封。
 *
 * 备份文件落在用户选的目录里，信任边界原本是「用户自己的磁盘」——但目录可能
 * 在网盘里、可能在别人能读到的共享盘上、也可能被同步软件上传。加密把这条边界
 * 收到「只有知道密码的人能读」。
 *
 * 方案：
 *
 * - **PBKDF2-HMAC-SHA256** 从密码派生 AES-GCM-256 密钥（每次备份用新 salt）；
 * - **AES-GCM** 加密整个文档（同时提供完整性校验）；
 * - 密码**不落盘**：不进 localStorage / IndexedDB / 文档 / 备份文件。
 *   文件里只有 salt、迭代次数、IV 与密文——忘记密码就是永久丢失，
 *   这是刻意的取舍（没有服务端就没有找回通道）。
 *
 * 信封本身是 JSON（不是二进制），所以备份目录里仍然是可读的一堆 `.json`，
 * 拖回编辑器时靠内容判断是不是加密的，不需要按扩展名分家。
 */

/** 信封格式标识。文件里出现这个字段才当作加密备份处理。 */
export const ENCRYPTED_BACKUP_FORMAT = "ufira-encrypted-backup";

/** 信封格式版本；不认识的高版本一律拒绝（不猜）。 */
export const ENCRYPTED_BACKUP_VERSION = 1;

/**
 * PBKDF2 迭代次数。
 *
 * 210000 是在「浏览器里点一次按钮要能接受」与「离线爆破不能太便宜」之间的
 * 取舍：一次派生在桌面浏览器约 0.1–0.3 秒，离线爆破成本被拉长两个数量级。
 * 迭代次数写进信封，将来调高不会让旧文件解不开。
 */
export const BACKUP_KDF_ITERATIONS = 210_000;

/** 每个文件的新 salt 长度（字节）。 */
const SALT_BYTES = 16;

/** AES-GCM 的 IV 长度（字节）。GCM 推荐 96 位。 */
const IV_BYTES = 12;

/** 加密信封。 */
export interface EncryptedBackupEnvelope {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  version: number;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    /** base64 */
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    /** base64 */
    iv: string;
  };
  /** base64 的密文（含 GCM 的 auth tag） */
  data: string;
}

/**
 * 密码错误（或者文件被改坏）。
 *
 * AES-GCM 的认证标签分不清「密码不对」和「密文损坏」——两者都会让解密抛错。
 * 文案必须同时覆盖两种可能，不能只说「密码错误」，否则文件损坏时用户会一直
 * 以为自己记错了密码。
 */
export class BackupDecryptError extends Error {
  constructor(message = "密码不正确，或备份文件已损坏") {
    super(message);
    this.name = "BackupDecryptError";
  }
}

/** 当前环境能不能加密（浏览器与 Node 18+ 都有 WebCrypto）。 */
export function supportsBackupEncryption(): boolean {
  const subtle = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
  return typeof subtle === "object" && subtle !== null;
}

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 WebCrypto，无法加密备份");
  return subtle;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source?.getRandomValues) throw new Error("当前环境不支持安全随机数，无法加密备份");
  source.getRandomValues(bytes);
  return bytes;
}

/** bytes → base64（分块，避免大数组 spread 爆栈）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** base64 → bytes。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * 文本是不是加密信封。
 *
 * 只看结构不看内容：能解析成对象、且 `format` 对得上才算。故意不做「值像不像
 * 密文」的猜测——认错了会把明文备份当密文，然后报一个毫无意义的密码错误。
 */
export function isEncryptedBackupText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { format?: unknown };
    return parsed?.format === ENCRYPTED_BACKUP_FORMAT;
  } catch {
    return false;
  }
}

/**
 * 解析信封（严格）。
 *
 * 字段缺失或版本不认识就抛错——**不猜**：将来若引入新版本，认错会写出
 * 「解密成功但内容是乱码」的结果，比明确报错难查得多。
 */
export function parseEnvelope(text: string): EncryptedBackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupDecryptError("备份文件不是有效的 JSON");
  }
  const envelope = parsed as Partial<EncryptedBackupEnvelope>;
  if (!envelope || envelope.format !== ENCRYPTED_BACKUP_FORMAT) {
    throw new BackupDecryptError("这不是加密备份文件");
  }
  if (envelope.version !== ENCRYPTED_BACKUP_VERSION) {
    throw new BackupDecryptError(`不支持的加密备份版本：${String(envelope.version)}`);
  }
  const kdf = envelope.kdf;
  const cipher = envelope.cipher;
  if (!kdf || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || typeof kdf.iterations !== "number" || typeof kdf.salt !== "string") {
    throw new BackupDecryptError("加密备份的密钥派生参数不可读");
  }
  if (!cipher || cipher.name !== "AES-GCM" || typeof cipher.iv !== "string" || typeof envelope.data !== "string") {
    throw new BackupDecryptError("加密备份的密文参数不可读");
  }
  return envelope as EncryptedBackupEnvelope;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = subtleCrypto();
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * 加密一段文本，得到信封的 JSON 文本。
 *
 * 每次都用新 salt 与新 IV——复用 IV 会让 GCM 的安全性归零。
 */
export async function encryptBackupText(plain: string, password: string): Promise<string> {
  if (!password) throw new Error("加密备份需要密码");
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(password, salt, BACKUP_KDF_ITERATIONS);
  const cipherBytes = new Uint8Array(await subtleCrypto().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  const envelope: EncryptedBackupEnvelope = {
    format: ENCRYPTED_BACKUP_FORMAT,
    version: ENCRYPTED_BACKUP_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: BACKUP_KDF_ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
    data: bytesToBase64(cipherBytes),
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * 解密一段信封文本。
 *
 * 密码不对时 GCM 认证失败 → 统一抛 `BackupDecryptError`，不把底层
 * `OperationError` 泄漏给界面。
 */
export async function decryptBackupText(text: string, password: string): Promise<string> {
  const envelope = parseEnvelope(text);
  const salt = base64ToBytes(envelope.kdf.salt);
  const iv = base64ToBytes(envelope.cipher.iv);
  const data = base64ToBytes(envelope.data);
  const key = await deriveKey(password, salt, envelope.kdf.iterations);
  try {
    const plain = await subtleCrypto().decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      data as unknown as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new BackupDecryptError();
  }
}

/**
 * 读一份备份文件的原文。
 *
 * 明文直接返回；加密的必须给密码。**加密但没给密码**要报出明确原因，
 * 不能落到 `JSON.parse` 的 "Unexpected token" 上——那让人以为文件坏了。
 */
export async function readBackupText(text: string, password?: string): Promise<string> {
  if (!isEncryptedBackupText(text)) return text;
  if (!password) throw new BackupDecryptError("这份备份是加密的，需要密码才能读取");
  return decryptBackupText(text, password);
}
