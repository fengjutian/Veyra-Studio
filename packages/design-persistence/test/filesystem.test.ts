import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocument, CURRENT_SCHEMA_VERSION } from "@ufira/design-schema";
import { DesignRuntime, type TransactionEntry } from "@ufira/design-runtime";
import { FileSystemProjectRepository } from "../src/filesystem";
import { legacyDocumentPayload, repositoryContractTests } from "../src/contract-suite";
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "design-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repository: new FileSystemProjectRepository(directory) };
}

repositoryContractTests("文件系统仓库", async () => {
  const directory = await mkdtemp(join(tmpdir(), "design-persistence-contract-"));
  return {
    repository: new FileSystemProjectRepository(directory),
    seed: async (projectId: string, payload: unknown) => {
      const snapshots = join(directory, encodeURIComponent(projectId), "snapshots");
      await mkdir(snapshots, { recursive: true });
      await writeFile(join(snapshots, "000000000000.json"), JSON.stringify(payload));
    },
    cleanup: async () => { await rm(directory, { recursive: true, force: true }); },
  };
});

test("falls back to the previous snapshot when the latest is corrupt", async t => {
  const { directory, repository } = await fixture(t);
  const document = createDocument("project:1", "Demo");
  await repository.saveSnapshot(document);
  document.revision = 1;
  document.meta.updatedAt = new Date().toISOString();
  await repository.saveSnapshot(document);
  await writeFile(join(directory, encodeURIComponent(document.id), "snapshots", "000000000001.json"), "{broken");
  const recovered = await repository.recover(document.id);
  assert.equal(recovered.document.revision, 0);
  assert.equal(recovered.latestKnownRevision, 1);
  assert.equal(recovered.degraded, true);
});

test("keeps the original file as a backup when a legacy document is migrated", async t => {
  const { directory, repository } = await fixture(t);
  const snapshots = join(directory, encodeURIComponent("project:1"), "snapshots");
  await mkdir(snapshots, { recursive: true });
  await writeFile(join(snapshots, "000000000000.json"), JSON.stringify(legacyDocumentPayload()));

  const recovered = await repository.open("project:1");
  assert.equal(recovered.migratedFrom, 1);
  assert.equal(recovered.document.schemaVersion, CURRENT_SCHEMA_VERSION);

  const backup = await readFile(join(directory, encodeURIComponent("project:1"), "backups", "000000000000.json"), "utf8");
  assert.equal(JSON.parse(backup).schemaVersion, 1);
  const migrated = await readFile(join(snapshots, "000000000000.json"), "utf8");
  assert.equal(JSON.parse(migrated).schemaVersion, CURRENT_SCHEMA_VERSION);
});

test("stores transaction records in revision order", async t => {
  const { repository } = await fixture(t);
  const entry = (revision: number): TransactionEntry => ({
    commandId: `cmd:${revision}`,
    documentId: "project:1",
    revision,
    committedAt: new Date().toISOString(),
    actor: { type: "human", id: "user:1" },
    commands: [],
    warnings: [],
  });
  await repository.appendTransactions([entry(2), entry(1)]);
  const entries = await repository.listTransactions("project:1");
  assert.deepEqual(entries.map(item => item.revision), [1, 2]);
});

test("deduplicates assets by verified SHA-256 hash", async t => {
  const { repository } = await fixture(t);
  const bytes = new TextEncoder().encode("asset-data");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await repository.putAsset("project:1", { hash, bytes });
  await repository.putAsset("project:1", { hash, bytes });
  assert.deepEqual(Array.from((await repository.getAsset("project:1", hash)) ?? []), Array.from(bytes));
  await assert.rejects(repository.putAsset("project:1", { hash: "0".repeat(64), bytes }), /hash mismatch/);
});

test("records the storage layout version in the manifest", async t => {
  const { directory, repository } = await fixture(t);
  const document = createDocument("project:1", "Demo");
  await repository.saveSnapshot(document);
  const manifest = JSON.parse(await readFile(join(directory, encodeURIComponent(document.id), "manifest.json"), "utf8"));
  assert.equal(manifest.storageVersion, 2);
  assert.equal(manifest.documentSchemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(manifest.name, "Demo");
});

test("upgrades a v1 manifest to the current storage layout and keeps the original", async t => {
  const { directory, repository } = await fixture(t);
  const projectDirectory = join(directory, encodeURIComponent("project:1"));
  const snapshots = join(projectDirectory, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const document = createDocument("project:1", "Demo");
  await writeFile(join(snapshots, "000000000000.json"), JSON.stringify(document));
  // v1 的 manifest：没有 storageVersion / documentSchemaVersion。
  const legacyManifest = {
    projectId: "project:1",
    name: "Demo",
    latestRevision: 0,
    updatedAt: document.meta.updatedAt,
  };
  await writeFile(join(projectDirectory, "manifest.json"), JSON.stringify(legacyManifest));

  await repository.open("project:1");

  const manifest = JSON.parse(await readFile(join(projectDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.storageVersion, 2);
  assert.equal(manifest.documentSchemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(manifest.storageMigrations.length, 1);
  assert.equal(manifest.storageMigrations[0].from, 1);
  // 迁移前的原始 manifest 留档，回滚时按版本取回。
  const backup = JSON.parse(await readFile(join(projectDirectory, "backups", "manifest-v1.json"), "utf8"));
  assert.deepEqual(backup, legacyManifest);
});

test("writes a manifest for a project that predates manifests", async t => {
  const { directory, repository } = await fixture(t);
  const projectDirectory = join(directory, encodeURIComponent("project:1"));
  const snapshots = join(projectDirectory, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const document = createDocument("project:1", "Legacy");
  await writeFile(join(snapshots, "000000000000.json"), JSON.stringify(document));

  const recovered = await repository.open("project:1");
  assert.equal(recovered.document.id, "project:1");

  const manifest = JSON.parse(await readFile(join(projectDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.projectId, "project:1");
  assert.equal(manifest.storageVersion, 2);
  assert.equal(manifest.storageMigrations.length, 1);
});

test("refuses to open a project written by a newer storage layout", async t => {
  const { directory, repository } = await fixture(t);
  const projectDirectory = join(directory, encodeURIComponent("project:1"));
  const snapshots = join(projectDirectory, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const document = createDocument("project:1", "Future");
  await writeFile(join(snapshots, "000000000000.json"), JSON.stringify(document));
  await writeFile(join(projectDirectory, "manifest.json"), JSON.stringify({
    projectId: "project:1",
    name: "Future",
    latestRevision: 0,
    updatedAt: document.meta.updatedAt,
    storageVersion: 99,
  }));

  await assert.rejects(repository.open("project:1"), /storage layout v99 is newer than this app supports/);
});

test("keeps the storage migration history across ordinary saves", async t => {
  const { directory, repository } = await fixture(t);
  const projectDirectory = join(directory, encodeURIComponent("project:1"));
  const snapshots = join(projectDirectory, "snapshots");
  await mkdir(snapshots, { recursive: true });
  const document = createDocument("project:1", "Demo");
  await writeFile(join(snapshots, "000000000000.json"), JSON.stringify(document));
  await writeFile(join(projectDirectory, "manifest.json"), JSON.stringify({ projectId: "project:1", name: "Demo", latestRevision: 0, updatedAt: document.meta.updatedAt }));

  await repository.open("project:1");
  document.revision = 1;
  await repository.saveSnapshot(document);

  const manifest = JSON.parse(await readFile(join(projectDirectory, "manifest.json"), "utf8"));
  // 保存不能把「这份数据是怎么升上来的」抹掉。
  assert.equal(manifest.storageMigrations.length, 1);
});
