import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { StudioProject } from "../src/studio-project";
import { createMcpServer } from "../src/mcp-server";

const frame: DesignNode = {
  id: "frame:1",
  type: "frame",
  name: "卡片",
  parentId: "page:1",
  childIds: [],
  visible: true,
  locked: false,
  layout: { ...defaultLayout(), width: 200, height: 120 },
  appearance: defaultAppearance(),
};

async function setup(options: Parameters<typeof createMcpServer>[1] = {}) {
  const project = await StudioProject.create(new MemoryRepository(), "project:1", "Demo");
  return { project, server: createMcpServer(project, options) };
}

interface ToolResult {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function textOf(response: { result?: unknown } | undefined): string {
  return (response?.result as ToolResult | undefined)?.content?.[0]?.text ?? "";
}

function payloadOf(response: { result?: unknown } | undefined): Record<string, unknown> {
  return JSON.parse(textOf(response)) as Record<string, unknown>;
}

function isError(response: { result?: unknown } | undefined): boolean {
  return (response?.result as ToolResult | undefined)?.isError === true;
}

function call(server: ReturnType<typeof createMcpServer>, id: number, name: string, args: unknown) {
  return server.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

test("initialize advertises the tools capability", async () => {
  const { server } = await setup();
  const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(response?.id, 1);
  const result = response?.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, "2024-11-05");
  assert.deepEqual(result.capabilities.tools, {});
  assert.equal(result.serverInfo.name, "ufira-studio-mcp");
});

test("tools/list returns the three contract tools with JSON schemas", async () => {
  const { server } = await setup();
  const response = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = (response?.result as { tools: Array<{ name: string; inputSchema: { required: string[] } }> }).tools;
  assert.deepEqual(tools.map(tool => tool.name), ["design.read", "design.preview", "design.apply"]);
  assert.deepEqual(tools[2]?.inputSchema.required, ["commands", "baseRevision"]);
});

test("unknown methods and unknown tools are protocol errors", async () => {
  const { server } = await setup();
  const method = await server.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(method?.error?.code, -32601);

  const tool = await call(server, 4, "design.deleteEverything", {});
  assert.equal(tool?.error?.code, -32602);
});

test("design.read summarises the document", async () => {
  const { server } = await setup();
  const response = await call(server, 5, "design.read", {});
  const payload = payloadOf(response);
  assert.equal(payload.revision, 0);
  assert.equal(payload.name, "Demo");
  assert.deepEqual(payload.counts, { nodes: 0, components: 0, tokens: 0, assets: 0 });
});

test("design.preview reports changes without writing", async () => {
  const { project, server } = await setup();
  const response = await call(server, 6, "design.preview", { commands: [{ type: "node.create", payload: { node: frame } }] });
  const payload = payloadOf(response);
  assert.equal(payload.baseRevision, 0);
  assert.deepEqual(payload.changedNodeIds, ["frame:1"]);
  assert.equal(project.snapshot().revision, 0);
});

test("design.apply asks for approval by default and writes nothing", async () => {
  const audits: Array<{ decision: string }> = [];
  const { project, server } = await setup({ onAudit: entry => audits.push(entry) });
  const response = await call(server, 7, "design.apply", { commands: [{ type: "node.create", payload: { node: frame } }], baseRevision: 0 });

  assert.equal(isError(response), true);
  assert.match(textOf(response), /approval_required/);
  assert.equal(project.snapshot().revision, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.decision, "rejected");
});

test("design.apply commits when auto-approved and returns the new revision", async () => {
  const audits: Array<{ decision: string; revisionAfter?: number }> = [];
  const { project, server } = await setup({ autoApprove: true, onAudit: entry => audits.push(entry) });
  const response = await call(server, 8, "design.apply", { commands: [{ type: "node.create", payload: { node: frame } }], baseRevision: 0 });

  const payload = payloadOf(response);
  assert.equal(payload.revision, 1);
  assert.ok(project.snapshot().nodes["frame:1"]);
  assert.equal(audits[0]?.decision, "applied");
  assert.equal(audits[0]?.revisionAfter, 1);
});

test("design.apply rejects stale revisions", async () => {
  const { project, server } = await setup({ autoApprove: true });
  const response = await call(server, 9, "design.apply", { commands: [{ type: "node.create", payload: { node: frame } }], baseRevision: 5 });
  assert.match(textOf(response), /revision_mismatch/);
  assert.equal(project.snapshot().revision, 0);
});

test("design.apply honours the allow list", async () => {
  const { project, server } = await setup({ autoApprove: true, policy: { allowedCommandTypes: ["document.rename"] } });
  const response = await call(server, 10, "design.apply", { commands: [{ type: "node.create", payload: { node: frame } }], baseRevision: 0 });
  assert.equal(isError(response), true);
  assert.match(textOf(response), /policy_rejected/);
  assert.equal(project.snapshot().revision, 0);
});

test("invalid command payloads fail the request", async () => {
  const { server } = await setup({ autoApprove: true });
  const response = await server.handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "design.apply", arguments: { commands: [{ type: "node.explode", payload: {} }], baseRevision: 0 } } });
  assert.equal(response?.error?.code, -32603);
});

class MemoryRepository implements ProjectRepository {
  document?: DesignDocument;
  transactions: TransactionEntry[] = [];

  async open(): Promise<ProjectSnapshot> {
    if (!this.document) throw new Error("missing");
    return { document: structuredClone(this.document), recoveredFromRevision: this.document.revision, replayedTransactions: 0, latestKnownRevision: this.document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> { this.document = structuredClone(document); }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> { this.transactions.push(...structuredClone(entries)); }
  async listTransactions(): Promise<TransactionEntry[]> { return structuredClone(this.transactions); }
  async replaceProject(_projectId: string, document: DesignDocument): Promise<void> { this.document = structuredClone(document); this.transactions = []; }
  async listProjects(): Promise<ProjectSummary[]> {
    if (!this.document) return [];
    return [{ id: this.document.id, name: this.document.meta.name, revision: this.document.revision, updatedAt: this.document.meta.updatedAt }];
  }
  async deleteProject(): Promise<void> { this.document = undefined; this.transactions = []; }
  async pruneJournal(): Promise<number> { return 0; }
  async listSnapshots(): Promise<SnapshotSummary[]> {
    if (!this.document) return [];
    return [{ revision: this.document.revision, updatedAt: this.document.meta.updatedAt, schemaVersion: this.document.schemaVersion, current: true }];
  }
  async readSnapshot(_projectId: string, revision: number): Promise<DesignDocument> {
    if (!this.document || this.document.revision !== revision) throw new SnapshotNotFoundError("project:1", revision);
    return structuredClone(this.document);
  }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}
