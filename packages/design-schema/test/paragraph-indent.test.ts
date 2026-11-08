import assert from "node:assert/strict";
import test from "node:test";
import {
  LIST_INDENT_STEP,
  LIST_MARKER_WIDTH,
  resolveParagraphs,
  setParagraphStyle,
  validateParagraphStyles,
} from "../src/index";

/**
 * 段落缩进 / 悬挂列表 / 列表间距。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

test("the paragraph indent shifts the text to the right", () => {
  const paragraphs = resolveParagraphs("ab", [{ from: 0, to: 2, style: { paragraphIndent: 30 } }]);
  assert.equal(paragraphs[0]!.paragraphIndent, 30);
  assert.equal(paragraphs[0]!.left, 30);
  assert.equal(paragraphs[0]!.markerWidth, 0);
});

test("the paragraph indent stacks on top of the list indent", () => {
  const paragraphs = resolveParagraphs("ab", [{
    from: 0,
    to: 2,
    style: { listType: "bullet", indent: 1, paragraphIndent: 10 },
  }]);
  // 左偏移 = 级别缩进 + 标记区宽度 + 段落缩进。
  assert.equal(paragraphs[0]!.left, LIST_INDENT_STEP + LIST_MARKER_WIDTH + 10);
});

test("a hanging list keeps the marker out of the text width", () => {
  const paragraphs = resolveParagraphs("ab", [{ from: 0, to: 2, style: { listType: "bullet", hanging: true } }]);
  assert.equal(paragraphs[0]!.hanging, true);
  // 标记还在，但不占正文宽度：正文从框的左边缘开始。
  assert.equal(paragraphs[0]!.marker, "•");
  assert.equal(paragraphs[0]!.markerWidth, 0);
  assert.equal(paragraphs[0]!.left, 0);
});

test("hanging without a list type is rejected", () => {
  assert.match(
    validateParagraphStyles("ab", [{ from: 0, to: 2, style: { hanging: true } }]) ?? "",
    /requires a listType/,
  );
});

test("rejects a negative indent or spacing", () => {
  assert.match(
    validateParagraphStyles("ab", [{ from: 0, to: 2, style: { paragraphIndent: -1 } }]) ?? "",
    /paragraphIndent/,
  );
  assert.match(
    validateParagraphStyles("ab", [{ from: 0, to: 2, style: { listSpacing: -1 } }]) ?? "",
    /listSpacing/,
  );
});

test("the list spacing is reported on the paragraph", () => {
  const paragraphs = resolveParagraphs("ab", [{ from: 0, to: 2, style: { listSpacing: 8 } }]);
  assert.equal(paragraphs[0]!.spaceAfter, 8);
});

test("setParagraphStyle merges the new fields", () => {
  const runs = setParagraphStyle("ab", undefined, 0, 2, {
    listType: "bullet",
    paragraphIndent: 12,
    hanging: true,
    listSpacing: 6,
  });
  assert.deepEqual(runs[0]!.style, {
    listType: "bullet",
    paragraphIndent: 12,
    hanging: true,
    listSpacing: 6,
  });
});

test("setParagraphStyle drops the fields when they are reset", () => {
  const first = setParagraphStyle("ab", undefined, 0, 2, {
    listType: "bullet",
    paragraphIndent: 12,
    hanging: true,
    listSpacing: 6,
  });
  const second = setParagraphStyle("ab", first, 0, 2, { paragraphIndent: 0, hanging: false, listSpacing: 0 });
  // 归零/关掉就是删字段：样式里不留 `0` 或 `false`。
  assert.deepEqual(second[0]!.style, { listType: "bullet" });
});

test("cancelling the list clears the new fields too", () => {
  const first = setParagraphStyle("ab", undefined, 0, 2, {
    listType: "bullet",
    paragraphIndent: 12,
    hanging: true,
    listSpacing: 6,
  });
  const second = setParagraphStyle("ab", first, 0, 2, { listType: "none" });
  assert.equal(second.length, 0);
});
