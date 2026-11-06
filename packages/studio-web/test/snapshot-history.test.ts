import assert from "node:assert/strict";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { createDocument, defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { StudioProject } from "@ufira/studio-application";
import { DexieProjectRepository } from "../src/browser-repository";
import { formatSnapshotTime, restoreConfirmation, restoreSnapshotEnvelope, snapshotRows } from "../src/snapshot-history";

test("版本摘要变成面板上的行，只有旧版本可以还原", () => {
  const rows = snapshotRows([
    { revision: 2, updatedAt: "2026-11-05T00:00:02.000Z", schemaVersion: 2, current: true },
    { revision: 1, updatedAt: "2026-11-05T00:00:01.000Z", schemaVersion: 2, current: false },
  ]);
  assert.deepEqual(rows.map(row => row.label), ["r2", "r1"]);
  assert.deepEqual(rows.map(row => row.current), [true, false]);
  assert.deepEqual(rows.map(row => row.restorable), [false, true]);
});

test("还原命令沿用当前修订号，并指向同一个项目", () => {
  const current = createDocument("project:1", "现在");
  current.revision = 7;
  const snapshot = createDocument("project:1", "以前");
  snapshot.revision = 3;

  const envelope = restoreSnapshotEnvelope(current, snapshot);
  assert.equal(envelope.documentId, "project:1");
  assert.equal(envelope.baseRevision, 7);
  assert.equal(envelope.actor.type, "human");
  assert.equal(envelope.commands[0]?.type, "history.restore");
  assert.equal(envelope.commands[0]?.payload.document.meta.name, "以前");
});

test("拒绝把别的项目的快照还原到当前项目", () => {
  assert.throws(() => restoreSnapshotEnvelope(createDocument("project:1", "现在"), createDocument("project:2", "别的")), /不是同一个项目/);
});

test("版本时间按年月时分显示，认不出来就原样返回", () => {
  assert.match(formatSnapshotTime("2026-11-05T08:09:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatSnapshotTime("不是时间"), "不是时间");
});

test("还原确认说明回到哪一版，也说明能不能撤销", () => {
  const row = snapshotRows([{ revision: 3, updatedAt: "2026-11-05T00:00:03.000Z", schemaVersion: 2, current: false }])[0]!;
  const confirmation = restoreConfirmation(row);
  assert.match(confirmation.title, /r3/);
  assert.match(confirmation.description, /撤销/);
});

test("还原历史版本会把内容退回旧版，修订号继续往前走", async t => {
  const repository = new DexieProjectRepository({ databaseName: `restore-${crypto.randomUUID()}`, indexedDB, IDBKeyRange });
  t.after(() => repository.deleteDatabase());

  const project = await StudioProject.create(repository, "project:1", "Demo", "page:1");
  await project.execute(createEnvelope(0, frame("frame:1")));
  await project.execute(createEnvelope(1, frame("frame:2")));

  const versions = await repository.listSnapshots("project:1");
  assert.deepEqual(versions.map(item => item.revision), [2, 1, 0]);

  const original = await repository.readSnapshot("project:1", 0);
  assert.equal(original.nodes["frame:1"], undefined);

  await project.execute(restoreSnapshotEnvelope(project.snapshot(), original));

  const restored = project.snapshot();
  assert.equal(restored.revision, 3);
  assert.equal(restored.nodes["frame:1"], undefined);
  assert.equal(restored.nodes["frame:2"], undefined);

  // 还原本身也进了事务日志，所以它自己还能被撤销回去。
  const journal = await repository.listTransactions("project:1");
  assert.equal(journal.at(-1)?.commands[0]?.type, "history.restore");

  // 还原之后，它自己成了新的当前版本。
  const after = await repository.listSnapshots("project:1");
  assert.deepEqual(after.map(item => item.revision), [3, 2, 1]);
  assert.equal(after[0]?.current, true);
});

test("还原之后可以撤销回去", async t => {
  const repository = new DexieProjectRepository({ databaseName: `undo-restore-${crypto.randomUUID()}`, indexedDB, IDBKeyRange });
  t.after(() => repository.deleteDatabase());

  const project = await StudioProject.create(repository, "project:1", "Demo", "page:1");
  await project.execute(createEnvelope(0, frame("frame:1")));
  const original = await repository.readSnapshot("project:1", 0);
  await project.execute(restoreSnapshotEnvelope(project.snapshot(), original));
  assert.equal(project.snapshot().nodes["frame:1"], undefined);

  await project.undo();
  assert.ok(project.snapshot().nodes["frame:1"]);
  assert.equal(project.snapshot().revision, 3);
});

function createEnvelope(baseRevision: number, node: DesignNode) {
  return {
    commandId: `cmd:${baseRevision + 1}`,
    documentId: "project:1",
    baseRevision,
    actor: { type: "human" as const, id: "user:1" },
    commands: [{ type: "node.create" as const, payload: { node } }],
  };
}

function frame(id: string): DesignNode {
  return { id, type: "frame", name: id, parentId: "page:1", childIds: [], visible: true, locked: false, layout: defaultLayout(), appearance: defaultAppearance() };
}
