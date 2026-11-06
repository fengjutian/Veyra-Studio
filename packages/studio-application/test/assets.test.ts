import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type AssetMetadata, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject, assetDataUrl, base64FromBytes, collectAssetUsage, collectImageAssets, findMissingAssets, unusedAssets } from "../src/index";

const imageNode = (id: string, assetId: string): DesignNode => ({
  id,
  type: "image",
  name: id,
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: { ...defaultLayout(), width: 120, height: 80 },
  appearance: defaultAppearance(),
  assetId,
  fit: "cover",
});

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision + 1}`,
  documentId: "project:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: commands as never,
});

function assetFor(bytes: Uint8Array, name: string): AssetMetadata {
  return { id: `asset:${name}`, hash: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png", byteLength: bytes.byteLength, name };
}

test("encodes bytes as base64 without relying on the host", () => {
  assert.equal(base64FromBytes(new Uint8Array([])), "");
  assert.equal(base64FromBytes(new Uint8Array([102])), "Zg==");
  assert.equal(base64FromBytes(new Uint8Array([102, 111])), "Zm8=");
  assert.equal(base64FromBytes(new Uint8Array([102, 111, 111])), "Zm9v");
  assert.equal(base64FromBytes(new Uint8Array([0, 255, 0])), "AP8A");
});

test("builds an image data URL from the asset mime type", () => {
  const asset = assetFor(new Uint8Array([1, 2]), "pixel");
  assert.equal(assetDataUrl(asset, new Uint8Array([1, 2])), "data:image/png;base64,AQI=");
});

test("exports image nodes with inline asset data instead of an empty box", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const asset = assetFor(bytes, "pixel");
  await repository.putAsset("project:1", { hash: asset.hash, bytes });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", asset.id) } },
  ]));

  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.document, /<img /);
  assert.match(result.document, new RegExp(`src="data:image/png;base64,${base64FromBytes(bytes)}"`));
  assert.deepEqual(result.diagnostics, []);
});

test("reports a missing asset instead of failing the export", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const asset = assetFor(new Uint8Array([1, 2, 3]), "ghost");
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", asset.id) } },
  ]));

  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.doesNotMatch(result.document, /<img /);
  assert.equal(result.diagnostics[0]?.feature, "image-asset");
  assert.deepEqual(await findMissingAssets(repository, project.snapshot()), [asset]);
});

test("collects only the assets the exported selection renders", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const first = assetFor(new Uint8Array([1]), "first");
  const second = assetFor(new Uint8Array([2]), "second");
  await repository.putAsset("project:1", { hash: first.hash, bytes: new Uint8Array([1]) });
  await repository.putAsset("project:1", { hash: second.hash, bytes: new Uint8Array([2]) });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset: first } },
    { type: "asset.upsert", payload: { asset: second } },
    { type: "node.create", payload: { node: imageNode("image:1", first.id) } },
    { type: "node.create", payload: { node: imageNode("image:2", second.id) } },
  ]));

  const document = project.snapshot();
  assert.deepEqual(collectImageAssets(document, "page:1").map(asset => asset.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(collectImageAssets(document, "page:1", ["image:2"]).map(asset => asset.id), [second.id]);

  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 800, height: 600 }, nodeIds: ["image:2"] });
  assert.equal(result.document.match(/<img /g)?.length, 1);
  assert.match(result.document, new RegExp(`src="data:image/png;base64,${base64FromBytes(new Uint8Array([2]))}"`));
});

test("collects usage counts so the asset panel can show what is referenced", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const shared = assetFor(new Uint8Array([7]), "shared");
  const orphan = assetFor(new Uint8Array([8]), "orphan");
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset: shared } },
    { type: "asset.upsert", payload: { asset: orphan } },
    { type: "node.create", payload: { node: imageNode("image:1", shared.id) } },
    { type: "node.create", payload: { node: imageNode("image:2", shared.id) } },
  ]));

  const usage = collectAssetUsage(project.snapshot()).sort((left, right) => left.asset.id.localeCompare(right.asset.id));
  const sharedUsage = usage.find(entry => entry.asset.id === shared.id);
  const orphanUsage = usage.find(entry => entry.asset.id === orphan.id);
  assert.deepEqual(sharedUsage?.nodeIds.sort(), ["image:1", "image:2"]);
  assert.deepEqual(orphanUsage?.nodeIds, []);
  assert.deepEqual(unusedAssets(project.snapshot()).map(asset => asset.id), [orphan.id]);
});

class MemoryRepository implements ProjectRepository {
  document?: DesignDocument;
  transactions: TransactionEntry[] = [];
  assets = new Map<string, Uint8Array>();

  async open(): Promise<ProjectSnapshot> {
    if (!this.document) throw new Error("missing");
    return { document: structuredClone(this.document), recoveredFromRevision: this.document.revision, replayedTransactions: 0, latestKnownRevision: this.document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> { this.document = structuredClone(document); }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> { this.transactions.push(...structuredClone(entries)); }
  async listTransactions(): Promise<TransactionEntry[]> { return structuredClone(this.transactions); }
  async replaceProject(_projectId: string, document: DesignDocument): Promise<void> { this.document = structuredClone(document); this.transactions = []; this.assets.clear(); }
  async listProjects(): Promise<ProjectSummary[]> {
    if (!this.document) return [];
    return [{ id: this.document.id, name: this.document.meta.name, revision: this.document.revision, updatedAt: this.document.meta.updatedAt }];
  }
  async deleteProject(): Promise<void> { this.document = undefined; this.transactions = []; this.assets.clear(); }
  async pruneJournal(): Promise<number> { return 0; }
  async listSnapshots(): Promise<SnapshotSummary[]> {
    if (!this.document) return [];
    return [{ revision: this.document.revision, updatedAt: this.document.meta.updatedAt, schemaVersion: this.document.schemaVersion, current: true }];
  }
  async readSnapshot(_projectId: string, revision: number): Promise<DesignDocument> {
    if (!this.document || this.document.revision !== revision) throw new SnapshotNotFoundError("project:1", revision);
    return structuredClone(this.document);
  }
  async putAsset(_projectId: string, write: AssetWrite): Promise<void> { this.assets.set(write.hash, new Uint8Array(write.bytes)); }
  async getAsset(_projectId: string, hash: string): Promise<Uint8Array | undefined> { const bytes = this.assets.get(hash); return bytes ? new Uint8Array(bytes) : undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}
