import assert from "node:assert/strict";
import test from "node:test";
import { fitPreviewSize, previewTitle, svgPreviewDataUrl } from "../src/export-preview";

test("SVG 预览用 UTF-8 base64 生成 data URL，中文不会编码失败", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>设计稿</text></svg>';
  const dataUrl = svgPreviewDataUrl(svg);
  assert.match(dataUrl, /^data:image\/svg\+xml;base64,/);
  const decoded = Buffer.from(dataUrl.split(",")[1]!, "base64").toString("utf8");
  assert.equal(decoded, svg);
});

test("预览标题带上格式与导出范围", () => {
  assert.equal(previewTitle("html", "（整页）"), "HTML 预览（整页）");
  assert.equal(previewTitle("png", "（选区）"), "PNG 预览（选区）");
});

test("预览尺寸等比缩到上限以内，不放大", () => {
  assert.deepEqual(fitPreviewSize({ width: 960, height: 680 }, 480), { width: 480, height: 340 });
  assert.deepEqual(fitPreviewSize({ width: 100, height: 50 }, 480), { width: 100, height: 50 });
  assert.deepEqual(fitPreviewSize({ width: 0, height: 0 }), { width: 0, height: 0 });
});
