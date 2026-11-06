import assert from "node:assert/strict";
import test from "node:test";
import { readStorageEstimate, storageAdvice, storageLevel, storagePercent, storageSummary } from "../src/storage-estimate";

test("用量百分比四舍五入并夹在 0-100", () => {
  assert.equal(storagePercent({ usage: 0, quota: 1000 }), 0);
  assert.equal(storagePercent({ usage: 500, quota: 1000 }), 50);
  assert.equal(storagePercent({ usage: 994, quota: 1000 }), 99);
  assert.equal(storagePercent({ usage: 2000, quota: 1000 }), 100);
  // 额度未知时不能除以 0，也不能报一个假的百分比。
  assert.equal(storagePercent({ usage: 10, quota: 0 }), 0);
});

test("70% 提醒、90% 告警", () => {
  assert.equal(storageLevel(69), "normal");
  assert.equal(storageLevel(70), "warning");
  assert.equal(storageLevel(89), "warning");
  assert.equal(storageLevel(90), "critical");
  assert.equal(storageLevel(100), "critical");
});

test("用量摘要同时给绝对值与百分比", () => {
  assert.equal(storageSummary({ usage: 2048, quota: 2 * 1024 * 1024 }), "2.0 KB / 2.0 MB（0%）");
  assert.equal(storageSummary({ usage: 50 * 1024 * 1024, quota: 100 * 1024 * 1024 }), "50.0 MB / 100.0 MB（50%）");
});

test("建议随告警级别变化，正常时也提示导出备份", () => {
  assert.match(storageAdvice("normal"), /备份/);
  assert.match(storageAdvice("warning"), /清理旧项目/);
  assert.match(storageAdvice("critical"), /导出项目 JSON 备份/);
});

test("拿不到浏览器存储估算时返回 undefined", async () => {
  assert.equal(await readStorageEstimate(), undefined);
});
