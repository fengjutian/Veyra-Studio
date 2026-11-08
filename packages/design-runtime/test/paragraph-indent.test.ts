import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

/**
 * 段落缩进 / 悬挂列表 / 列表间距命令的运行时行为。
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

test("sets the paragraph indent, the hanging flag and the list spacing", () => {
  const runtime = textRuntime("a\nb");
  runtime.execute(envelope(1, [
    { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listType: "bullet" } } },
  ]));
  runtime.execute(envelope(2, [
    {
      type: "text.paragraph.set",
      payload: { id: "label", from: 0, to: 1, style: { paragraphIndent: 24, hanging: true, listSpacing: 8 } },
    },
  ]));
  assert.deepEqual(paragraphStylesOf(runtime), [{
    from: 0,
    to: 1,
    style: { listType: "bullet", paragraphIndent: 24, hanging: true, listSpacing: 8 },
  }]);
});

test("rejects a negative paragraph indent", () => {
  const runtime = textRuntime("a");
  assert.throws(
    () => runtime.execute(envelope(1, [
      { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { paragraphIndent: -1 } } },
    ])),
    /non-negative/,
  );
});

test("rejects a negative list spacing", () => {
  const runtime = textRuntime("a");
  assert.throws(
    () => runtime.execute(envelope(1, [
      { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { listSpacing: -4 } } },
    ])),
    /non-negative/,
  );
});

test("rejects a hanging flag that is not a boolean", () => {
  const runtime = textRuntime("a");
  assert.throws(
    () => runtime.execute(envelope(1, [
      { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { hanging: "yes" } } },
    ])),
    /must be a boolean/,
  );
});

test("rejects a style payload that changes nothing", () => {
  const runtime = textRuntime("a");
  assert.throws(
    () => runtime.execute(envelope(1, [
      { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: {} } },
    ])),
    /Paragraph style must set/,
  );
});

test("a hanging flag on a paragraph without a list is rejected by the document validation", () => {
  const runtime = textRuntime("a");
  assert.throws(
    () => runtime.execute(envelope(1, [
      { type: "text.paragraph.set", payload: { id: "label", from: 0, to: 1, style: { hanging: true } } },
    ])),
    /listType/,
  );
});
