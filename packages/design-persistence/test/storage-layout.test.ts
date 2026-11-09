import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_STORAGE_VERSION,
  StorageMigrationError,
  detectStorageLayoutVersion,
  migrateStorageLayout,
  type StorageLayoutState,
} from "../src/index";

/**
 * 存储布局迁移引擎。
 *
 * 文档格式有 `migrateDocument()`；这里是它的存储布局版本：只负责版本判定、
 * 步骤编排与迁移历史，具体的结构变更由后端完成。
 */

function state(version: number): StorageLayoutState {
  return { version, migrations: [] };
}

test("布局版本：缺字段或非法值当作最早的一版", () => {
  assert.equal(detectStorageLayoutVersion(undefined), 1);
  assert.equal(detectStorageLayoutVersion(null), 1);
  assert.equal(detectStorageLayoutVersion(0), 1);
  assert.equal(detectStorageLayoutVersion(1.5), 1);
  assert.equal(detectStorageLayoutVersion("2"), 1);
  assert.equal(detectStorageLayoutVersion(2), 2);
});

test("布局版本：文件系统 v1 → v2 补齐 manifest 字段并记录历史", () => {
  const at = new Date("2026-11-09T03:00:00.000Z");
  const result = migrateStorageLayout("filesystem", { version: 1, documentSchemaVersion: 4, migrations: [] }, { now: () => at });
  assert.equal(result.changed, true);
  assert.equal(result.state.version, CURRENT_STORAGE_VERSION.filesystem);
  assert.equal(result.state.documentSchemaVersion, 4);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(result.applied[0], {
    from: 1,
    to: 2,
    description: "manifest 增加 storageVersion 与 documentSchemaVersion",
    at: at.toISOString(),
  });
});

test("布局版本：已是最新版本时什么都不做", () => {
  const result = migrateStorageLayout("filesystem", state(CURRENT_STORAGE_VERSION.filesystem));
  assert.equal(result.changed, false);
  assert.deepEqual(result.applied, []);
  assert.equal(result.state.version, CURRENT_STORAGE_VERSION.filesystem);
});

test("布局版本：浏览器后端逐级升到 v3，历史按顺序累积", () => {
  const result = migrateStorageLayout("browser", state(1), { now: () => new Date("2026-11-09T00:00:00.000Z") });
  assert.equal(result.state.version, 3);
  assert.deepEqual(result.applied.map(item => [item.from, item.to]), [[1, 2], [2, 3]]);
  assert.deepEqual(result.state.migrations.map(item => item.to), [2, 3]);
});

test("布局版本：未来版本一律拒绝，不猜着读", () => {
  assert.throws(
    () => migrateStorageLayout("filesystem", state(CURRENT_STORAGE_VERSION.filesystem + 1)),
    (error: unknown) => error instanceof StorageMigrationError && /newer than this app supports/.test(error.message),
  );
});

test("布局版本：非法版本号（0 / 小数）直接报错", () => {
  for (const version of [0, 1.5, Number.NaN]) {
    assert.throws(() => migrateStorageLayout("browser", state(version)), StorageMigrationError);
  }
});

test("布局版本：同一状态重复迁移是幂等的", () => {
  const once = migrateStorageLayout("browser", state(1)).state;
  const twice = migrateStorageLayout("browser", once);
  assert.equal(twice.changed, false);
  assert.equal(twice.state.migrations.length, 2);
});

test("布局版本：历史记录带上时间戳，便于恢复报告展示", () => {
  const at = new Date("2026-11-09T08:30:00.000Z");
  const result = migrateStorageLayout("browser", state(2), { now: () => at });
  assert.equal(result.applied[0]?.at, at.toISOString());
  assert.equal(result.state.migrations.length, 1);
});
