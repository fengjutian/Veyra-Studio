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
  assert.deepEqual(rows.map(row => row.current), [true, false]);
});

test("起点接不上日志时不再提供回退，但记录仍在", () => {
  // 日志只剩 r1 和 r5，中间断了：从起点 r3 重放不到 r5，这一步就回不去。
  const rows = historyRows([entry(1, [{ type: "node.create" }]), entry(5, [{ type: "node.patch" }])], 6, { baseRevisions: [3] });
  assert.deepEqual(rows.map(row => row.revision), [5, 1]);
  assert.deepEqual(rows.map(row => row.restorable), [false, false]);
});

test("有重建基线时，早于最老快照的步骤也能回退", () => {
  // 基线 r0 加上连续日志：日志窗口里的每一版都能重建出来。
  const entries = [1, 2, 3, 4, 5].map(revision => entry(revision, [{ type: "node.patch" }]));
  const rows = historyRows(entries, 6, { baseRevisions: [0, 5] });
  assert.deepEqual(rows.map(row => row.revision), [5, 4, 3, 2, 1]);
  assert.deepEqual(rows.map(row => row.restorable), [true, true, true, true, true]);
});

test("日志被裁掉的那一段回退不了", () => {
  // 日志只剩 r4、r5：从基线 r0 重放不到 r4，只有正好是起点的那一版还能回退。
  const entries = [4, 5].map(revision => entry(revision, [{ type: "node.patch" }]));
  const rows = historyRows(entries, 6, { baseRevisions: [0, 5] });
  assert.deepEqual(rows.map(row => row.revision), [5, 4]);
  assert.deepEqual(rows.map(row => row.restorable), [true, false]);
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
