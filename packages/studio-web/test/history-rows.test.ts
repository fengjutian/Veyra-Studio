import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionEntry } from "@ufira/design-runtime";
import { commandSummary, historyRows } from "../src/history-rows";

function entry(revision: number, commands: Array<{ type: string }>, actorType: TransactionEntry["actor"]["type"] = "human"): TransactionEntry {
  return {
    commandId: `cmd:${revision}`,
    documentId: "project:1",
    revision,
    committedAt: "2026-11-06T10:00:00.000Z",
    actor: { type: actorType, id: "local-user" },
    commands: commands as TransactionEntry["commands"],
    warnings: [],
  };
}

test("命令翻译成人话，同名命令合并计数", () => {
  assert.equal(commandSummary([{ type: "node.create" }, { type: "node.create" }]), "新建节点 ×2");
  assert.equal(commandSummary([{ type: "node.create" }, { type: "text.patch" }]), "新建节点、修改文本");
  assert.equal(commandSummary([]), "空事务");
});

test("认不出来的命令保留原始类型名，不让面板变空", () => {
  assert.equal(commandSummary([{ type: "future.command" }]), "future.command");
});

test("命令种类很多时只列前三项并给出总数", () => {
  const summary = commandSummary([
    { type: "node.create" },
    { type: "node.patch" },
    { type: "text.patch" },
    { type: "page.create" },
  ]);
  assert.match(summary, /新建节点、修改节点、修改文本/);
  assert.match(summary, /等 4 项/);
});

test("操作历史按修订号从新到旧，只保留最近几条", () => {
  const rows = historyRows([entry(1, [{ type: "node.create" }]), entry(3, [{ type: "text.patch" }]), entry(2, [{ type: "node.patch" }])], 3, { limit: 2 });

  assert.deepEqual(rows.map(row => row.revision), [3, 2]);
  assert.equal(rows[0]?.label, "r3");
});

test("最新一条不可回退，其余可以", () => {
  const rows = historyRows([entry(1, [{ type: "node.create" }]), entry(2, [{ type: "node.patch" }])], 2);
  assert.deepEqual(rows.map(row => row.restorable), [false, true]);
});

test("早于保留快照的步骤不再提供回退，但记录仍在", () => {
  const rows = historyRows([entry(1, [{ type: "node.create" }]), entry(5, [{ type: "node.patch" }])], 6, { oldestSnapshotRevision: 3 });
  assert.deepEqual(rows.map(row => row.revision), [5, 1]);
  assert.equal(rows[1]?.restorable, false);
  assert.equal(rows[0]?.restorable, true);
});

test("还原类事务单独标出来，AI 和本地用户的署名不同", () => {
  const rows = historyRows([
    entry(2, [{ type: "history.restore" }]),
    entry(1, [{ type: "node.create" }], "ai"),
  ], 3);

  assert.equal(rows[0]?.kind, "restore");
  assert.equal(rows[1]?.actor, "AI");
  assert.equal(historyRows([entry(1, [{ type: "node.create" }])], 2)[0]?.actor, "本地用户");
});
