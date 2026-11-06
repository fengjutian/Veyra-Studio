import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type TextNode } from "@ufira/design-schema";
import { createCachedTextMeasurer, resolveFontFamily, textMeasurementKey, FONT_FALLBACK_STACK } from "../src/index";

function text(overrides: Partial<TextNode> = {}): TextNode {
  return {
    id: "text:1",
    type: "text",
    name: "文本",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: "设计系统",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...overrides,
  };
}

function countingMeasurer() {
  let calls = 0;
  const measurer = {
    measure: (_node: TextNode, availableWidth?: number) => {
      calls += 1;
      return { width: (availableWidth ?? 100) / 2, height: 24 };
    },
  };
  return { measurer, calls: () => calls };
}

test("cache key covers every field that changes the measurement", () => {
  const base = textMeasurementKey(text());
  assert.notEqual(base, textMeasurementKey(text({ fontFamily: "Georgia" })));
  assert.notEqual(base, textMeasurementKey(text({ fontSize: 20 })));
  assert.notEqual(base, textMeasurementKey(text({ lineHeight: 30 })));
  assert.notEqual(base, textMeasurementKey(text({ fontWeight: 700 })));
  assert.notEqual(base, textMeasurementKey(text({ fontStyle: "italic" })));
  assert.notEqual(base, textMeasurementKey(text({ letterSpacing: 2 })));
  assert.notEqual(base, textMeasurementKey(text({ text: "别的文本" })));
  assert.notEqual(base, textMeasurementKey(text(), 200));
});

test("identical measurements hit the cache", () => {
  const { measurer, calls } = countingMeasurer();
  const cached = createCachedTextMeasurer(measurer);
  const node = text();

  assert.deepEqual(cached.measure(node, 120), { width: 60, height: 24 });
  assert.deepEqual(cached.measure(node, 120), { width: 60, height: 24 });
  assert.equal(calls(), 1);
  assert.deepEqual(cached.stats(), { hits: 1, misses: 1, size: 1 });

  // 可用宽度变了就是另一次测量。
  cached.measure(node, 160);
  assert.equal(calls(), 2);
});

test("the cache is bounded and evicts the least recently used entry", () => {
  const { measurer, calls } = countingMeasurer();
  const cached = createCachedTextMeasurer(measurer, { limit: 2 });
  const first = text({ id: "a", text: "a" });
  const second = text({ id: "b", text: "b" });
  const third = text({ id: "c", text: "c" });

  cached.measure(first);
  cached.measure(second);
  cached.measure(first); // 命中，first 变成最近使用
  cached.measure(third); // second 被淘汰

  assert.equal(cached.stats().size, 2);
  cached.measure(second);
  assert.equal(calls(), 4);
});

test("non-finite results from the inner measurer are normalized", () => {
  const cached = createCachedTextMeasurer({ measure: () => ({ width: Number.NaN, height: -5 }) });
  assert.deepEqual(cached.measure(text()), { width: 0, height: 0 });
});

test("clearing resets entries and counters", () => {
  const { measurer } = countingMeasurer();
  const cached = createCachedTextMeasurer(measurer);
  cached.measure(text());
  cached.clear();
  assert.deepEqual(cached.stats(), { hits: 0, misses: 0, size: 0 });
});

test("font family resolution falls back and sanitizes", () => {
  assert.equal(resolveFontFamily(""), FONT_FALLBACK_STACK);
  assert.equal(resolveFontFamily("   "), FONT_FALLBACK_STACK);
  assert.equal(resolveFontFamily("Inter"), `Inter, ${FONT_FALLBACK_STACK}`);
  assert.equal(resolveFontFamily("SF Pro"), `"SF Pro", ${FONT_FALLBACK_STACK}`);
  // 字体名来自导入文件，不能让它跳出 CSS 声明。
  assert.equal(resolveFontFamily('Bad"; color: red; x="'), `"Bad color: red x=", ${FONT_FALLBACK_STACK}`);
});
