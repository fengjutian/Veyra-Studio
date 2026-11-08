import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { CommandError, DesignRuntime, RevisionConflictError } from "../src/index";

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

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

test("executes an atomic create transaction", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const result = runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("node:1") } }]));
  assert.equal(result.revision, 1);
  assert.deepEqual(runtime.snapshot().pages["page:1"].childIds, ["node:1"]);
});

test("rejects stale revisions without changing the document", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  assert.throws(() => runtime.execute(envelope(2, [{ type: "node.create", payload: { node: frame("node:1") } }])), RevisionConflictError);
  assert.equal(runtime.snapshot().revision, 0);
});

test("rolls back the whole transaction when one command fails", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  assert.throws(() => runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("node:1") } },
    { type: "node.create", payload: { node: frame("node:1") } },
  ])), CommandError);
  assert.deepEqual(runtime.snapshot().nodes, {});
});

test("undoes and redoes a transaction", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("node:1") } }]));
  const undone = runtime.undo({ commandId: "undo:1", actor: { type: "human", id: "user:1" }, committedAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(runtime.snapshot().nodes["node:1"], undefined);
  assert.equal(undone.revision, 2);
  const redone = runtime.redo({ commandId: "redo:1", actor: { type: "human", id: "user:1" }, committedAt: "2026-01-01T00:00:02.000Z" });
  assert.ok(runtime.snapshot().nodes["node:1"]);
  assert.equal(redone.revision, 3);
  assert.deepEqual(runtime.transactionLog().map(entry => entry.commands[0]?.type), ["node.create", "history.restore", "history.restore"]);
});

test("prevents reparenting into a descendant", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("parent") } },
    { type: "node.create", payload: { node: frame("child", "parent") } },
  ]));
  assert.throws(() => runtime.execute(envelope(1, [
    { type: "node.reparent", payload: { id: "parent", parentId: "child" } },
  ])), /descendant/);
});

test("reorders a node when reparenting within the same container", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("bottom") } },
    { type: "node.create", payload: { node: frame("middle") } },
    { type: "node.create", payload: { node: frame("top") } },
  ]));
  const result = runtime.execute(envelope(1, [
    { type: "node.reparent", payload: { id: "bottom", parentId: "page:1", index: 2 } },
  ]));
  assert.deepEqual(result.changes.after.pages["page:1"]?.childIds, ["middle", "top", "bottom"]);
});

test("returns structural warnings without blocking a valid change", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const node = frame("node:1");
  node.appearance.fills = [{ type: "solid", color: "#ff0000" }];
  const result = runtime.execute(envelope(0, [{ type: "node.create", payload: { node } }]));
  assert.match(result.warnings[0], /hardcoded fill/);
});

test("records committed transactions but not failed attempts", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("node:1") } }]));
  assert.throws(() => runtime.execute(envelope(0, [{ type: "node.delete", payload: { id: "node:1" } }])), RevisionConflictError);
  assert.equal(runtime.transactionLog().length, 1);
  assert.equal(runtime.transactionLog()[0].revision, 1);
});

test("manages pages without allowing the last or a non-empty page to be deleted", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "page.create", payload: { page: { id: "page:2", name: "Second", childIds: [] } } }]));
  runtime.execute(envelope(1, [{ type: "page.rename", payload: { id: "page:2", name: "Renamed" } }]));
  assert.equal(runtime.snapshot().pages["page:2"].name, "Renamed");
  runtime.execute(envelope(2, [{ type: "page.delete", payload: { id: "page:2" } }]));
  assert.throws(() => runtime.execute(envelope(3, [{ type: "page.delete", payload: { id: "page:1" } }])), /at least one page/);
});

test("protects tokens that are still bound", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const node = frame("node:1");
  node.bindings = { fill: "color.primary" };
  runtime.execute(envelope(0, [
    { type: "token.upsert", payload: { name: "color.primary", token: { type: "color", value: "#3366ff" } } },
    { type: "node.create", payload: { node } },
  ]));
  assert.throws(() => runtime.execute(envelope(1, [{ type: "token.delete", payload: { name: "color.primary" } }])), /still bound/);
});

