import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createDocument, type DesignDocument } from "@ufira/design-schema";
import { DesignRuntime, type TransactionEntry } from "@ufira/design-runtime";
import { ProjectNotFoundError, SNAPSHOT_RETENTION, SnapshotNotFoundError, type ProjectRepository } from "./contract";

/**
 * 仓库契约测试套件（node 环境专用）。
 *
 * 每个后端（文件系统、浏览器 IndexedDB）都必须通过同一组用例：同样的快照
 * 往返、同样的恢复与降级判定、同样的错误类型、同样的日志裁剪结果。
 * 只有这样，"统一仓库契约"才不是一句口号。
 */
export interface RepositoryFixture {
  repository: ProjectRepository;
  /** 直接写入原始存储内容，用来模拟旧版本数据。 */
  seed?: (projectId: string, payload: unknown) => Promise<void>;
  cleanup?: () => Promise<void>;
}

export function repositoryContractTests(name: string, createFixture: () => Promise<RepositoryFixture>): void {
  const withRepository = async (body: (fixture: RepositoryFixture) => Promise<void>): Promise<void> => {
    const fixture = await createFixture();
    try {
      await body(fixture);
    } finally {
      await fixture.cleanup?.();
    }
  };

  test(`${name}: 保存的快照可以原样打开`, async () => {
    await withRepository(async ({ repository }) => {
      const document = createDocument("project:1", "Demo");
      await repository.saveSnapshot(document);
      const opened = await repository.open(document.id);
      assert.deepEqual(opened.document, document);
      assert.equal(opened.replayedTransactions, 0);
      assert.equal(opened.degraded, false);
      assert.equal(opened.migratedFrom, undefined);
    });
  });

  test(`${name}: 不存在的项目报告 ProjectNotFoundError`, async () => {
    await withRepository(async ({ repository }) => {
      await assert.rejects(repository.open("missing"), ProjectNotFoundError);
    });
  });

  test(`${name}: 恢复会重放已提交的事务`, async () => {
    await withRepository(async ({ repository }) => {
      const document = createDocument("project:1", "Demo");
      await repository.saveSnapshot(document);

      const runtime = new DesignRuntime(document);
      runtime.execute({
        commandId: "cmd:1",
        documentId: document.id,
        baseRevision: 0,
        actor: { type: "human", id: "user:1" },
        commands: [{ type: "token.upsert", payload: { name: "color.brand", token: { type: "color", value: "#3366ff" } } }],
      }, { committedAt: "2026-11-05T08:00:00.000Z" });
      await repository.appendTransactions(runtime.transactionLog());

      const recovered = await repository.recover(document.id);
      assert.equal(recovered.document.revision, 1);
      assert.equal(recovered.replayedTransactions, 1);
      assert.equal(recovered.latestKnownRevision, 1);
      assert.equal(recovered.degraded, false);
      assert.deepEqual(recovered.document.tokens["color.brand"], { type: "color", value: "#3366ff" });
    });
  });

  test(`${name}: 事务日志出现断档时报告降级`, async () => {
    await withRepository(async ({ repository }) => {
      const document = createDocument("project:1", "Demo");
      await repository.saveSnapshot(document);
      await repository.appendTransactions([{
        commandId: "cmd:2",
        documentId: document.id,
        revision: 2,
        committedAt: "2026-11-05T08:00:00.000Z",
        actor: { type: "human", id: "user:1" },
        commands: [{ type: "token.upsert", payload: { name: "color.brand", token: { type: "color", value: "#3366ff" } } }],
        warnings: [],
      }]);

      const recovered = await repository.recover(document.id);
      assert.equal(recovered.document.revision, 0);
      assert.equal(recovered.latestKnownRevision, 2);
      assert.equal(recovered.degraded, true);
    });
  });

  test(`${name}: 项目列表给出摘要并按更新时间倒序`, async () => {
    await withRepository(async ({ repository }) => {
      const older = createDocument("project:older", "Older");
      older.meta.updatedAt = "2026-11-01T00:00:00.000Z";
      const newer = createDocument("project:newer", "Newer");
      newer.meta.updatedAt = "2026-11-05T00:00:00.000Z";
      await repository.saveSnapshot(older);
      await repository.saveSnapshot(newer);

      const projects = await repository.listProjects();
      assert.deepEqual(projects.map(item => item.id), ["project:newer", "project:older"]);
      assert.equal(projects[0]?.name, "Newer");
      assert.equal(projects[0]?.revision, 0);
    });
  });

  test(`${name}: 删除项目后无法再打开`, async () => {
    await withRepository(async ({ repository }) => {
      const document = createDocument("project:1", "Demo");
      await repository.saveSnapshot(document);
      await repository.deleteProject(document.id);
      await assert.rejects(repository.open(document.id), ProjectNotFoundError);
      assert.deepEqual(await repository.listProjects(), []);
    });
  });

  test(`${name}: 日志裁剪只保留最近的条目`, async () => {
    await withRepository(async ({ repository }) => {
      const document = createDocument("project:1", "Demo");
      await repository.saveSnapshot(document);
      const entries: TransactionEntry[] = [1, 2, 3].map(revision => ({
        commandId: `cmd:${revision}`,
        documentId: document.id,
        revision,
        committedAt: "2026-11-05T08:00:00.000Z",
        actor: { type: "human", id: "user:1" },
        commands: [],
        warnings: [],
      }));
      await repository.appendTransactions(entries);

      const removed = await repository.pruneJournal(document.id, { keep: 2 });
      assert.equal(removed, 1);
      const remaining = await repository.listTransactions(document.id);
      assert.deepEqual(remaining.map(entry => entry.revision), [2, 3]);
    });
  });

  test(`${name}: 覆盖项目会清掉旧快照与旧日志`, async () => {
    await withRepository(async ({ repository }) => {
      const document = createDocument("project:1", "Demo");
      await repository.saveSnapshot(document);
      await repository.appendTransactions([{
        commandId: "cmd:1",
        documentId: document.id,
        revision: 1,
        committedAt: "2026-11-05T08:00:00.000Z",
        actor: { type: "human", id: "user:1" },
        commands: [{ type: "token.upsert", payload: { name: "color.brand", token: { type: "color", value: "#3366ff" } } }],
        warnings: [],
      }]);

      const replacement = createDocument("project:1", "Replaced");
      await repository.replaceProject("project:1", replacement);

      const opened = await repository.open("project:1");
      assert.equal(opened.document.meta.name, "Replaced");
      assert.equal(opened.replayedTransactions, 0);
      assert.equal(opened.degraded, false);
      assert.deepEqual(opened.document.tokens, {});
      assert.deepEqual(await repository.listTransactions("project:1"), []);
    });
  });

  test(`${name}: 覆盖项目会拒绝换一个 id 的文档`, async () => {
    await withRepository(async ({ repository }) => {
      await repository.saveSnapshot(createDocument("project:1", "Demo"));
      await assert.rejects(repository.replaceProject("project:1", createDocument("project:2", "Other")), /does not match/);
    });
  });

  test(`${name}: 资产按哈希去重且拒绝不匹配的哈希`, async () => {
    await withRepository(async ({ repository }) => {
      const bytes = new TextEncoder().encode("asset-data");
      const hash = await sha256Hex(bytes);
      await repository.putAsset("project:1", { hash, bytes });
      await repository.putAsset("project:1", { hash, bytes });
      assert.deepEqual(Array.from((await repository.getAsset("project:1", hash)) ?? []), Array.from(bytes));
      await assert.rejects(repository.putAsset("project:1", { hash: "0".repeat(64), bytes }), /hash mismatch/);
    });
  });

  test(`${name}: 支持删除资源字节，重复删除不会报错`, async () => {
    await withRepository(async ({ repository }) => {
      if (!repository.deleteAsset) return;
      const bytes = new TextEncoder().encode("asset-data");
      const hash = await sha256Hex(bytes);
      await repository.putAsset("project:1", { hash, bytes });
      await repository.deleteAsset("project:1", hash);
      assert.equal(await repository.getAsset("project:1", hash), undefined);
      // 字节已经不在了，再删一次应当等同成功，调用方不必先探测。
      await repository.deleteAsset("project:1", hash);
    });
  });

  test(`${name}: 旧格式文档在打开时被迁移并被记录`, async () => {
    await withRepository(async ({ repository, seed }) => {
      if (!seed) return;
      const legacy = createDocument("project:1", "Legacy") as unknown as Record<string, unknown>;
      legacy.schemaVersion = 1;
      await seed("project:1", legacy);

      const opened = await repository.open("project:1");
      assert.equal(opened.document.schemaVersion, 2);
      assert.equal(opened.migratedFrom, 1);
      assert.deepEqual(opened.document.migrations, [{ from: 1, to: 2, at: opened.document.migrations?.[0]?.at }]);
    });
  });

  test(`${name}: 历史版本从新到旧列出，最新的一份是当前版本`, async () => {
    await withRepository(async ({ repository }) => {
      await repository.saveSnapshot(snapshotAt("project:1", 0, "v0"));
      await repository.saveSnapshot(snapshotAt("project:1", 1, "v1"));
      await repository.saveSnapshot(snapshotAt("project:1", 2, "v2"));

      const snapshots = await repository.listSnapshots("project:1");
      assert.deepEqual(snapshots.map(item => item.revision), [2, 1, 0]);
      assert.deepEqual(snapshots.map(item => item.current), [true, false, false]);
      assert.equal(snapshots[0]?.schemaVersion, 2);
      assert.equal(snapshots[0]?.updatedAt, "2026-11-05T00:00:02.000Z");
    });
  });

  test(`${name}: 历史版本按保留份数裁剪`, async () => {
    await withRepository(async ({ repository }) => {
      for (let revision = 0; revision <= SNAPSHOT_RETENTION + 1; revision += 1) {
        await repository.saveSnapshot(snapshotAt("project:1", revision, `v${revision}`));
      }
      const snapshots = await repository.listSnapshots("project:1");
      assert.equal(snapshots.length, SNAPSHOT_RETENTION);
      assert.equal(snapshots[0]?.revision, SNAPSHOT_RETENTION + 1);
      assert.equal(snapshots.at(-1)?.revision, 2);
    });
  });

  test(`${name}: 读取历史版本拿到当时的内容`, async () => {
    await withRepository(async ({ repository }) => {
      await repository.saveSnapshot(snapshotAt("project:1", 0, "旧名字"));
      await repository.saveSnapshot(snapshotAt("project:1", 1, "新名字"));

      const old = await repository.readSnapshot("project:1", 0);
      assert.equal(old.meta.name, "旧名字");
      assert.equal(old.revision, 0);
      assert.equal(old.schemaVersion, 2);
    });
  });

  test(`${name}: 读取不存在的版本报 SnapshotNotFoundError`, async () => {
    await withRepository(async ({ repository }) => {
      await repository.saveSnapshot(snapshotAt("project:1", 0, "Demo"));
      await assert.rejects(repository.readSnapshot("project:1", 9), SnapshotNotFoundError);
    });
  });

  test(`${name}: 迁移前的旧版本仍然可以列出来并读回当前格式`, async () => {
    await withRepository(async ({ repository, seed }) => {
      if (!seed) return;
      await seed("project:1", legacyDocumentPayload());

      const snapshots = await repository.listSnapshots("project:1");
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]?.schemaVersion, 1);
      assert.equal(snapshots[0]?.current, true);

      const document = await repository.readSnapshot("project:1", 0);
      assert.equal(document.schemaVersion, 2);
      assert.equal(document.meta.name, "Legacy");
    });
  });

  test(`${name}: 存储占用按项目统计，版本/日志/资源分开算`, async () => {
    await withRepository(async ({ repository }) => {
      await repository.saveSnapshot(snapshotAt("project:1", 0, "占用统计"));
      await repository.saveSnapshot(snapshotAt("project:1", 1, "占用统计"));
      await repository.appendTransactions([transactionAt("project:1", 1)]);
      await repository.putAsset("project:1", { hash: ASSET_HASH, bytes: new Uint8Array(64) });

      assert.ok(repository.inspectStorage, "后端应支持存储占用统计");
      const usage = await repository.inspectStorage!("project:1");
      assert.equal(usage.projectId, "project:1");
      assert.equal(usage.projectName, "占用统计");
      assert.ok(usage.snapshotBytes > 0, "快照应占空间");
      assert.ok(usage.journalBytes > 0, "事务日志应占空间");
      assert.equal(usage.assetBytes, 64);
      assert.equal(usage.totalBytes, usage.snapshotBytes + usage.journalBytes + usage.assetBytes);
      assert.equal(usage.assetCount, 1);
    });
  });

  test(`${name}: 裁历史版本只保留指定份数，当前版本不动`, async () => {
    await withRepository(async ({ repository }) => {
      for (let revision = 0; revision <= 4; revision += 1) {
        await repository.saveSnapshot(snapshotAt("project:1", revision, `v${revision}`));
      }
      assert.ok(repository.trimSnapshots, "后端应支持裁历史版本");
      // keepVersions 含当前版本：保留 3 个 = 当前 + 2 份历史。
      const removed = await repository.trimSnapshots!("project:1", 3);
      assert.ok(removed > 0, "应删掉多余的历史版本");

      const snapshots = await repository.listSnapshots("project:1");
      assert.ok(snapshots.length <= 3, `裁剪后最多剩 3 份，实际 ${snapshots.length}`);
      assert.equal(snapshots[0]?.revision, 4, "当前版本必须保留");
      assert.equal(snapshots[0]?.current, true);
    });
  });
}

