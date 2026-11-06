import assert from "node:assert/strict";
import test from "node:test";
import { DesignRuntime } from "@ufira/design-runtime";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { copyNodeTrees, pasteNodeTrees } from "../src/node-clipboard";

test("copies selected trees once and pastes them as an atomic command list", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  const runtime = new DesignRuntime(document);
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: frame("parent", "page:1", 10, 20) } },
    { type: "node.create", payload: { node: frame("child", "parent", 2, 3) } },
  ]));

  const clipboard = copyNodeTrees(runtime.snapshot(), ["parent", "child"]);
  const pasted = pasteNodeTrees(clipboard, "page:1", 24, node => `copy:${node.id}`);
  const result = runtime.execute(envelope(1, pasted.commands));

  assert.deepEqual(pasted.rootIds, ["copy:parent"]);
  assert.equal(result.changes.after.nodes["copy:parent"]?.layout.x, 34);
  assert.equal(result.changes.after.nodes["copy:parent"]?.layout.y, 44);
  assert.equal(result.changes.after.nodes["copy:parent"]?.name, "parent 副本");
  assert.deepEqual(result.changes.after.nodes["copy:parent"]?.childIds, ["copy:child"]);
  assert.equal(result.changes.after.nodes["copy:child"]?.parentId, "copy:parent");
  assert.equal(result.changes.after.nodes["copy:child"]?.layout.x, 2);
});

test("preserves the order of multiple selected roots", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes.first = frame("first", "page:1", 0, 0);
  document.nodes.second = frame("second", "page:1", 0, 0);
  document.pages["page:1"]!.childIds = ["first", "second"];
  const clipboard = copyNodeTrees(document, ["second", "first"]);
  const pasted = pasteNodeTrees(clipboard, "page:1", 0, node => `new:${node.id}`);
  assert.deepEqual(pasted.rootIds, ["new:second", "new:first"]);
});

test("粘贴出来的根节点会被解锁，副本可以直接继续编辑", () => {
  const document = createDocument("doc:1", "Demo");
  const locked = { ...frame("locked", "page:1", 10, 10), locked: true, name: "锁定对象" };
  document.nodes.locked = locked;
  document.pages["page:1"]!.childIds = ["locked"];

  const clipboard = copyNodeTrees(document, ["locked"]);
  const pasted = pasteNodeTrees(clipboard, "page:1");
  const created = pasted.commands.find(command => command.type === "node.create");
  assert.equal(created?.type, "node.create");
  assert.equal(created.type === "node.create" ? created.payload.node.locked : undefined, false);
  assert.equal(created.type === "node.create" ? created.payload.node.name : undefined, "锁定对象 副本");
});

function envelope(baseRevision: number, commands: Parameters<DesignRuntime["execute"]>[0]["commands"]) {  return { commandId: crypto.randomUUID(), documentId: "doc:1", baseRevision, actor: { type: "human" as const, id: "test" }, commands };
}

function frame(id: string, parentId: string, x: number, y: number): DesignNode {
  return { id, type: "frame", name: id, parentId, childIds: [], visible: true, locked: false, layout: { ...defaultLayout(), x, y }, appearance: defaultAppearance() };
}
