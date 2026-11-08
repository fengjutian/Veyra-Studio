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
import { StudioProject } from "../src/index";

/**
 * 导出时把字体内联进 HTML 交付物。
 *
 * 规格见 `docs/font-inline.md`。
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

function fontAsset(bytes: Uint8Array, name: string): AssetMetadata {
  return {
    id: `asset:${name}`,
    hash: createHash("sha256").update(bytes).digest("hex"),
    mimeType: "font/ttf",
    byteLength: bytes.byteLength,
    name,
  };
}

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

/** 一个带字体资产与声明的项目。 */
async function projectWithFont(weight = 400): Promise<{ project: StudioProject; repository: MemoryRepository; asset: AssetMetadata }> {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const asset = fontAsset(FONT_BYTES, "PressStart2P");
  await repository.putAsset("project:1", { hash: asset.hash, bytes: FONT_BYTES });
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: textNode("text:1", "Press Start 2P", weight) } },
    { type: "font.register", payload: { font: { family: "Press Start 2P", assetId: asset.id, weight } } },
  ]));
  return { project, repository, asset };
}

test("inlines the declared font into the exported html", async () => {
  const { project } = await projectWithFont();
  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.match(result.document, /@font-face \{/);
  assert.match(result.document, /font-family: "Press Start 2P";/);
  assert.match(result.document, /src: url\(data:font\/ttf;base64,/);
  assert.match(result.document, /font-weight: 400;/);
  assert.deepEqual(result.diagnostics, []);
});

test("does not inline a font that was never declared", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  await project.execute(envelope(0, [
    { type: "node.create", payload: { node: textNode("text:1", "Arial") } },
  ]));
  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.doesNotMatch(result.document, /@font-face/);
  assert.deepEqual(result.diagnostics, []);
});

test("reports a font whose bytes cannot be read", async () => {
  const repository = new MemoryRepository();
  const project = await StudioProject.create(repository, "project:1", "Demo");
  const asset = fontAsset(FONT_BYTES, "ghost");
  await project.execute(envelope(0, [
    { type: "asset.upsert", payload: { asset } },
    { type: "node.create", payload: { node: textNode("text:1", "Press Start 2P") } },
    { type: "font.register", payload: { font: { family: "Press Start 2P", assetId: asset.id, weight: 400 } } },
  ]));
  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.doesNotMatch(result.document, /@font-face/);
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.feature === "font-inline"), true);
});

test("reports a weight that does not match any declaration", async () => {
  const { project } = await projectWithFont(400);
  // 文本节点要用 700，而文档里只有 400 的声明。
  await project.execute(envelope(1, [
    { type: "node.patch", payload: { id: "text:1", patch: { fontWeight: 700 } } },
  ]));
  const result = await project.exportHtmlWithAssets({ pageId: "page:1", viewport: { width: 400, height: 200 } });
  assert.match(result.document, /@font-face/);
  const note = result.diagnostics.find(diagnostic => diagnostic.feature === "font-inline");
  assert.equal(note?.support, "approximated");
  assert.match(note?.message ?? "", /字重可能对不上/);
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
