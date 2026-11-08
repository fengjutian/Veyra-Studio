import assert from "node:assert/strict";
import test from "node:test";
import { createEstimateTextMeasurer, layoutRichText, measureRichText, type RichTextStyle } from "../src/index";
import { defaultAppearance, defaultLayout, type TextNode } from "@ufira/design-schema";

/** 确定性的宽度：常规 10px/字，加粗 12px/字。 */
function measure(text: string, style: RichTextStyle): number {
  return Array.from(text).length * (style.fontWeight >= 600 ? 12 : 10);
}

const base = { fontWeight: 400, fontStyle: "normal" as const, lineHeight: 20, letterSpacing: 0, measure };

test("breaks at the available width and keeps style runs intact", () => {
  const lines = layoutRichText({
    ...base,
    text: "abcdefgh",
    runs: [{ from: 0, to: 2, style: { fontWeight: 700 } }],
    availableWidth: 50,
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0]!.segments.map(segment => [segment.text, segment.style.fontWeight, segment.x]), [
    ["ab", 700, 0],
    ["cd", 400, 24],
  ]);
  assert.equal(lines[0]!.width, 44);
  assert.deepEqual(lines[1]!.segments.map(segment => segment.text), ["efgh"]);
});

test("prefers the last space so latin words are not cut in half", () => {
  const lines = layoutRichText({
    ...base,
    text: "aa bb cc",
    availableWidth: 35,
  });
  // 行尾空格不画出来，也不计入行宽。
  assert.deepEqual(lines.map(line => line.segments.map(segment => segment.text).join("")), ["aa", "bb", "cc"]);
});

test("a word longer than the line is broken by character", () => {
  const lines = layoutRichText({ ...base, text: "abcdefgh", availableWidth: 20 });
  assert.deepEqual(lines.map(line => line.segments.map(segment => segment.text).join("")), ["ab", "cd", "ef", "gh"]);
});

test("explicit newlines always break, including empty paragraphs", () => {
  const lines = layoutRichText({ ...base, text: "ab\n\ncd", availableWidth: 100 });
  assert.equal(lines.length, 3);
  assert.equal(lines[1]!.segments.length, 0);
  assert.equal(lines[1]!.width, 0);
});

test("letter spacing is added per character, including run boundaries", () => {
  const lines = layoutRichText({
    ...base,
    text: "abc",
    runs: [{ from: 1, to: 2, style: { fontWeight: 700 } }],
    letterSpacing: 1,
  });
  // a(10+1) + b(12+1) + c(10+1)
  assert.equal(lines[0]!.width, 35);
  assert.deepEqual(lines[0]!.segments.map(segment => segment.x), [0, 11, 24]);
});

test("measureRichText turns line count into height", () => {
  const measured = measureRichText({ ...base, text: "abcdefgh", availableWidth: 20 });
  assert.equal(measured.lineCount, 4);
  assert.equal(measured.height, 80);
  assert.equal(measured.width, 20);
});

test("the estimate measurer counts bold runs, so hug height reacts to rich text", () => {
  const measurer = createEstimateTextMeasurer();
  const node: TextNode = {
    id: "text:1",
    type: "text",
    name: "t",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 120, height: 40 },
    appearance: defaultAppearance(),
    text: "abcdefghijklmn",
    fontFamily: "Inter",
    fontSize: 10,
    lineHeight: 20,
  };

  const plain = measurer.measure(node, 40);
  const rich = measurer.measure({ ...node, runs: [{ from: 0, to: 14, style: { fontWeight: 700 } }] }, 40);
  // 常规 5.5px/字 → 7 字一行（2 行）；加粗 ×1.06 = 5.83px/字 → 6 字一行（3 行）。
  assert.equal(plain.height, 40);
  assert.equal(rich.height, 60);
});
