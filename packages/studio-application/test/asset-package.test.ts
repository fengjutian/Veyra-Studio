import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type AssetMetadata, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { StudioProject, planPackageFontPath, planPackageImagePaths, safePackageFileName } from "../src/index";

/**
 * 资产打包：交付物从「单个自包含 HTML」变成「HTML + 资源」。
 *
 * 规格见 `docs/asset-packaging.md`。
 */

const here = dirname(fileURLToPath(import.meta.url));
const FONT_BYTES = new Uint8Array(readFileSync(join(here, "..", "..", "design-export", "test", "fixtures", "PressStart2P-Regular.ttf")));

const envelope = (revision: number, commands: unknown[]) => ({
  commandId: `cmd:${revision + 1}`,
  documentId: "project:1",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands: commands as never,
});

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

function textNode(id: string, family: string, weight = 400): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 200, height: 40 },
    appearance: defaultAppearance(),
    text: "hello",
    fontFamily: family,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: weight,
  } as DesignNode;
}

function assetFor(bytes: Uint8Array, name: string, mimeType = "image/png"): AssetMetadata {
  return { id: `asset:${name}`, hash: createHash("sha256").update(bytes).digest("hex"), mimeType, byteLength: bytes.byteLength, name };
}

test("keeps package file names free of path traversal", () => {
  assert.equal(safePackageFileName("../../etc/passwd"), "etc_passwd");
  assert.equal(safePackageFileName(".."), "file");
  assert.equal(safePackageFileName(".hidden"), "hidden");
  assert.equal(safePackageFileName("a/b\\c.png"), "a_b_c.png");
  assert.equal(safePackageFileName(""), "file");
});

test("plans image paths with a readable name, an extension and a hash tag", () => {
  const asset = assetFor(new Uint8Array([1, 2]), "pixel.png");
  const paths = planPackageImagePaths([asset]);
  const path = paths.get(asset.id);
  assert.ok(path?.startsWith("./assets/"), `路径应指向包内资源目录：${path}`);
  assert.ok(path?.endsWith(".png"), `扩展名要跟着 MIME 走：${path}`);
  assert.equal(path?.split("/").length, 3, `资源只放一层目录：${path}`);
});

test("gives same-named images different files", () => {
  const first = assetFor(new Uint8Array([1]), "same.png");
  const second = { ...assetFor(new Uint8Array([2]), "other.png"), id: "asset:second", name: "same.png" };
  const paths = planPackageImagePaths([first, second]);
  assert.notEqual(paths.get(first.id), paths.get(second.id));
});

test("packs images as separate files instead of data urls", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const asset = assetFor(bytes, "pixel.png");
  await repository.putAsset("project:1", { hash: asset.hash, bytes });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", asset.id) } },
  ]));

  const result = await project.exportHtmlPackage({ pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.match(result.document, /<img /);
  assert.doesNotMatch(result.document, /data:image\//);
  assert.match(result.document, /src="\.\/assets\/[^"]+\.png"/);
  assert.equal(result.files.length, 1);
  assert.match(result.files[0]!.path, /^assets\//);
  assert.deepEqual(Array.from(result.files[0]!.bytes), Array.from(bytes));
  assert.deepEqual(result.diagnostics, []);
});

test("reports a missing image instead of failing the package", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const asset = assetFor(new Uint8Array([1, 2, 3]), "ghost.png");
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: imageNode("image:1", asset.id) } },
  ]));

  const result = await project.exportHtmlPackage({ pageId: "page:1", viewport: { width: 800, height: 600 } });
  assert.equal(result.files.length, 0);
  assert.doesNotMatch(result.document, /<img /);
  assert.equal(result.diagnostics[0]?.feature, "image-asset");
});

test("packs fonts as files and points @font-face at them", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const asset = assetFor(FONT_BYTES, "PressStart2P.ttf", "font/ttf");
  await repository.putAsset("project:1", { hash: asset.hash, bytes: FONT_BYTES });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: textNode("text:1", "Press Start 2P") } },
    { type: "font.register", payload: { font: { family: "Press Start 2P", assetId: asset.id, weight: 400 } } },
  ]));

  const result = await project.exportHtmlPackage({ pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.match(result.document, /@font-face \{/);
  assert.match(result.document, /font-family: "Press Start 2P";/);
  assert.match(result.document, /src: url\("\.\/fonts\/[^"]+\.ttf"\) format\("truetype"\);/);
  assert.doesNotMatch(result.document, /data:font\//);
  assert.equal(result.files.length, 1);
  assert.match(result.files[0]!.path, /^fonts\//);
  assert.deepEqual(Array.from(result.files[0]!.bytes), Array.from(FONT_BYTES));
});

test("does not apply the inline size limit to packaged fonts", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  // 比内联上限（1 MB）还大的字体：内联版会放弃它，打包版必须照常带上。
  const big = new Uint8Array(1024 * 1024 + 16);
  const asset = assetFor(big, "Big.ttf", "font/ttf");
  await repository.putAsset("project:1", { hash: asset.hash, bytes: big });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: textNode("text:1", "Big") } },
    { type: "font.register", payload: { font: { family: "Big", assetId: asset.id, weight: 400 } } },
  ]));

  const result = await project.exportHtmlPackage({ pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.bytes.byteLength, big.byteLength);
  assert.equal(result.diagnostics.filter(diagnostic => diagnostic.feature === "font-inline").length, 0);
});

test("plans one font file per usage so subset results cannot collide", () => {
  const base = { assetId: "asset:1", family: "Inter", mime: "font/woff2", hash: "abcdef1234567890" };
  const normal = planPackageFontPath({ ...base, weight: 400, style: "normal" });
  const bold = planPackageFontPath({ ...base, weight: 700, style: "normal" });
  const italic = planPackageFontPath({ ...base, weight: 400, style: "italic" });
  assert.notEqual(normal, bold);
  assert.notEqual(normal, italic);
  assert.match(normal, /^\.\/fonts\/Inter-400-[0-9a-f]+\.woff2$/);
  assert.match(italic, /^\.\/fonts\/Inter-400i-/);
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
