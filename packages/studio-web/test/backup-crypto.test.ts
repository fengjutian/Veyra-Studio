import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import {
  BACKUP_KDF_ITERATIONS,
  BackupDecryptError,
  ENCRYPTED_BACKUP_FORMAT,
  base64ToBytes,
  bytesToBase64,
  decryptBackupText,
  encryptBackupText,
  isEncryptedBackupText,
  parseEnvelope,
  readBackupText,
  supportsBackupEncryption,
} from "../src/backup-crypto";
import { DiskBackupRunner, type BackupDirectoryPort } from "../src/disk-backup";

/**
 * 磁盘备份的加密信封。
 *
 * 规格见 `docs/backup.md` §7。要证明的不是「密文长这样」，而是三件事：
 * 能原样解回来、密码不对就解不开、明文不出现在文件里。
 */

const PASSWORD = "正确的密码";

/** 内存目录：记录写进去的内容。 */
class FakeDirectory implements BackupDirectoryPort {
  readonly name = "备份目录";
  readonly files = new Map<string, string>();

  async write(name: string, contents: string): Promise<void> {
    this.files.set(name, contents);
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
}

test("环境支持加密（Node 与浏览器都有 WebCrypto）", () => {
  assert.equal(supportsBackupEncryption(), true);
});

test("加密再解密：内容原样回来", async () => {
  const plain = JSON.stringify(createDocument("project:1", "加密项目"));
  const envelope = await encryptBackupText(plain, PASSWORD);
  assert.equal(await decryptBackupText(envelope, PASSWORD), plain);
});

test("密文里看不到明文：项目名、文档字段都不出现", async () => {
  const plain = JSON.stringify(createDocument("project:1", "机密项目"));
  const envelope = await encryptBackupText(plain, PASSWORD);
  assert.equal(envelope.includes("机密项目"), false);
  assert.equal(envelope.includes("schemaVersion"), false);
  // 信封本身是 JSON，能看出「这是加密备份」以及用什么 KDF——这是刻意的，
  // 没有服务端时用户至少要知道文件不是坏了。
  const parsed = JSON.parse(envelope) as Record<string, unknown>;
  assert.equal(parsed.format, ENCRYPTED_BACKUP_FORMAT);
  assert.equal((parsed.kdf as { name: string }).name, "PBKDF2");
});

test("密码不对就解不开，且不泄漏底层错误", async () => {
  const envelope = await encryptBackupText("payload", PASSWORD);
  await assert.rejects(() => decryptBackupText(envelope, "另一个密码"), (error: unknown) => {
    assert.ok(error instanceof BackupDecryptError);
    // 文案要同时覆盖「密码错」与「文件损坏」——GCM 分不清这两者。
    assert.match(error.message, /密码不正确|损坏/);
    return true;
  });
});

test("同一份内容两次加密的盐与 IV 都不同", async () => {
  const plain = "same payload";
  const first = parseEnvelope(await encryptBackupText(plain, PASSWORD));
  const second = parseEnvelope(await encryptBackupText(plain, PASSWORD));
  assert.notEqual(first.kdf.salt, second.kdf.salt);
  assert.notEqual(first.cipher.iv, second.cipher.iv);
  assert.notEqual(first.data, second.data);
});

test("迭代次数写进信封：调高迭代不会让旧文件解不开", async () => {
  const envelope = parseEnvelope(await encryptBackupText("payload", PASSWORD));
  assert.equal(envelope.kdf.iterations, BACKUP_KDF_ITERATIONS);
  // 未来调高迭代次数时，旧文件仍按自己信封里的次数派生。
  const older = parseEnvelope(JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, iterations: 1000 } }));
  assert.equal(older.kdf.iterations, 1000);
});

test("识别加密备份：只认结构，不猜内容", () => {
  assert.equal(isEncryptedBackupText('{"format":"ufira-encrypted-backup"}'), true);
  assert.equal(isEncryptedBackupText('{"format":"other"}'), false);
  assert.equal(isEncryptedBackupText('{"a":1}'), false);
  assert.equal(isEncryptedBackupText("not json"), false);
  assert.equal(isEncryptedBackupText(""), false);
});

