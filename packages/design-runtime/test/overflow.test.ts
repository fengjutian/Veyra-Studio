import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { CommandError, DesignRuntime } from "../src/index";

/**
 * `node.patch` 里的溢出模式（`overflow`）。
 *
 * 语义见 `docs/prototype-runtime.md` §8：缺省裁切不滚动，
 * `scroll` 在原型预览里可滚，`visible` 允许内容溢出到盒子外。
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

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

test("容器可以设置溢出模式", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("node:1") } }]));
  runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "node:1", patch: { overflow: "scroll" } } }]));
  assert.equal(runtime.snapshot().nodes["node:1"].overflow, "scroll");
});

test("非法取值被拒绝且文档不变", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("node:1") } }]));
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "node:1", patch: { overflow: "auto" as never } } }])),
    CommandError,
  );
  assert.equal(runtime.snapshot().nodes["node:1"].overflow, undefined);
});

test("非容器节点不能设置溢出模式", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const shape: DesignNode = { ...frame("node:1"), type: "rectangle" };
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: shape } }]));
  assert.throws(
    () => runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "node:1", patch: { overflow: "scroll" } } }])),
    CommandError,
  );
  assert.equal(runtime.snapshot().nodes["node:1"].overflow, undefined);
});

test("溢出模式可以撤销", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  runtime.execute(envelope(0, [{ type: "node.create", payload: { node: frame("node:1") } }]));
  runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "node:1", patch: { overflow: "visible" } } }]));
  runtime.undo({ commandId: "undo:1", actor: { type: "human", id: "user:1" }, committedAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(runtime.snapshot().nodes["node:1"].overflow, undefined);
});
