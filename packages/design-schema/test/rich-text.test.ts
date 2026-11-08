import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTextRunStyle,
  clampTextRuns,
  createDocument,
  defaultAppearance,
  defaultLayout,
  remapTextRuns,
  textRunSegments,
  validateDocument,
  validateTextRuns,
  type DesignDocument,
  type TextNode,
} from "../src/index";

function documentWithText(overrides: Partial<TextNode> = {}): DesignDocument {
  const document = createDocument("doc:rich", "富文本", "page:1");
  const node = {
    id: "text:1",
    type: "text",
    name: "标题",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 200, height: 40 },
    appearance: defaultAppearance(),
    text: "abcdef",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
    ...overrides,
  } as TextNode;
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

test("accepts sorted, non-overlapping runs inside the text", () => {
  assert.equal(validateTextRuns("abcdef", [
    { from: 0, to: 2, style: { fontWeight: 700 } },
    { from: 4, to: 6, style: { color: "#ef4444" } },
  ]), undefined);
  assert.equal(validateTextRuns("abcdef", []), undefined);
  assert.equal(validateTextRuns("abcdef", undefined), undefined);
});

test("rejects runs that leave the text, overlap, or set no style", () => {
  assert.match(validateTextRuns("abcdef", [{ from: 4, to: 9, style: { fontWeight: 700 } }]) ?? "", /inside the text/);
  assert.match(validateTextRuns("abcdef", [{ from: 0, to: 3, style: { fontWeight: 700 } }, { from: 2, to: 4, style: { fontStyle: "italic" } }]) ?? "", /overlaps/);
  assert.match(validateTextRuns("abcdef", [{ from: 3, to: 3, style: { fontWeight: 700 } }]) ?? "", /smaller than/);
  assert.match(validateTextRuns("abcdef", [{ from: 0, to: 2, style: {} }]) ?? "", /at least one field/);
  assert.match(validateTextRuns("abcdef", [{ from: 0, to: 2, style: { fontWeight: 950 } }]) ?? "", /between 100 and 900/);
});

test("refuses to split a surrogate pair", () => {
  // "a😀b"：😀 占两个 UTF-16 单元，下标 1–3 才是完整字符。
  assert.equal(validateTextRuns("a😀b", [{ from: 1, to: 3, style: { fontWeight: 700 } }]), undefined);
  assert.match(validateTextRuns("a😀b", [{ from: 1, to: 2, style: { fontWeight: 700 } }]) ?? "", /surrogate/);
});

test("applyTextRunStyle splits an existing run so ranges never overlap", () => {
  const runs = [{ from: 0, to: 6, style: { color: "#111111" } }];
  const next = applyTextRunStyle("abcdef", runs, 2, 4, { fontWeight: 700 });
  assert.deepEqual(next, [
    { from: 0, to: 2, style: { color: "#111111" } },
    { from: 2, to: 4, style: { fontWeight: 700 } },
    { from: 4, to: 6, style: { color: "#111111" } },
  ]);
  assert.equal(validateTextRuns("abcdef", next), undefined);
});

test("applyTextRunStyle with an empty style clears the range", () => {
  const runs = [
    { from: 0, to: 2, style: { fontWeight: 700 } },
    { from: 4, to: 6, style: { color: "#ef4444" } },
  ];
  assert.deepEqual(applyTextRunStyle("abcdef", runs, 0, 2, {}), [
    { from: 4, to: 6, style: { color: "#ef4444" } },
  ]);
  // 清掉相邻两段后应合并成一段，而不是留下两个同款相邻区间。
  assert.deepEqual(applyTextRunStyle("abcdef", [{ from: 0, to: 2, style: { fontWeight: 700 } }], 2, 6, { fontWeight: 700 }), [
    { from: 0, to: 6, style: { fontWeight: 700 } },
  ]);
});

test("clampTextRuns trims runs after the text shrinks", () => {
  const runs = [
    { from: 0, to: 2, style: { fontWeight: 700 } },
    { from: 4, to: 6, style: { color: "#ef4444" } },
  ];
  assert.deepEqual(clampTextRuns("abcd", runs), [{ from: 0, to: 2, style: { fontWeight: 700 } }]);
  assert.deepEqual(clampTextRuns("abc", runs), [{ from: 0, to: 2, style: { fontWeight: 700 } }]);
  assert.deepEqual(clampTextRuns("ab", runs), [{ from: 0, to: 2, style: { fontWeight: 700 } }]);
});

test("remapTextRuns shifts runs after an insertion instead of leaving them behind", () => {
  const runs = [
    { from: 0, to: 2, style: { fontWeight: 700 } },
    { from: 3, to: 5, style: { color: "#ef4444" } },
  ];
  assert.deepEqual(remapTextRuns("abcdef", "XYabcdef", runs), [
    { from: 2, to: 4, style: { fontWeight: 700 } },
    { from: 5, to: 7, style: { color: "#ef4444" } },
  ]);
  // 删掉尾部：落在删除区里的区间消失，前面的区间原地不动。
  assert.deepEqual(remapTextRuns("abcdef", "abc", runs), [
    { from: 0, to: 2, style: { fontWeight: 700 } },
  ]);
  // 整段被删空：区间随之消失，而不是留下越界数据。
  assert.deepEqual(remapTextRuns("abcdef", "", runs), []);
});

test("segments cover the whole text, gaps inherit the node style", () => {
  const segments = textRunSegments("abcdef", [
    { from: 1, to: 3, style: { fontWeight: 700 } },
  ]);
  assert.deepEqual(segments.map(segment => [segment.text, segment.style.fontWeight ?? null]), [
    ["a", null],
    ["bc", 700],
    ["def", null],
  ]);
  assert.deepEqual(textRunSegments("", undefined), []);
});

test("document validation accepts rich text and rejects a broken range", () => {
  const valid = documentWithText({ runs: [{ from: 0, to: 3, style: { fontWeight: 700 } }] });
  assert.deepEqual(validateDocument(valid), valid);

  const invalid = documentWithText({ runs: [{ from: 2, to: 9, style: { fontWeight: 700 } }] });
  assert.throws(() => validateDocument(invalid), /inside the text/);
});