test("不认识的信封一律拒绝，不猜", async () => {
  const envelope = parseEnvelope(await encryptBackupText("payload", PASSWORD));
  assert.throws(() => parseEnvelope(JSON.stringify({ ...envelope, version: 99 })), BackupDecryptError);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...envelope, format: "other" })), BackupDecryptError);
  assert.throws(() => parseEnvelope(JSON.stringify({ ...envelope, kdf: undefined })), BackupDecryptError);
  assert.throws(() => parseEnvelope("不是 json"), BackupDecryptError);
});

test("读备份原文：明文直通，加密的必须给密码", async () => {
  const plain = JSON.stringify(createDocument("project:1", "明文项目"));
  assert.equal(await readBackupText(plain), plain);
  const envelope = await encryptBackupText(plain, PASSWORD);
  // 加密但没密码：要给出「需要密码」，不能落到 JSON.parse 的语法错误上。
  await assert.rejects(() => readBackupText(envelope), BackupDecryptError);
  assert.equal(await readBackupText(envelope, PASSWORD), plain);
});

test("base64 往返：中文与二进制字节都不丢", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
  const text = "项目文档 · 中文 · emoji 🎨";
  const encoded = new TextEncoder().encode(text);
  assert.equal(new TextDecoder().decode(base64ToBytes(bytesToBase64(encoded))), text);
});

test("备份执行器：装了编码器就写密文，解回来是文档", async () => {
  const directory = new FakeDirectory();
  const runner = new DiskBackupRunner({
    now: () => new Date("2026-11-09T04:05:06.000Z"),
    encoder: { encode: plain => encryptBackupText(plain, PASSWORD) },
  });
  runner.use(directory);
  const document = createDocument("project:1", "加密备份项目");
  const status = await runner.backup(document);
  assert.equal(status.state, "saved");
  const written = [...directory.files.values()][0];
  assert.equal(isEncryptedBackupText(written), true);
  assert.equal(written.includes("加密备份项目"), false);
  const decrypted = JSON.parse(await decryptBackupText(written, PASSWORD)) as { meta: { name: string } };
  assert.equal(decrypted.meta.name, "加密备份项目");
});

test("备份执行器：编码失败转 error 状态，且不推进节流时间", async () => {
  const directory = new FakeDirectory();
  const runner = new DiskBackupRunner({
    now: () => new Date("2026-11-09T04:05:06.000Z"),
    encoder: { encode: async () => { throw new Error("加密失败"); } },
  });
  runner.use(directory);
  const status = await runner.backup(createDocument("project:1", "x"));
  assert.equal(status.state, "error");
  assert.match(status.error ?? "", /加密失败/);
  // 没写成功就不能算「已保存」，否则下一次自动保存会被节流挡住。
  assert.equal(runner.lastSaved, undefined);
  assert.equal(directory.files.size, 0);
});

test("备份执行器：可以中途换掉编码步骤（开/关加密）", async () => {
  const directory = new FakeDirectory();
  const runner = new DiskBackupRunner({ now: () => new Date("2026-11-09T04:05:06.000Z") });
  runner.use(directory);
  runner.setEncoder({ encode: plain => encryptBackupText(plain, PASSWORD) });
  await runner.backup(createDocument("project:1", "第一个"));
  runner.setEncoder(undefined);
  // force 绕过节流：这里要的是「换编码后再写一份」，不是「等五分钟」。
  // revision 也要不同——文件名里带 revision，同名会互相覆盖。
  await runner.backup({ ...createDocument("project:1", "第二个"), revision: 1 }, { force: true });
  const contents = [...directory.files.values()];
  assert.equal(contents.filter(text => isEncryptedBackupText(text)).length, 1);
  assert.equal(contents.filter(text => !isEncryptedBackupText(text)).length, 1);
});