/** 造一份停在某个修订号上的文档，用来模拟历史版本。 */
function snapshotAt(id: string, revision: number, name: string): DesignDocument {
  const document = createDocument(id, name);
  document.revision = revision;
  document.meta.updatedAt = new Date(Date.UTC(2026, 10, 5, 0, 0, revision)).toISOString();
  return document;
}

/** 造一条已提交的事务，用来做日志占用的统计。 */
function transactionAt(documentId: string, revision: number): TransactionEntry {
  return {
    commandId: `cmd:${revision}`,
    documentId,
    revision,
    committedAt: new Date(Date.UTC(2026, 10, 5, 0, 0, revision)).toISOString(),
    actor: { type: "human", id: "user:1" },
    commands: [{ type: "token.upsert", payload: { name: `color.${revision}`, token: { type: "color", value: "#3366ff" } } }],
    warnings: [],
  };
}

/** 64 字节零数组的哈希；资源写入要校验哈希，所以必须是真哈希。 */
const ASSET_HASH = createHash("sha256").update(new Uint8Array(64)).digest("hex");

/** 生成一份 v1 文档，供各后端播种旧数据。 */
export function legacyDocumentPayload(id = "project:1"): Record<string, unknown> {
  const document = createDocument(id, "Legacy") as unknown as Record<string, unknown>;
  document.schemaVersion = 1;
  return document;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}
