import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

/**
 * 段落样式命令的运行时行为。
 *
 * 规格见 `docs/paragraph-styles.md`。
 */

const frame = (id: string, parentId = "page:1"): DesignNode => ({
  id,
  type: "frame",
  name: id,
  parentId,
  childIds: [],
  visible: true,
  locked: false,
  layout: defaultLayout(),
  appearance: defaultAppearance(),
});

const text = (id: string, parentId: string, content: string): DesignNode => ({
  ...frame(id, parentId),
  type: "text",
  text: content,
  fontFamily: "Inter",
  fontSize: 16,
  lineHeight: 24,
});

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

/** 建一个只含一个文本节点的运行时。 */
function textRuntime(content: string): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: text("label", "page:1", content) } },
  ]));
  return runtime;
}

function paragraphStylesOf(runtime: DesignRuntime): unknown {
  const node = runtime.snapshot().nodes["label"] as any;
  return node.paragraphStyles;
}

test("sets a list type on the paragraph the selection touches", () => {
  const runtime = textRuntime("a\nb\nc");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 3, style: { listType: "bullet" } } },
  ]));
  // 选区覆盖前两段，两段都变成列表项（相邻同款合并成一条记录）。
  assert.deepEqual(paragraphStylesOf(runtime), [{ from: 0, to: 3, style: { listType: "bullet" } }]);
});

test("snaps the range to whole paragraphs", () => {
  const runtime = textRuntime("a\nb\nc");
  // 选区落在第二段中间：整段生效。
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 3, to: 3, style: { listType: "ordered" } } },
  ]));
  assert.deepEqual(paragraphStylesOf(runtime), [{ from: 2, to: 3, style: { listType: "ordered" } }]);
});

test("keeps the list type when only the indent changes", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet" } } },
  ]));
  runtime.execute(envelope(2, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { indent: 2 } } },
  ]));
  assert.deepEqual(paragraphStylesOf(runtime), [{ from: 0, to: 1, style: { listType: "bullet", indent: 2 } }]);
});

test("removes the list and the indent together", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet", indent: 1 } } },
  ]));
  runtime.execute(envelope(2, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "none" } } },
  ]));
  // 样式被清空后字段直接删掉，不留空数组。
  assert.equal(paragraphStylesOf(runtime), undefined);
});

test("applies the indent delta relative to each paragraph's own level", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet" } } },
    { type: "text.paragraph.set", payload: { id: "label", from: 2, to: 3, style: { listType: "bullet", indent: 1 } } },
  ]));
  runtime.execute(envelope(2, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 3, style: { indentDelta: 1 } } },
  ]));
  assert.deepEqual(paragraphStylesOf(runtime), [
    { from: 0, to: 1, style: { listType: "bullet", indent: 1 } },
    { from: 2, to: 3, style: { listType: "bullet", indent: 2 } },
  ]);
});

test("remaps the paragraph styles when the text changes", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 2, to: 3, style: { listType: "bullet" } } },
  ]));
  // 在第一段前面插入一个字：段落结构不变，列表样式跟着平移。
  runtime.execute(envelope(2, [
    { type: "text.patch", payload: { id: "label", patch: { text: "x\na\nb" } } },
  ]));
  assert.deepEqual(paragraphStylesOf(runtime), [{ from: 4, to: 5, style: { listType: "bullet" } }]);
});

test("drops the paragraph style when the paragraph it covered is deleted", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 2, to: 3, style: { listType: "bullet" } } },
  ]));
  runtime.execute(envelope(2, [
    { type: "text.patch", payload: { id: "label", patch: { text: "a" } } },
  ]));
  assert.equal(paragraphStylesOf(runtime), undefined);
});

test("keeps the paragraph styles aligned when the runs are patched together with the text", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet" } } },
  ]));
  // 画布内联编辑提交时 text 与 runs 一起给：段落样式仍然要跟着文本走，
  // 否则区间不再对齐段落边界，文档直接不合法。
  runtime.execute(envelope(2, [
    { type: "text.patch", payload: { id: "label", patch: { text: "x\na\nb", runs: [] } } },
  ]));
  assert.deepEqual(paragraphStylesOf(runtime), [{ from: 2, to: 3, style: { listType: "bullet" } }]);
});

test("rejects an invalid list type", () => {
  const runtime = textRuntime("a");
  assert.throws(() => runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "dashed" } } },
  ])), /listType must be bullet, ordered or none/);
});

test("rejects an out-of-range indent level", () => {
  const runtime = textRuntime("a");
  assert.throws(() => runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet", indent: 9 } } },
  ])), /indent must be an integer between 0 and 4/);
});

test("rejects a range outside the text", () => {
  const runtime = textRuntime("a");
  assert.throws(() => runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 99, style: { listType: "bullet" } } },
  ])), /must fall inside the text/);
});

test("rejects an empty style payload", () => {
  const runtime = textRuntime("a");
  assert.throws(() => runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: {} } },
  ])), /must set listType, indent, indentDelta, paragraphIndent, hanging or listSpacing/);
});

test("undoes the paragraph style change", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet" } } },
  ]));
  runtime.undo({ commandId: "undo:1", actor: { type: "human", id: "user:1" }, committedAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(paragraphStylesOf(runtime), undefined);
});
