import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import {
  DISK_BACKUP_MIN_INTERVAL_MS,
  DISK_BACKUP_PREFIX,
  DISK_BACKUP_RETENTION,
  DiskBackupRunner,
  backupFileProjectSlug,
  backupFileName,
  backupProjectSlug,
  isBackupFileName,
  planBackupRotation,
  shouldWriteDiskBackup,
  type BackupDirectoryPort,
} from "../src/disk-backup";

/**
 * 磁盘备份的纯逻辑与执行器。
 *
 * 规格见 `docs/backup.md`。真正的落盘（File System Access API）不在测试里，
 * 用假目录验证「写什么名字、写几份、什么时候不写、失败怎么上报」。
 */

/** 内存目录：文件名 → 内容，另记录删除。 */
class FakeDirectory implements BackupDirectoryPort {
  readonly name = "备份目录";
  readonly files = new Map<string, string>();
  readonly removed: string[] = [];
  failNextWrite = false;

  constructor(initial: Record<string, string> = {}) {
    for (const [name, contents] of Object.entries(initial)) this.files.set(name, contents);
  }

  async write(name: string, contents: string): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("磁盘已满");
    }
    this.files.set(name, contents);
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }

  async remove(name: string): Promise<void> {
    this.removed.push(name);
    this.files.delete(name);
  }
}

test("备份文件名：项目 id 折成安全片段，时间戳与 revision 都在", () => {
  assert.equal(backupProjectSlug("project:1"), "project-1");
  assert.equal(backupProjectSlug("设计/项目"), "project");
  const name = backupFileName("project:1", 12, new Date("2026-11-09T04:05:06.000Z"));
  assert.equal(name, `${DISK_BACKUP_PREFIX}project-1-20261109T040506Z-r12.json`);
  assert.equal(isBackupFileName(name), true);
  // 解析回来能对上项目，轮转只碰自己写的文件。
  assert.equal(backupFileProjectSlug(name), "project-1");
});

test("备份文件名：目录里的其它文件不算备份", () => {
  assert.equal(isBackupFileName("ufira-backup-project-20261109T000000Z-r1.json"), true);
  for (const name of ["notes.txt", "manifest.json", "other-ufira-backup-a.json", "ufira-backup-a.json"]) {
    assert.equal(isBackupFileName(name) && backupFileProjectSlug(name) !== undefined, false, name);
  }
});

test("轮转：只保留最新 N 份，别的项目与别的文件不碰", () => {
  const files = [
    ...Array.from({ length: 12 }, (_, index) => `ufira-backup-project-1-20261109T0000${String(index).padStart(2, "0")}Z-r${index}.json`),
    "ufira-backup-project-2-20261109T000001Z-r1.json",
    "readme.md",
  ];
  const stale = planBackupRotation(files, { projectId: "project:1" });
  assert.equal(stale.length, 12 - DISK_BACKUP_RETENTION);
  // 删的是最旧的两份。
  assert.deepEqual(stale, [files[0], files[1]]);
  assert.equal(stale.includes(files[12]!), false);
  assert.equal(stale.includes("readme.md"), false);
});

test("轮转：保留份数可配置，没超上限时一份不删", () => {
  const files = ["ufira-backup-p-20261109T000000Z-r1.json"];
  assert.deepEqual(planBackupRotation(files, { projectId: "p", keep: 3 }), []);
  assert.deepEqual(planBackupRotation(files, { projectId: "p", keep: 0 }), files);
});

test("节流：第一次立即写，之后按最小间隔", () => {
  const now = new Date("2026-11-09T04:00:00.000Z");
  assert.equal(shouldWriteDiskBackup(undefined, now), true);
  assert.equal(shouldWriteDiskBackup("not-a-date", now), true);
  assert.equal(shouldWriteDiskBackup(new Date(now.getTime() - 60_000).toISOString(), now), false);
  assert.equal(shouldWriteDiskBackup(new Date(now.getTime() - DISK_BACKUP_MIN_INTERVAL_MS).toISOString(), now), true);
});

test("执行器：没接目录时什么都不写", async () => {
  const runner = new DiskBackupRunner();
  const status = await runner.backup(createDocument("project:1", "Demo"));
  assert.equal(status.state, "disabled");
  assert.equal(runner.target, undefined);
});

test("执行器：写入完整文档、轮转旧文件并报告份数", async () => {
  const directory = new FakeDirectory();
  const now = new Date("2026-11-09T04:00:00.000Z");
  const runner = new DiskBackupRunner({ now: () => now, keep: 2 });
  runner.use(directory);

  const document = createDocument("project:1", "Demo");
  const first = await runner.backup(document);
  assert.equal(first.state, "saved");
  assert.equal(first.files, 1);
  assert.ok(first.fileName?.startsWith(DISK_BACKUP_PREFIX));
  assert.deepEqual(JSON.parse(directory.files.get(first.fileName!)!), document);

  // 换时间再写两份，保留 2 份 → 最早那份被删。
  for (let index = 1; index <= 2; index++) {
    runner.restoreLastSavedAt(undefined);
    const later = new Date(now.getTime() + index * 10 * 60 * 1000);
    const runnerLater = new DiskBackupRunner({ now: () => later, keep: 2 });
    runnerLater.use(directory);
    await runnerLater.backup(document);
  }
  assert.equal(directory.removed.length, 1);
  assert.equal(directory.files.size, 2);
});

test("执行器：节流窗口内不写，force 时照写", async () => {
  const directory = new FakeDirectory();
  const now = new Date("2026-11-09T04:00:00.000Z");
  const runner = new DiskBackupRunner({ now: () => now });
  runner.use(directory);
  const document = createDocument("project:1", "Demo");

  assert.equal((await runner.backup(document)).state, "saved");
  assert.equal((await runner.backup(document)).state, "throttled");
  assert.equal(directory.files.size, 1);

  // 同一时刻的「立即备份」不受节流限制。
  assert.equal((await runner.backup(document, { force: true })).state, "saved");
  assert.equal(directory.files.size, 1); // 同一秒 + 同一 revision → 同名覆盖
});

test("执行器：写入失败变成状态，不抛错", async () => {
  const directory = new FakeDirectory();
  directory.failNextWrite = true;
  const runner = new DiskBackupRunner({ now: () => new Date("2026-11-09T04:00:00.000Z") });
  runner.use(directory);

  const status = await runner.backup(createDocument("project:1", "Demo"));
  assert.equal(status.state, "error");
  assert.match(status.error!, /磁盘已满/);
  // 失败不推进 lastSavedAt，下一次还会重试。
  assert.equal(runner.lastSaved, undefined);
});

test("执行器：接上目录的会话可以恢复上次写入时间", async () => {
  const directory = new FakeDirectory();
  const now = new Date("2026-11-09T04:00:00.000Z");
  const runner = new DiskBackupRunner({ now: () => now });
  runner.use(directory);
  runner.restoreLastSavedAt(new Date(now.getTime() - 60_000).toISOString());
  assert.equal((await runner.backup(createDocument("project:1", "Demo"))).state, "throttled");
});
