import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createDocument } from "@ufira/design-schema";
import { BACKUP_MIN_INTERVAL_MS, ProjectBackupStore, backupByteLength, backupRestoreConfirmation, backupRows, shouldWriteBackup } from "../src/backup-store";

function createStore(): ProjectBackupStore {
  return new ProjectBackupStore({ databaseName: `backup-test-${crypto.randomUUID()}`, indexedDB, IDBKeyRange });
}

test("第一次落盘就写备份，之后按最小间隔节流", () => {
  const now = new Date("2026-11-06T10:00:00.000Z");
  assert.equal(shouldWriteBackup(undefined, now), true);
  assert.equal(shouldWriteBackup({ createdAt: "2026-11-06T09:59:00.000Z" }, now), false);
  assert.equal(shouldWriteBackup({ createdAt: "2026-11-06T09:49:00.000Z" }, now), true);
  assert.equal(shouldWriteBackup({ createdAt: "2026-11-06T09:49:59.000Z" }, now), true);
  assert.equal(shouldWriteBackup({ createdAt: "not-a-date" }, now), true);
  assert.equal(BACKUP_MIN_INTERVAL_MS, 10 * 60 * 1000);
});

test("备份按项目轮转，只保留最近三份", async t => {
  const store = createStore();
  t.after(() => store.deleteDatabase());
  const document = createDocument("project:1", "首页", "page:1");

  for (let index = 0; index < 5; index += 1) {
    document.revision = index;
    await store.write(document, { now: `2026-11-06T10:0${index}:00.000Z` });
  }

  const list = await store.list("project:1");
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(item => item.revision), [4, 3, 2]);
  assert.deepEqual(list.map(item => item.createdAt), ["2026-11-06T10:04:00.000Z", "2026-11-06T10:03:00.000Z", "2026-11-06T10:02:00.000Z"]);
});

test("可以读回任意一份备份的完整文档", async t => {
  const store = createStore();
  t.after(() => store.deleteDatabase());
  const document = createDocument("project:1", "首页", "page:1");
  document.revision = 7;
  await store.write(document, { now: "2026-11-06T10:00:00.000Z" });
  document.revision = 9;
  await store.write(document, { now: "2026-11-06T10:05:00.000Z" });

  const older = await store.read("project:1", "2026-11-06T10:00:00.000Z");
  assert.equal(older.revision, 7);
  assert.equal(older.meta.name, "首页");
});

test("删除项目会连备份一起清掉", async t => {
  const store = createStore();
  t.after(() => store.deleteDatabase());
  await store.write(createDocument("project:1", "首页", "page:1"));
  await store.deleteProject("project:1");
  assert.deepEqual(await store.list("project:1"), []);
});

test("备份行的标签带上修订号与项目名", () => {
  const rows = backupRows([{ projectId: "project:1", createdAt: "2026-11-06T10:00:00.000Z", revision: 4, name: "首页", byteLength: 2048 }]);
  assert.equal(rows[0]?.label, "r4 · 首页");
});

test("还原确认说明回到哪一份、且可以撤销", () => {
  const confirmation = backupRestoreConfirmation({ projectId: "project:1", createdAt: "2026-11-06T10:00:00.000Z", revision: 4, name: "首页", byteLength: 2048 });
  assert.match(confirmation.title, /r4/);
  assert.match(confirmation.description, /撤销/);
});

test("备份体积按文档 JSON 的字节数计算", () => {
  const document = createDocument("project:1", "首页", "page:1");
  assert.equal(backupByteLength(document), new TextEncoder().encode(JSON.stringify(document)).byteLength);
  assert.ok(backupByteLength(document) > 0);
});
