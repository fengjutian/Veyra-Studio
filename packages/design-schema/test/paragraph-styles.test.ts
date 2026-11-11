import assert from "node:assert/strict";
import test from "node:test";
import {
  LIST_INDENT_STEP,
  LIST_MARKER_WIDTH,
  MAX_LIST_INDENT,
  alphaNumerals,
  formatOrderedMarker,
  paragraphIndexAt,
  paragraphRanges,
  paragraphStyleAt,
  remapParagraphStyles,
  resolveParagraphs,
  romanNumerals,
  setParagraphStyle,
  snapRangeToParagraphs,
  validateParagraphStyles,
  type ParagraphStyleRun,
} from "../src/index";

test("paragraph boundaries exclude the newline itself", () => {
  assert.deepEqual(paragraphRanges("a\nb"), [
    { index: 0, start: 0, end: 1 },
    { index: 1, start: 2, end: 3 },
  ]);
  // 末尾的换行符后面算一个空段落：段数与 `split("\n")` 一致。
  assert.equal(paragraphRanges("a\n").length, 2);
  assert.deepEqual(paragraphRanges("a\n")[1], { index: 1, start: 2, end: 2 });
});

test("locates the paragraph that contains an offset", () => {
  assert.equal(paragraphIndexAt("a\nb", 0), 0);
  assert.equal(paragraphIndexAt("a\nb", 1), 0);
  assert.equal(paragraphIndexAt("a\nb", 2), 1);
  assert.equal(paragraphIndexAt("a\nb", 99), 1);
});

test("snaps a selection to whole paragraphs", () => {
  // 右端是开区间：选到第三段起点时第三段不算被选中。
  assert.deepEqual(snapRangeToParagraphs("a\nb\nc", 1, 4), { from: 0, to: 3 });
  // 选到第二段中间：第二段整段生效。
  assert.deepEqual(snapRangeToParagraphs("a\nb\nc", 2, 3), { from: 2, to: 3 });
  // 光标态：落在光标所在段落。
  assert.deepEqual(snapRangeToParagraphs("a\nb\nc", 3, 3), { from: 2, to: 3 });
});

test("rejects ranges that do not align to paragraph boundaries", () => {
  const text = "a\nb";
  assert.equal(validateParagraphStyles(text, undefined), undefined);
  assert.equal(validateParagraphStyles(text, [{ from: 0, to: 1, style: { listType: "bullet" } }]), undefined);
  // 落在段落中间：拒绝。
  assert.match(validateParagraphStyles(text, [{ from: 0, to: 2, style: { listType: "bullet" } }]) ?? "", /align to paragraph boundaries/);
  // 区间重叠：拒绝。
  assert.match(validateParagraphStyles("a\nb\nc", [
    { from: 0, to: 3, style: { listType: "bullet" } },
    { from: 2, to: 5, style: { listType: "bullet" } },
  ]) ?? "", /overlaps/);
  // 段落相邻（中间只隔换行）不算重叠。
  assert.equal(validateParagraphStyles("a\nb\nc", [
    { from: 0, to: 1, style: { listType: "bullet" } },
    { from: 2, to: 3, style: { listType: "bullet" } },
  ]), undefined);
});

test("rejects an indent without a list type", () => {
  // 缩进级别只对列表段落有意义：没有列表类型的缩进会被渲染器忽略。
  assert.match(validateParagraphStyles("a", [{ from: 0, to: 1, style: { indent: 1 } }]) ?? "", /requires a listType/);
});

test("rejects an out-of-range indent level", () => {
  assert.match(validateParagraphStyles("a", [{ from: 0, to: 1, style: { listType: "bullet", indent: MAX_LIST_INDENT + 1 } }]) ?? "", /indent must be an integer/);
});

test("sets a list type on every paragraph the selection touches", () => {
  const text = "a\nb\nc";
  // 选区覆盖前两段：两段都变成列表项，第三段不受影响。
  const runs = setParagraphStyle(text, undefined, 0, 3, { listType: "bullet" });
  // 相邻同款段落合并成一条记录（中间只隔着换行）。
  assert.deepEqual(runs, [{ from: 0, to: 3, style: { listType: "bullet" } }]);
  const resolved = resolveParagraphs(text, runs);
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["•", "•", undefined]);
});

