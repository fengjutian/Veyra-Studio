import assert from "node:assert/strict";
import test from "node:test";
import { createDocument } from "@ufira/design-schema";
import { buildRecoveryReport, recoveryReportFileName, recoveryReportRows } from "../src/recovery-report";

function report(overrides: Partial<Parameters<typeof buildRecoveryReport>[0]> = {}) {
  const document = createDocument("project:1", "首页", "page:1");
  return buildRecoveryReport({
    projectId: document.id,
    projectName: document.meta.name,
    document,
    recoveredFromRevision: 4,
    replayedTransactions: 2,
    latestKnownRevision: 6,
    degraded: false,
    generatedAt: "2026-11-06T00:00:00.000Z",
    ...overrides,
  });
}

test("记录项目、修订与事务重放情况", () => {
  const built = report();

  assert.equal(built.projectId, "project:1");
  assert.equal(built.projectName, "首页");
  assert.equal(built.recoveredFromRevision, 4);
  assert.equal(built.replayedTransactions, 2);
  assert.equal(built.latestKnownRevision, 6);
  assert.equal(built.documentSchemaVersion, 2);
  assert.equal(built.degraded, false);
  assert.equal(built.generatedAt, "2026-11-06T00:00:00.000Z");
});

test("降级恢复会被标记出来", () => {
  const rows = recoveryReportRows(report({ degraded: true }));
  const status = rows.find(row => row.label === "恢复状态");

  assert.equal(status?.tone, "warning");
  assert.match(status?.value ?? "", /降级/);
});

test("格式升级会写明来源版本", () => {
  const rows = recoveryReportRows(report({ migratedFrom: 1 }));
  const version = rows.find(row => row.label === "文档格式版本");

  assert.match(version?.value ?? "", /v1/);
  assert.match(version?.value ?? "", /v2/);
});

test("正常恢复的每一行都有内容", () => {
  const rows = recoveryReportRows(report());

  assert.equal(rows.length, 5);
  for (const row of rows) assert.ok(row.value.length > 0);
});

test("报告文件名去掉非法字符并带上后缀", () => {
  assert.equal(recoveryReportFileName("首页/设计"), "首页-设计-恢复报告.json");
  assert.equal(recoveryReportFileName("   "), "design-恢复报告.json");
});