test("defines a component and creates an instance through domain commands", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const root = frame("component:root");
  root.type = "component";
  const instance: DesignNode = {
    ...frame("instance:1"),
    type: "instance",
    componentId: "component:button",
    overrides: {},
  };
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: root } },
    { type: "component.define", payload: { component: { id: "component:button", name: "Button", rootNodeId: root.id } } },
    { type: "component.instantiate", payload: { node: instance } },
  ]));
  assert.equal(runtime.snapshot().nodes[instance.id].type, "instance");
  assert.throws(() => runtime.execute(envelope(1, [{ type: "component.remove", payload: { id: "component:button" } }])), /still used/);
});

test("renames a document through a revisioned domain command", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Before", "page:1"));
  runtime.execute({ commandId: "rename:1", documentId: "doc:1", baseRevision: 0, actor: { type: "human", id: "user:1" }, commands: [{ type: "document.rename", payload: { name: "After" } }] });
  assert.equal(runtime.snapshot().meta.name, "After");
  assert.equal(runtime.snapshot().revision, 1);
  assert.throws(() => runtime.execute({ commandId: "rename:2", documentId: "doc:1", baseRevision: 1, actor: { type: "human", id: "user:1" }, commands: [{ type: "document.rename", payload: { name: "  " } }] }), /cannot be empty/);
});

test("patches text content and typography only on text nodes", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  const runtime = new DesignRuntime(document);
  const text: DesignNode = { ...frame("text:1"), type: "text", text: "Before", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: text } }]));
  runtime.execute(envelope(1, [{ type: "text.patch", payload: { id: text.id, patch: { text: "After", fontSize: 20, lineHeight: 28 } } }]));
  const updated = runtime.snapshot().nodes[text.id];
  assert.equal(updated?.type === "text" && updated.text, "After");
  assert.equal(updated?.type === "text" && updated.fontSize, 20);
  assert.throws(() => runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: text.id, patch: { fontSize: 0 } } }])), /must be positive/);
});

test("patches the text style fields and rejects invalid ones", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  const runtime = new DesignRuntime(document);
  const text: DesignNode = { ...frame("text:1"), type: "text", text: "Hello", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: text } }]));
  runtime.execute(envelope(1, [{ type: "text.patch", payload: { id: text.id, patch: { fontWeight: 700, fontStyle: "italic", textAlign: "center", letterSpacing: 1.5 } } }]));
  const updated = runtime.snapshot().nodes[text.id];
  assert.equal(updated?.type === "text" && updated.fontWeight, 700);
  assert.equal(updated?.type === "text" && updated.fontStyle, "italic");
  assert.equal(updated?.type === "text" && updated.textAlign, "center");
  assert.equal(updated?.type === "text" && updated.letterSpacing, 1.5);
  // A rejected command must not advance the revision, so both failures share the same base.
  assert.throws(() => runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: text.id, patch: { fontWeight: 95 } } }])), /Font weight/);
  assert.throws(() => runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: text.id, patch: { textAlign: "justify" } } }])), /Text align/);
  assert.throws(() => runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: text.id, patch: { fontStyle: "oblique" as never } } }])), /Font style/);
});

