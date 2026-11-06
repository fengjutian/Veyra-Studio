import assert from "node:assert/strict";
import test from "node:test";
import { computePageLayout } from "../src/index";
import { documentWithNodes } from "../bench/layout-bench";

/**
 * 性能 smoke 测试。
 *
 * 不是微基准：这里只断言"1000 个节点的布局不会退化成秒级"。预算给得非常宽松
 * （2 秒），正常实现是几毫秒，所以只有数量级的退化才会让它失败，不会因为 CI
 * 抖动而红灯。真实基线用 `npm run bench:layout` 看。
 */
test("lays out a thousand synthetic nodes without a pathological slowdown", () => {
  const document = documentWithNodes(1000);
  assert.ok(Object.keys(document.nodes).length >= 1000);

  const started = process.hrtime.bigint();
  const result = computePageLayout(document, "page:1", { viewport: { width: 960, height: 680 } });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(Object.keys(result.boxes).length > 0);
  assert.ok(elapsedMs < 2000, `layout took ${elapsedMs.toFixed(0)}ms, expected well under 2s`);
});
