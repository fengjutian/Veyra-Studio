import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectStorageUsage } from "@ufira/design-persistence";
import { DEFAULT_HISTORY_KEEP, formatReclaim, storageCleanupSuggestions, storageUsageOverview, storageUsageRows } from "../src/storage-usage";

function usage(overrides: Partial<ProjectStorageUsage> & { projectId: string }): ProjectStorageUsage {
  return {
    projectName: overrides.projectId,
    snapshotBytes: 1000,
    journalBytes: 100,
    assetBytes: 0,
    totalBytes: 1100,
    historyCount: 0,
    assetCount: 0,
    ...overrides,
  };
}

test("当前项目排在最前，其余按占用从大到小", () => {
  const rows = storageUsageRows([
    usage({ projectId: "a", totalBytes: 300 }),
    usage({ projectId: "b", totalBytes: 900 }),
    usage({ projectId: "c", totalBytes: 600 }),
  ], { currentProjectId: "b" });
  assert.deepEqual(rows.map(row => row.projectId), ["b", "c", "a"]);
  assert.equal(rows[0]?.current, true);
  assert.equal(rows[1]?.current, false);
});

test("项目没有名字时退回用 id 顶上", () => {
  const rows = storageUsageRows([usage({ projectId: "project:1", projectName: "" })]);
  assert.equal(rows[0]?.projectName, "project:1");
});

test("历史版本超出保留份数的部分算成可回收", () => {
  // 5 份历史版本，默认保留 3 份（当前 + 2 份历史），所以还有 3 份可以裁。
  const rows = storageUsageRows([usage({ projectId: "a", historyCount: 5, snapshotBytes: 6000 })]);
  assert.equal(rows[0]?.reclaimableHistory, 5 - (DEFAULT_HISTORY_KEEP - 1));
  assert.ok(rows[0]!.reclaimableBytes > 0, "可回收字节数应大于 0");
  assert.ok((rows[0]!.reclaimableBytes as number) <= rows[0]!.snapshotBytes, "可回收量不应超过快照总量");
});

test("历史版本不多时没有可回收的部分", () => {
  const rows = storageUsageRows([usage({ projectId: "a", historyCount: 1 })]);
  assert.equal(rows[0]?.reclaimableHistory, 0);
  assert.equal(rows[0]?.reclaimableBytes, 0);
});

test("清理建议覆盖裁历史版本与删除旧项目，按可回收量排序", () => {
  const rows = storageUsageRows([
    usage({ projectId: "current", projectName: "当前", historyCount: 4, snapshotBytes: 4000 }),
    usage({ projectId: "old", projectName: "旧项目", totalBytes: 50000, snapshotBytes: 50000 }),
  ], { currentProjectId: "current" });
  const suggestions = storageCleanupSuggestions(rows);
  assert.ok(suggestions.length >= 2);
  assert.equal(suggestions[0]?.action, "delete-project");
  assert.equal(suggestions[0]?.projectId, "old");
  assert.ok(suggestions.some(item => item.action === "trim-history" && item.projectId === "current"));
  // 可回收量从多到少。
  for (let index = 1; index < suggestions.length; index += 1) {
    assert.ok((suggestions[index - 1]?.reclaimableBytes as number) >= (suggestions[index]?.reclaimableBytes as number));
  }
});

test("当前项目不会被建议删除", () => {
  const rows = storageUsageRows([usage({ projectId: "only", totalBytes: 9999 })], { currentProjectId: "only" });
  const suggestions = storageCleanupSuggestions(rows);
  assert.equal(suggestions.filter(item => item.action === "delete-project").length, 0);
});

test("汇总给出总量、当前项目占用和可回收总量", () => {
  const overview = storageUsageOverview([
    usage({ projectId: "current", projectName: "当前", totalBytes: 1000, historyCount: 4, snapshotBytes: 800 }),
    usage({ projectId: "old", projectName: "旧", totalBytes: 2000 }),
  ], { currentProjectId: "current" });
  assert.equal(overview.totalBytes, 3000);
  assert.equal(overview.currentBytes, 1000);
  assert.equal(overview.rows.length, 2);
  assert.ok(overview.reclaimableBytes > 0);
});

test("没有项目时汇总是空的，不报错", () => {
  const overview = storageUsageOverview([]);
  assert.deepEqual(overview.rows, []);
  assert.deepEqual(overview.suggestions, []);
  assert.equal(overview.totalBytes, 0);
});

test("回收量按字节数给出可读摘要", () => {
  assert.equal(formatReclaim(0), "0 B");
  assert.equal(formatReclaim(512), "512 B");
  assert.equal(formatReclaim(2048), "2.0 KB");
  assert.equal(formatReclaim(5 * 1024 * 1024), "5.0 MB");
});