test("snaps the style range to paragraph boundaries", () => {
  const text = "a\nb\nc";
  // 选区落在第二段中间：整段生效。
  const runs = setParagraphStyle(text, undefined, 3, 3, { listType: "ordered" });
  assert.deepEqual(runs, [{ from: 2, to: 3, style: { listType: "ordered" } }]);
});

test("keeps the list type when only the indent changes", () => {
  const text = "a\nb";
  const base = setParagraphStyle(text, undefined, 0, 1, { listType: "bullet" });
  const runs = setParagraphStyle(text, base, 0, 1, { indent: 2 });
  assert.deepEqual(runs, [{ from: 0, to: 1, style: { listType: "bullet", indent: 2 } }]);
});

test("removes the list and the indent together", () => {
  const text = "a\nb";
  const base = setParagraphStyle(text, undefined, 0, 1, { listType: "ordered" });
  const runs = setParagraphStyle(text, base, 0, 1, { listType: "none" });
  assert.deepEqual(runs, []);
});

test("applies the indent delta relative to each paragraph's own level", () => {
  const text = "a\nb";
  // 第一段在 0 级，第二段在 1 级：各加一级后分别是 1 和 2。
  const base: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "bullet", indent: 0 } },
    { from: 2, to: 3, style: { listType: "bullet", indent: 1 } },
  ];
  const runs = setParagraphStyle(text, base, 0, 3, { indentDelta: 1 });
  assert.deepEqual(runs.map(run => run.style.indent), [1, 2]);
});

test("clamps the indent delta to the supported levels", () => {
  const text = "a";
  const base = setParagraphStyle(text, undefined, 0, 1, { listType: "bullet" });
  const runs = setParagraphStyle(text, base, 0, 1, { indentDelta: -1 });
  assert.deepEqual(runs, [{ from: 0, to: 1, style: { listType: "bullet", indent: 0 } }]);
});

test("merges adjacent paragraphs that share the same style", () => {
  const text = "a\nb\nc";
  const runs = setParagraphStyle(text, undefined, 0, 5, { listType: "bullet" });
  // 三段连续的 bullet 合并成一条记录：中间只隔着换行符。
  assert.deepEqual(runs, [{ from: 0, to: 5, style: { listType: "bullet" } }]);
});

test("reads the style of a paragraph", () => {
  const text = "a\nb";
  const runs = setParagraphStyle(text, undefined, 2, 3, { listType: "ordered" });
  assert.deepEqual(paragraphStyleAt(runs, 2, 3), { listType: "ordered" });
  assert.equal(paragraphStyleAt(runs, 0, 1), undefined);
});

test("numbers ordered paragraphs per indent level", () => {
  const text = "a\nb\nc";
  const runs = setParagraphStyle(text, undefined, 0, 5, { listType: "ordered" });
  const resolved = resolveParagraphs(text, runs);
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["1.", "2.", "3."]);
});

test("restarts the numbering for a deeper level", () => {
  const text = "a\nb\nc";
  const runs: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "ordered", indent: 0 } },
    { from: 2, to: 3, style: { listType: "ordered", indent: 1 } },
    { from: 4, to: 5, style: { listType: "ordered", indent: 0 } },
  ];
  const resolved = resolveParagraphs(text, runs);
  // 第二级另起计数：1. / a. / 2.
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["1.", "a.", "2."]);
});

test("restarts the numbering after a non-ordered paragraph", () => {
  const text = "a\nb\nc";
  const runs: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "ordered" } },
    { from: 2, to: 3, style: { listType: "bullet" } },
    { from: 4, to: 5, style: { listType: "ordered" } },
  ];
  const resolved = resolveParagraphs(text, runs);
  // 两段独立的列表各自从 1 开始。
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["1.", "•", "1."]);
});

