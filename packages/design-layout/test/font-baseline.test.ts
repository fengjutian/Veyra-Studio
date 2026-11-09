import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BASELINE_LINE_HEIGHT,
  compareFontBaseline,
  describeEnvironmentDifference,
  fontBaselineCases,
  type FontBaseline,
  type FontBaselineEntry,
} from "../src/font-baseline";

/**
 * 跨平台字体度量基线。
 *
 * 规格见 `docs/font-baseline.md`。要证明的是比较逻辑的纪律：宽度有容差、
 * 换行点没有、**测不到的值不能算一致**。
 */

function entry(id: string, width: number, height = 20, lines = 1): FontBaselineEntry {
  return { id, text: "x", fontFamily: "Inter", fontSize: 14, width, height, lines };
}

function baseline(cases: FontBaselineEntry[], environment?: Partial<FontBaseline["environment"]>): FontBaseline {
  return {
    environment: {
      os: "win32",
      osRelease: "win32 10.0.26200",
      browser: "Chrome 156.0.0.0",
      generatedAt: "2026-11-09T00:00:00.000Z",
      ...environment,
    },
    cases,
  };
}

test("样例集：id 唯一，且覆盖中英文/字重/斜体/字距/换行", () => {
  const cases = fontBaselineCases();
  const ids = cases.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, "样例 id 必须唯一");
  const families = new Set(cases.map(item => item.fontFamily));
  assert.ok(families.size >= 2, "至少覆盖两种字体族");
  assert.ok(cases.some(item => item.availableWidth !== undefined), "要有测换行的样例");
  assert.ok(cases.some(item => item.fontWeight === 700), "要有粗体样例");
  assert.ok(cases.some(item => item.fontStyle === "italic"), "要有斜体样例");
  assert.ok(cases.some(item => (item.letterSpacing ?? 0) > 0), "要有带字距的样例");
});

test("一致时不报差异", () => {
  const result = compareFontBaseline(baseline([entry("a", 100)]), baseline([entry("a", 100.2)]));
  assert.equal(result.diffs.length, 0);
  assert.equal(result.missing.length, 0);
});

test("宽度超出容差要报差异", () => {
  const result = compareFontBaseline(baseline([entry("a", 100)]), baseline([entry("a", 101)]));
  assert.equal(result.diffs.length, 1);
  assert.equal(result.diffs[0]?.widthDelta, 1);
  assert.equal(result.diffs[0]?.lineBreakChanged, false);
});

test("行数变了要报差异，哪怕宽度一样", () => {
  // 换行点变了，导出物的行数与 hug 高度都会变——这比宽度漂移更致命。
  const result = compareFontBaseline(baseline([entry("a", 100, 20, 1)]), baseline([entry("a", 100, 40, 2)]));
  assert.equal(result.diffs.length, 1);
  assert.equal(result.diffs[0]?.lineBreakChanged, true);
});

test("测不到的值不能算一致", () => {
  // NaN 与 NaN 在 JavaScript 里「相等」，一份含 NaN 的基线会被判成完全一致——
  // 那不是一致，是没测到。非有限值一律算差异。
  const result = compareFontBaseline(baseline([entry("a", Number.NaN, Number.NaN, Number.NaN)]), baseline([entry("a", Number.NaN, Number.NaN, Number.NaN)]));
  assert.equal(result.diffs.length, 1);
});

test("缺失的样例要报出来：只在基线里 / 只在实测里", () => {
  const result = compareFontBaseline(baseline([entry("a", 100), entry("b", 50)]), baseline([entry("a", 100), entry("c", 50)]));
  assert.equal(result.missing.length, 2);
  assert.deepEqual(result.missing.map(item => `${item.id}:${item.where}`), ["b:actual", "c:baseline"]);
});

test("按 id 对齐，不按顺序", () => {
  const result = compareFontBaseline(baseline([entry("a", 100), entry("b", 50)]), baseline([entry("b", 50), entry("a", 100)]));
  assert.equal(result.diffs.length, 0);
  assert.equal(result.missing.length, 0);
});

test("平台差异要能说清楚", () => {
  const expected = baseline([entry("a", 100)], { os: "win32", browser: "Chrome 156.0.0.0" });
  const actual = baseline([entry("a", 100)], { os: "darwin", browser: "Safari 18.0" });
  const note = describeEnvironmentDifference(expected, actual);
  assert.match(note ?? "", /win32 → darwin/);
  assert.match(note ?? "", /Chrome 156\.0\.0\.0 → Safari 18\.0/);
});

test("同一平台没有差异时不报平台说明", () => {
  const note = describeEnvironmentDifference(baseline([entry("a", 100)]), baseline([entry("a", 100)]));
  assert.equal(note, undefined);
});

test("系统版本不同也算平台差异", () => {
  const expected = baseline([entry("a", 100)], { osRelease: "win32 10.0.26200" });
  const actual = baseline([entry("a", 100)], { osRelease: "win32 10.0.19045" });
  assert.match(describeEnvironmentDifference(expected, actual) ?? "", /系统版本/);
});

test("缺省行高有明确取值", () => {
  assert.equal(DEFAULT_BASELINE_LINE_HEIGHT, 20);
});
