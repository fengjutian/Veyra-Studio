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
