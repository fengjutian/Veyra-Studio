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
  assert.equal(runtime.undo().nodes["node:1"], undefined);
  assert.ok(runtime.redo().nodes["node:1"]);
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

test("returns structural warnings without blocking a valid change", () => {
  const runtime = new DesignRuntime(createDocument("doc:1", "Demo"));
  const node = frame("node:1");
  node.appearance.fill = "#ff0000";
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
