import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticRows, diagnosticSummary, featureLabel, supportLabel, supportRows } from "../src/export-report";

const diagnostics = [
  { nodeId: "image:1", feature: "image-asset", support: "unsupported" as const, message: "No export URL was provided for asset asset:1" },
  { nodeId: "frame:1", feature: "component-instance", support: "approximated" as const, message: "Instance export uses the materialized children" },
];

test("诊断行把特性翻译成中文，并保留定位用的节点 id", () => {
  const rows = diagnosticRows(diagnostics);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.label, "图片资源");
  assert.equal(rows[0]?.supportLabel, "不支持");
  assert.equal(rows[0]?.nodeId, "image:1");
  assert.equal(rows[1]?.label, "组件实例");
  assert.equal(rows[1]?.supportLabel, "近似");
});

test("组件覆盖有单独的特性名，不会和组件实例混在一起", () => {
  assert.equal(featureLabel("component-override"), "组件覆盖");
  assert.equal(featureLabel("component-instance"), "组件实例");
});

test("未知特性不会被吞掉，原样显示 id", () => {
  assert.equal(featureLabel("future-feature"), "future-feature");
});

test("诊断摘要区分有诊断与没有诊断", () => {
  assert.equal(diagnosticSummary([]), "导出一次后这里会列出诊断");
  assert.equal(diagnosticSummary([], "svg"), "SVG 本次导出没有诊断");
  assert.match(diagnosticSummary(diagnostics, "html"), /共 2 条诊断，其中 1 条不受支持/);
  assert.match(diagnosticSummary([diagnostics[1]!], "png"), /共 1 条诊断/);
});

test("支持矩阵行把 n/a 显示成破折号", () => {
  const rows = supportRows();
  assert.ok(rows.length >= 10);
  const png = rows.find(row => row.feature === "png-rasterize");
  assert.equal(png?.html, "—");
  assert.equal(png?.png, "光栅化");
  assert.equal(supportLabel("exact"), "完整");
});
