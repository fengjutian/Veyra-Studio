import assert from "node:assert/strict";
import test from "node:test";
import { layoutRichText, measureRichText, type RichTextStyle } from "../src/index";
import { LIST_INDENT_STEP, LIST_MARKER_WIDTH } from "@ufira/design-schema";

/**
 * 段落样式（列表 + 缩进）的布局行为。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

/** 确定性的宽度：每字 10px。 */
function measure(text: string, style: RichTextStyle): number {
  return Array.from(text).length * style.fontSize;
}

const base = { fontWeight: 400, fontStyle: "normal" as const, fontSize: 10, lineHeight: 20, letterSpacing: 0, measure };

test("shifts a list paragraph to the right of the marker area", () => {
  const lines = layoutRichText({
    ...base,
    text: "a\nb",
    paragraphStyles: [{ from: 0, to: 1, style: { listType: "bullet", indent: 1 } }],
  });
  // 左偏移 = 级别缩进 + 标记区宽度。
  assert.equal(lines[0]!.left, LIST_INDENT_STEP + LIST_MARKER_WIDTH);
  assert.equal(lines[0]!.markerWidth, LIST_MARKER_WIDTH);
  assert.equal(lines[0]!.marker, "•");
  // 第二段不是列表项：没有偏移，也没有标记。
  assert.equal(lines[1]!.left, 0);
  assert.equal(lines[1]!.markerWidth, 0);
  assert.equal(lines[1]!.marker, undefined);
});

test("puts the marker only on the first line of a wrapped paragraph", () => {
  const lines = layoutRichText({
    ...base,
    text: "aaaaaa",
    paragraphStyles: [{ from: 0, to: 6, style: { listType: "bullet" } }],
    availableWidth: 50,
  });
  // 缩进吃掉 20px → 每行 3 个字。
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.marker, "•");
  assert.equal(lines[1]!.marker, undefined);
  // 折行后的行与首行文字左对齐。
  assert.equal(lines[1]!.left, lines[0]!.left);
});

test("the indent eats into the available width so the text wraps earlier", () => {
  const plain = layoutRichText({ ...base, text: "aaaaaaaaaa", availableWidth: 100 });
  assert.equal(plain.length, 1);
  const indented = layoutRichText({
    ...base,
    text: "aaaaaaaaaa",
    paragraphStyles: [{ from: 0, to: 10, style: { listType: "bullet", indent: 1 } }],
    availableWidth: 100,
  });
  // 可用宽度少了 44px → 10 个字放不下，需要两行。
  assert.equal(indented.length, 2);
  assert.equal(indented[0]!.left, LIST_INDENT_STEP + LIST_MARKER_WIDTH);
});

test("the number marker follows the ordered numbering of the schema layer", () => {
  const lines = layoutRichText({
    ...base,
    text: "a\nb\nc",
    paragraphStyles: [{ from: 0, to: 5, style: { listType: "ordered" } }],
  });
  assert.deepEqual(lines.map(line => line.marker), ["1.", "2.", "3."]);
});

test("measureRichText counts the indent in the width", () => {
  const measured = measureRichText({
    ...base,
    text: "ab",
    paragraphStyles: [{ from: 0, to: 2, style: { listType: "bullet", indent: 1 } }],
  });
  // 文字宽 20 + 左偏移 44。
  assert.equal(measured.width, 20 + LIST_INDENT_STEP + LIST_MARKER_WIDTH);
  assert.equal(measured.height, 20);
  assert.equal(measured.lineCount, 1);
});

test("a paragraph style does not change plain paragraphs", () => {
  const lines = layoutRichText({
    ...base,
    text: "ab\ncd",
    paragraphStyles: [{ from: 3, to: 5, style: { listType: "bullet" } }],
  });
  assert.equal(lines[0]!.left, 0);
  assert.equal(lines[0]!.marker, undefined);
  assert.equal(lines[1]!.left, LIST_MARKER_WIDTH);
  assert.equal(lines[1]!.marker, "•");
});

test("keeps the paragraph index on every line", () => {
  const lines = layoutRichText({ ...base, text: "aa\naa", availableWidth: 15 });
  // 每行放得下一个字 → 每段两行，段落序号跟着走。
  assert.deepEqual(lines.map(line => line.paragraphIndex), [0, 0, 1, 1]);
});