test("validates rich text runs and trims them when the text changes", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo", "page:1"));
  const text: DesignNode = { ...frame("text:1"), type: "text", text: "abcdef", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: text } }]));
  runtime.execute(envelope(1, [{ type: "text.patch", payload: { id: text.id, patch: { runs: [{ from: 0, to: 4, style: { fontWeight: 700 } }] } } }]));
  const styled = runtime.snapshot().nodes[text.id];
  assert.deepEqual(styled?.type === "text" ? styled.runs : undefined, [{ from: 0, to: 4, style: { fontWeight: 700 } }]);

  // 越界区间被命令层拒绝，且不推进 revision（下一次仍可基于 2 提交）。
  assert.throws(
    () => runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: text.id, patch: { runs: [{ from: 4, to: 99, style: { fontWeight: 700 } }] } } }])),
    /inside the text/,
  );

  // 只改文字、没给新 runs：旧偏移按「公共前后缀」平移/截断，而不是指到随机位置。
  runtime.execute(envelope(2, [{ type: "text.patch", payload: { id: text.id, patch: { text: "abc" } } }]));
  const trimmed = runtime.snapshot().nodes[text.id];
  assert.deepEqual(trimmed?.type === "text" ? trimmed.runs : undefined, [{ from: 0, to: 3, style: { fontWeight: 700 } }]);

  // 段首插入：加粗区间整体后移，仍覆盖原来那几个字。
  runtime.execute(envelope(3, [{ type: "text.patch", payload: { id: text.id, patch: { text: "XYabc" } } }]));
  const shifted = runtime.snapshot().nodes[text.id];
  assert.deepEqual(shifted?.type === "text" ? shifted.runs : undefined, [{ from: 2, to: 5, style: { fontWeight: 700 } }]);

  // 空数组表示清空覆盖，字段本身也不该留在文档里。
  runtime.execute(envelope(4, [{ type: "text.patch", payload: { id: text.id, patch: { runs: [] } } }]));
  const cleared = runtime.snapshot().nodes[text.id];
  assert.equal(cleared?.type === "text" ? cleared.runs : "missing", undefined);
});

test("patches a vector path together with its layout", () => {  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const vector: DesignNode = { ...frame("vector:1"), type: "vector", geometry: { kind: "path", d: "M 0 0 L 1 1" } };
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: vector } }]));
  runtime.execute(envelope(1, [{
    type: "vector.patch",
    payload: {
      id: "vector:1",
      patch: {
        geometry: { kind: "path", d: "M 0 0 C 0.2 0 0.8 1 1 1 Z" },
        layout: { ...defaultLayout(), x: 10, y: 20, width: 100, height: 80 },
      },
    },
  }]));
  const node = runtime.snapshot().nodes["vector:1"]!;
  assert.equal(node.type, "vector");
  assert.deepEqual(node.type === "vector" ? node.geometry : undefined, { kind: "path", d: "M 0 0 C 0.2 0 0.8 1 1 1 Z" });
  // 几何和盒子必须一起变：只改几何会让盒子不包含图形。
  assert.deepEqual([node.layout.x, node.layout.y, node.layout.width, node.layout.height], [10, 20, 100, 80]);
});

test("rejects vector patches on other node types and invalid paths", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("frame:1") } }]));
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "vector.patch", payload: { id: "frame:1", patch: { geometry: { kind: "path", d: "M 0 0 L 1 1" } } } }])),
    /not a vector node/,
  );
  const vector: DesignNode = { ...frame("vector:1"), type: "vector" };
  runtime.execute(envelope(1, [{ type: "node.create", payload: { node: vector } }]));
  assert.throws(
    () => runtime.execute(envelope(2, [{ type: "vector.patch", payload: { id: "vector:1", patch: { geometry: { kind: "path", d: "M 0 0 A 1 1 0 0 0 1 1" } } } }])),
    /is invalid/,
  );
});
test("only shapes can be used as a mask", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const text: DesignNode = { ...frame("t"), type: "text", text: "hi", fontFamily: "Inter", fontSize: 12, lineHeight: 16 };
  const rect: DesignNode = { ...frame("r"), type: "rectangle" };
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: text } },
    { type: "node.create", payload: { node: rect } },
  ]));
  assert.throws(() => runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "t", patch: { mask: true } } }])), /cannot be used as a mask/);
  runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "r", patch: { mask: true } } }]));
  assert.equal(runtime.snapshot().nodes["r"]!.mask, true);
});