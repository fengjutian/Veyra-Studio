import assert from "node:assert/strict";
import test from "node:test";
import { layoutRichText, measureRichText, type RichTextStyle } from "../src/index";
import { LIST_INDENT_STEP, LIST_MARKER_WIDTH } from "@ufira/design-schema";

/**
 * 段落缩进 / 悬挂列表 / 列表间距的布局行为。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

/** 确定性的宽度：每字 10px。 */
function measure(text: string, style: RichTextStyle): number {
  return Array.from(text).length * style.fontSize;
}

const base = { fontWeight: 400, fontStyle: "normal" as const, fontSize: 10, lineHeight: 20, letterSpacing: 0, measure };

test("the paragraph indent shifts the text and eats into the width", () => {
  const lines = layoutRichText({
    ...base,
    text: "aaaaaaaaaa",
    availableWidth: 100,
    paragraphStyles: [{ from: 0, to: 10, style: { paragraphIndent: 30 } }],
  });
  assert.equal(lines[0]!.left, 30);
  // 可用宽度少了 30px → 10 个字放不下，需要两行。
  assert.equal(lines.length, 2);
});

test("the paragraph indent only applies to left aligned text", () => {
  const centered = layoutRichText({
    ...base,
    text: "ab",
    align: "center",
    paragraphStyles: [{ from: 0, to: 2, style: { paragraphIndent: 30 } }],
  });
  // 居中时缩进被扣掉：左偏移回到 0。
  assert.equal(centered[0]!.left, 0);
  const left = layoutRichText({
    ...base,
    text: "ab",
    align: "left",
    paragraphStyles: [{ from: 0, to: 2, style: { paragraphIndent: 30 } }],
  });
  assert.equal(left[0]!.left, 30);
});

test("a hanging list gives the marker no width and keeps the body at the box edge", () => {
  const lines = layoutRichText({
    ...base,
    text: "ab",
    paragraphStyles: [{ from: 0, to: 2, style: { listType: "bullet", hanging: true } }],
  });
  assert.equal(lines[0]!.hanging, true);
  assert.equal(lines[0]!.markerWidth, 0);
  assert.equal(lines[0]!.left, 0);
  assert.equal(lines[0]!.marker, "•");
});

test("a hanging list keeps the level indent but not the marker width", () => {
  const lines = layoutRichText({
    ...base,
    text: "ab",
    paragraphStyles: [{ from: 0, to: 2, style: { listType: "bullet", indent: 1, hanging: true } }],
  });
  assert.equal(lines[0]!.left, LIST_INDENT_STEP);
  assert.equal(lines[0]!.markerWidth, 0);
  // 普通列表的标记区宽度不参与悬挂列表。
  assert.notEqual(lines[0]!.markerWidth, LIST_MARKER_WIDTH);
});

test("the list spacing pushes the following paragraph down", () => {
  const lines = layoutRichText({
    ...base,
    text: "ab\ncd",
    paragraphStyles: [{ from: 0, to: 2, style: { listSpacing: 10 } }],
  });
  // 第一段最后一行被撑高 10px，第二段因此整体下移。
  assert.equal(lines[0]!.height, 30);
  assert.equal(lines[1]!.height, 20);
  assert.equal(lines.length, 2);
});

test("the list spacing also applies to an empty paragraph", () => {
  const lines = layoutRichText({
    ...base,
    text: "ab\n\ncd",
    paragraphStyles: [{ from: 0, to: 2, style: { listSpacing: 10 } }],
  });
  assert.equal(lines.length, 3);
  // 间距加在第一段的最后一行上；空段落有自己的行高。
  assert.equal(lines[0]!.height, 30);
  assert.equal(lines[1]!.height, 20);
  assert.equal(lines[2]!.height, 20);
});

test("measureRichText counts the spacing in the height", () => {
  const measured = measureRichText({
    ...base,
    text: "ab\ncd",
    paragraphStyles: [{ from: 0, to: 2, style: { listSpacing: 10 } }],
  });
  // 两行 20px + 10px 间距。
  assert.equal(measured.height, 50);
});
