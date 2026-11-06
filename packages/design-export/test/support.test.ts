import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_SUPPORT_MATRIX, supportFor } from "../src/index";

const SUPPORT_VALUES = new Set(["exact", "approximated", "rasterized", "unsupported", "n/a"]);

test("支持矩阵的特性 id 唯一且取值合法", () => {
  const features = EXPORT_SUPPORT_MATRIX.map(entry => entry.feature);
  assert.equal(new Set(features).size, features.length);
  for (const entry of EXPORT_SUPPORT_MATRIX) {
    for (const format of ["html", "svg", "png"] as const) assert.ok(SUPPORT_VALUES.has(entry[format]), `${entry.feature}.${format}`);
    assert.ok(entry.note.length > 0, `${entry.feature} 缺少说明`);
  }
});

test("导出器会发出的每一种诊断都能在矩阵里找到对应行", () => {
  // 这些 feature 由 html.ts / svg.ts / png-export.ts 实际发出。
  for (const feature of ["image-asset", "vector", "component-instance", "hidden-node", "layout", "png-rasterize"]) {
    assert.ok(EXPORT_SUPPORT_MATRIX.some(entry => entry.feature === feature), `矩阵缺少 ${feature}`);
  }
});

test("查询某个特性在某个格式下的支持程度", () => {
  assert.equal(supportFor("image-asset", "html"), "exact");
  assert.equal(supportFor("image-asset", "png"), "rasterized");
  assert.equal(supportFor("vector", "svg"), "unsupported");
  assert.equal(supportFor("png-rasterize", "png"), "rasterized");
  assert.equal(supportFor("png-rasterize", "html"), "n/a");
  assert.equal(supportFor("unknown-feature", "png"), undefined);
});