test("a bullet at a deeper level still breaks the numbering of the outer list", () => {
  const text = "a\nb\nc";
  const runs: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "ordered", indent: 0 } },
    { from: 2, to: 3, style: { listType: "bullet", indent: 1 } },
    { from: 4, to: 5, style: { listType: "ordered", indent: 0 } },
  ];
  const resolved = resolveParagraphs(text, runs);
  // bullet 打断的是整个有序序列，不只是它自己那一级：1. / • / 1.
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["1.", "•", "1."]);
  assert.deepEqual(resolved.map(paragraph => paragraph.ordinal), [1, undefined, 1]);
});

test("a plain paragraph breaks the numbering of the surrounding list", () => {
  const text = "a\nb\nc";
  const runs: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "ordered" } },
    { from: 4, to: 5, style: { listType: "ordered" } },
  ];
  const resolved = resolveParagraphs(text, runs);
  // 中间是普通段落 → 后面的列表块重新从 1 编号：1. / （无标记）/ 1.
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["1.", undefined, "1."]);
  assert.deepEqual(resolved.map(paragraph => paragraph.ordinal), [1, undefined, 1]);
});

test("uses the same bullet at every level", () => {
  const text = "a\nb";
  const runs: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "bullet", indent: 0 } },
    { from: 2, to: 3, style: { listType: "bullet", indent: 3 } },
  ];
  const resolved = resolveParagraphs(text, runs);
  assert.deepEqual(resolved.map(paragraph => paragraph.marker), ["•", "•"]);
});

test("cycles the number format by indent level", () => {
  assert.equal(formatOrderedMarker(1, 0), "1.");
  assert.equal(formatOrderedMarker(2, 1), "b.");
  assert.equal(formatOrderedMarker(3, 2), "iii.");
  // 超过两级后回到数字。
  assert.equal(formatOrderedMarker(4, 3), "4.");
});

test("formats letters with excel-style carry", () => {
  assert.equal(alphaNumerals(1), "a");
  assert.equal(alphaNumerals(26), "z");
  assert.equal(alphaNumerals(27), "aa");
});

test("formats roman numerals with subtractive notation", () => {
  assert.equal(romanNumerals(1), "i");
  assert.equal(romanNumerals(4), "iv");
  assert.equal(romanNumerals(9), "ix");
  assert.equal(romanNumerals(14), "xiv");
});

test("computes the geometry of a list paragraph", () => {
  const text = "a\nb";
  const runs: ParagraphStyleRun[] = [
    { from: 0, to: 1, style: { listType: "bullet", indent: 2 } },
  ];
  const resolved = resolveParagraphs(text, runs);
  assert.equal(resolved[0]!.listIndent, 2 * LIST_INDENT_STEP);
  assert.equal(resolved[0]!.markerWidth, LIST_MARKER_WIDTH);
  assert.equal(resolved[0]!.left, 2 * LIST_INDENT_STEP + LIST_MARKER_WIDTH);
  // 普通段落没有标记区。
  assert.equal(resolved[1]!.left, 0);
  assert.equal(resolved[1]!.markerWidth, 0);
});

test("keeps paragraph styles attached to their paragraph when the text is edited", () => {
  const text = "a\nb";
  const runs = setParagraphStyle(text, undefined, 2, 3, { listType: "bullet" });
  // 在第一段前面插入一个字：段落结构不变，第二段仍然是列表项。
  const remapped = remapParagraphStyles(text, "x\na\nb", runs);
  assert.deepEqual(remapped, [{ from: 4, to: 5, style: { listType: "bullet" } }]);
});

test("extends the style to both halves when a paragraph is split", () => {
  const text = "ab";
  const runs = setParagraphStyle(text, undefined, 0, 2, { listType: "bullet" });
  // 在段落中间插入换行：原来的一段变成两段，两段都继承列表样式。
  const remapped = remapParagraphStyles(text, "a\nb", runs);
  assert.deepEqual(remapped, [{ from: 0, to: 3, style: { listType: "bullet" } }]);
});

test("drops the style when the text it covered is gone", () => {
  const text = "a\nb";
  const runs = setParagraphStyle(text, undefined, 2, 3, { listType: "bullet" });
  const remapped = remapParagraphStyles(text, "a", runs);
  assert.deepEqual(remapped, []);
});
