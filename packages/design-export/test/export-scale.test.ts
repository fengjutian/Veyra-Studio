import assert from "node:assert/strict";
import test from "node:test";
import { documentWithNodes } from "../../design-layout/bench/layout-bench";
import { computePageLayout } from "@ufira/design-layout";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/**
 * 大文档 smoke：5000 节点必须在一秒级内完成布局与导出。
 *
 * 预算（5 秒）远高于实测（布局 ~30ms、HTML ~50ms、SVG ~70ms），所以只有数量级
 * 退化才会失败；真实数字用 `npm run check:budgets` 看。
 */
test("lays out and exports a five-thousand node document without pathological slowdown", () => {
  const document = documentWithNodes(5000);
  assert.ok(Object.keys(document.nodes).length >= 5000);

  const started = process.hrtime.bigint();
  const layout = computePageLayout(document, "page:1", { viewport: { width: 960, height: 680 } });
  const html = exportPageToHtml(document, { pageId: "page:1", viewport: { width: 960, height: 680 } }).document;
  const svg = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 960, height: 680 } }).svg;
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(Object.keys(layout.boxes).length > 0);
  assert.ok(html.length > 0);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(elapsedMs < 5000, `layout + export took ${elapsedMs.toFixed(0)}ms, expected well under 5s`);
});
