import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import type { AssetWrite, ProjectRepository, ProjectSnapshot, ProjectSummary, SnapshotSummary } from "@ufira/design-persistence";
import { SnapshotNotFoundError } from "@ufira/design-persistence";
import type { TransactionEntry } from "@ufira/design-runtime";
import { StudioProject } from "../src/studio-project";
import { createMcpServer } from "../src/mcp-server";
import { createMcpHttpHandler, type HttpStreamLike } from "../src/mcp-http";
import { createOAuthServer } from "../src/mcp-auth";
import { createMcpEventHub, createTenantRevisionLedger, documentUpdatedNotification, formatSseEvent, startTenantEventPoller } from "../src/mcp-events";
import { createTenantProjects, type McpTenantConfig } from "../src/mcp-tenants";

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

const TENANTS: McpTenantConfig[] = [
  { id: "tenant-a", projectId: "project:a", label: "甲租户" },
  { id: "tenant-b", projectId: "project:b", label: "乙租户" },
];

/** 多项目仓库：每个租户一个项目 id。 */
class MultiProjectRepository implements ProjectRepository {
  readonly documents = new Map<string, DesignDocument>();
  readonly journals = new Map<string, TransactionEntry[]>();

  async open(projectId: string): Promise<ProjectSnapshot> {
    const document = this.documents.get(projectId);
    if (!document) throw new Error(`missing project ${projectId}`);
    return { document: structuredClone(document), recoveredFromRevision: document.revision, replayedTransactions: 0, latestKnownRevision: document.revision, degraded: false };
  }
  async saveSnapshot(document: DesignDocument): Promise<void> { this.documents.set(document.id, structuredClone(document)); }
  async appendTransactions(entries: TransactionEntry[]): Promise<void> {
    for (const entry of entries) {
      const list = this.journals.get(entry.documentId) ?? [];
      list.push(structuredClone(entry));
      this.journals.set(entry.documentId, list);
    }
  }
  async listTransactions(projectId: string, afterRevision = -1): Promise<TransactionEntry[]> {
    return (this.journals.get(projectId) ?? []).filter(entry => entry.revision > afterRevision).map(entry => structuredClone(entry));
  }
  async replaceProject(projectId: string, document: DesignDocument): Promise<void> {
    this.documents.set(projectId, structuredClone(document));
    this.journals.set(projectId, []);
  }
  async listProjects(): Promise<ProjectSummary[]> {
    return [...this.documents.values()].map(document => ({ id: document.id, name: document.meta.name, revision: document.revision, updatedAt: document.meta.updatedAt }));
  }
  async deleteProject(projectId: string): Promise<void> { this.documents.delete(projectId); this.journals.delete(projectId); }
  async pruneJournal(): Promise<number> { return 0; }
  async listSnapshots(projectId: string): Promise<SnapshotSummary[]> {
    const document = this.documents.get(projectId);
    if (!document) return [];
    return [{ revision: document.revision, updatedAt: document.meta.updatedAt, schemaVersion: document.schemaVersion, current: true }];
  }
  async readSnapshot(projectId: string, revision: number): Promise<DesignDocument> {
    const document = this.documents.get(projectId);
    if (!document || document.revision !== revision) throw new SnapshotNotFoundError(projectId, revision);
    return structuredClone(document);
  }
  async putAsset(_projectId: string, _asset: AssetWrite): Promise<void> {}
  async getAsset(): Promise<Uint8Array | undefined> { return undefined; }
  async recover(projectId: string): Promise<ProjectSnapshot> { return this.open(projectId); }
}

/** 可记录的假 SSE 流。 */
class FakeStream implements HttpStreamLike {
  readonly chunks: string[] = [];
  private closeListeners: Array<() => void> = [];
  closed = false;
  write(chunk: string): void { this.chunks.push(chunk); }
  close(): void { this.closed = true; for (const listener of this.closeListeners) listener(); }
  onClose(listener: () => void): void { this.closeListeners.push(listener); }
  text(): string { return this.chunks.join(""); }
}

async function setupTenants(oauth?: ReturnType<typeof createOAuthServer>) {
  const repository = new MultiProjectRepository();
  await StudioProject.create(repository, "project:a", "甲的项目");
  await StudioProject.create(repository, "project:b", "乙的项目");
  const projects = createTenantProjects({ repository, tenants: TENANTS });
  const audits: Array<{ actor: string; tenant?: string; tool: string; decision: string; reason?: string }> = [];
  const hub = createMcpEventHub();
  const ledger = createTenantRevisionLedger();

  const handler = createMcpHttpHandler({
    tenants: projects,
    events: hub,
    createStream: () => new FakeStream(),
    // 没给 OAuth 时用静态令牌；给了就走 OAuth。
    ...(oauth ? { oauth } : { token: "static", defaultTenantId: "tenant-a" }),
    resolveServer: async principal => {
      const project = await projects.open(principal.tenantId);
      if (!project) throw new Error("租户不存在");
      return createMcpServer(project, {
        autoApprove: true,
        principal,
        onAudit: entry => audits.push({ actor: entry.actor, tenant: entry.tenant, tool: entry.tool, decision: entry.decision, reason: entry.reason }),
      });
    },
  });
  return { repository, projects, handler, audits, hub, ledger };
}

function request(overrides: Partial<Parameters<ReturnType<typeof createMcpHttpHandler>["handle"]>[0]> = {}) {
  return { method: "POST", url: "/mcp", headers: {} as Record<string, string | undefined>, body: "{}", ...overrides };
}

function rpc(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

/** 走完整的 OAuth 授权码流程换一个访问令牌。 */
async function accessTokenFor(oauth: ReturnType<typeof createOAuthServer>, tenantId: string, scopes = ["design:read", "design:write"]): Promise<string> {
  const verifier = "v".repeat(64);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const authorize = await oauth.handle({
    method: "GET",
    url: `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent("https://agent.test/cb")}`
      + `&response_type=code&scope=${encodeURIComponent(scopes.join(" "))}`
      + `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&tenant=${tenantId}`,
    headers: {},
  });
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "client-1",
      client_secret: "secret-1",
      redirect_uri: "https://agent.test/cb",
      code_verifier: verifier,
    }).toString(),
  });
  return JSON.parse(exchanged!.body).access_token;
}

test("多租户隔离：令牌只能读到自己的租户，读不到别人的", async () => {
  const oauth = createOAuthServer({
    issuer: "https://studio.test",
    clients: [{
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUris: ["https://agent.test/cb"],
      tenants: ["tenant-a", "tenant-b"],
    }],
  });
  const { repository, handler } = await setupTenants(oauth);
  const tokenA = await accessTokenFor(oauth, "tenant-a");
  const tokenB = await accessTokenFor(oauth, "tenant-b");

  const readName = async (token: string) => {
    const init = await handler.handle(request({ headers: { authorization: `Bearer ${token}` }, body: rpc(1, "initialize") }));
    const sessionId = init.headers?.["Mcp-Session-Id"] ?? "";
    assert.ok(sessionId, "initialize 应该下发会话 id");
    const read = await handler.handle(request({
      headers: { authorization: `Bearer ${token}`, "mcp-session-id": sessionId },
      body: rpc(2, "tools/call", { name: "design.read", arguments: {} }),
    }));
    const result = JSON.parse(read.body).result;
    return JSON.parse(result.content[0].text).name as string;
  };

  assert.equal(await readName(tokenA), "甲的项目");
  assert.equal(await readName(tokenB), "乙的项目");

  // 改动也要落在自己的租户里：甲的令牌不能改到乙的项目。
  const init = await handler.handle(request({ headers: { authorization: `Bearer ${tokenA}` }, body: rpc(3, "initialize") }));
  const sessionId = init.headers?.["Mcp-Session-Id"] ?? "";
  assert.ok(sessionId);
  await handler.handle(request({
    headers: { authorization: `Bearer ${tokenA}`, "mcp-session-id": sessionId },
    body: rpc(4, "tools/call", { name: "design.apply", arguments: { commands: [{ type: "node.create", payload: { node: frame } }], baseRevision: 0 } }),
  }));
  assert.ok(repository.documents.get("project:a")!.nodes["frame:1"], "改动应该落在甲的项目");
  assert.equal(repository.documents.get("project:b")!.nodes["frame:1"], undefined, "乙的项目不该被改到");
});

test("令牌里没有租户时拒绝，不猜租户", async () => {
  const { projects } = await setupTenants();
  const oauth = createOAuthServer({
    issuer: "https://studio.test",
    clients: [{ clientId: "client-1", clientSecret: "secret-1", redirectUris: ["https://agent.test/cb"] }],
  });
  // 授权时**不带** tenant 参数 → 令牌里没有租户。
  const verifier = "w".repeat(64);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const authorize = await oauth.handle({
    method: "GET",
    url: `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent("https://agent.test/cb")}&response_type=code`
      + `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
    headers: {},
  });
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, client_id: "client-1", client_secret: "secret-1",
      redirect_uri: "https://agent.test/cb", code_verifier: verifier,
    }).toString(),
  });
  const token = JSON.parse(exchanged!.body).access_token;

  const handler = createMcpHttpHandler({
    tenants: projects,
    oauth,
    resolveServer: async principal => createMcpServer((await projects.open(principal.tenantId))!, { autoApprove: true, principal }),
  });
  const response = await handler.handle(request({ headers: { authorization: `Bearer ${token}` }, body: rpc(1, "initialize") }));
  assert.equal(response.status, 403);
  assert.match(JSON.parse(response.body).error.message, /租户/);
});

test("租户项目懒加载：只有用到的租户才会被打开", async () => {
  const { projects } = await setupTenants();
  assert.equal(projects.isLoaded("tenant-a"), false);
  assert.ok(await projects.open("tenant-a"));
  assert.equal(projects.isLoaded("tenant-a"), true);
  assert.equal(projects.isLoaded("tenant-b"), false, "没碰过的租户不该被打开");
  assert.equal(await projects.open("tenant-unknown"), undefined);
});

test("SSE：订阅某租户后，只收到该租户的变更", async () => {
  const { hub } = await setupTenants();
  const receivedA: string[] = [];
  const receivedB: string[] = [];
  hub.subscribe("tenant-a", notification => receivedA.push(notification.method));
  hub.subscribe("tenant-b", notification => receivedB.push(notification.method));

  hub.publish("tenant-a", documentUpdatedNotification("tenant-a", "project:a", 3));
  assert.deepEqual(receivedA, ["notifications/resources/updated"]);
  assert.deepEqual(receivedB, [], "别的租户不该收到通知");
});

test("SSE 帧格式符合规范：event + data，空行结尾", () => {
  const frame = formatSseEvent({ method: "notifications/resources/updated", params: { revision: 2 } });
  assert.ok(frame.startsWith("event: message\n"));
  assert.ok(frame.includes("data: "));
  assert.ok(frame.endsWith("\n\n"));
  const payload = JSON.parse(frame.split("data: ")[1]!.trim());
  assert.equal(payload.jsonrpc, "2.0");
  assert.equal(payload.method, "notifications/resources/updated");
  assert.equal(payload.params.revision, 2);
});

test("SSE 端点：GET /mcp 开一条流，租户变更会推进来", async () => {
  const { handler, hub } = await setupTenants();
  const init = await handler.handle(request({ headers: { authorization: "Bearer static" }, body: rpc(1, "initialize") }));
  void init;

  // 单租户静态令牌模式下的 SSE。
  const stream = new FakeStream();
  const events = createMcpEventHub();
  const sse = createMcpHttpHandler({
    token: "static",
    events,
    createStream: () => stream,
    server: { async handle() { return undefined; } },
  });
  const opened = await sse.handle({ method: "GET", url: "/mcp", headers: { authorization: "Bearer static" } });
  assert.equal(opened.status, 200);
  assert.equal(opened.headers?.["Content-Type"], "text/event-stream");
  assert.ok(opened.stream);
  assert.match(stream.text(), /: connected/);

  events.publish("", documentUpdatedNotification("", "project:1", 5));
  assert.match(stream.text(), /notifications\/resources\/updated/);
  assert.match(stream.text(), /"revision":5/);
  void hub;
});

test("修订号账本：同一个修订号只推一次", () => {
  const ledger = createTenantRevisionLedger();
  assert.equal(ledger.note("tenant-a", 1), true);
  assert.equal(ledger.note("tenant-a", 1), false);
  assert.equal(ledger.note("tenant-a", 2), true);
  assert.equal(ledger.note("tenant-a", 0), false);
  assert.equal(ledger.lastRevision("tenant-a"), 2);
  assert.equal(ledger.lastRevision("tenant-b"), -1);
});

test("轮询仓库能发现别的进程提交的变更，并只推一次", async () => {
  const { repository, hub, ledger } = await setupTenants();
  const received: number[] = [];
  hub.subscribe("tenant-a", notification => received.push((notification.params as { revision: number }).revision));

  const poller = startTenantEventPoller({
    repository,
    tenants: TENANTS,
    hub,
    ledger,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  await poller.check();
  assert.deepEqual(received, [], "还没有变更时不该推");

  // 模拟另一个进程提交了一次变更。
  await repository.appendTransactions([{
    commandId: "cmd:1",
    documentId: "project:a",
    revision: 1,
    committedAt: new Date().toISOString(),
    actor: { type: "human", id: "someone-else" },
    commands: [{ type: "document.rename", payload: { name: "改过了" } }],
    warnings: [],
  }]);

  await poller.check();
  await poller.check();
  assert.deepEqual(received, [1], "同一个修订号不该推两遍");
  poller.stop();
});

test("scope 不够时工具被挡下，并留下带租户的审计", async () => {
  const repository = new MultiProjectRepository();
  await StudioProject.create(repository, "project:a", "甲的项目");
  const projects = createTenantProjects({ repository, tenants: TENANTS });
  const audits: Array<{ actor: string; tenant?: string; reason?: string }> = [];

  const principal = { subject: "reader", tenantId: "tenant-a", scopes: ["design:read"], clientId: "client-1" };
  const handler = createMcpHttpHandler({
    tenants: projects,
    token: "static",
    defaultTenantId: "tenant-a",
    resolveServer: async () => {
      const project = await projects.open("tenant-a");
      return createMcpServer(project!, { autoApprove: true, principal, onAudit: entry => audits.push({ actor: entry.actor, tenant: entry.tenant, reason: entry.reason }) });
    },
  });

  const init = await handler.handle(request({ headers: { authorization: "Bearer static" }, body: rpc(1, "initialize") }));
  const sessionId = init.headers?.["Mcp-Session-Id"];

  const apply = await handler.handle(request({
    headers: { authorization: "Bearer static", "mcp-session-id": sessionId },
    body: rpc(2, "tools/call", { name: "design.apply", arguments: { commands: [{ type: "node.create", payload: { node: frame } }], baseRevision: 0 } }),
  }));
  const result = JSON.parse(apply.body).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /scope_denied/);
  assert.equal(audits[0]?.reason, "scope_denied：缺少 design:write");
  assert.equal(audits[0]?.tenant, "tenant-a");
  assert.equal(audits[0]?.actor, "reader");
});

test("会话绑定租户：换租户来用同一个会话 id 会被拒", async () => {
  const repository = new MultiProjectRepository();
  await StudioProject.create(repository, "project:a", "甲的项目");
  await StudioProject.create(repository, "project:b", "乙的项目");
  const projects = createTenantProjects({ repository, tenants: TENANTS });

  const build = (tenantId: string) => createMcpHttpHandler({
    tenants: projects,
    token: "static",
    defaultTenantId: tenantId,
    resolveServer: async principal => {
      const project = await projects.open(principal.tenantId);
      return createMcpServer(project!, { autoApprove: true, principal });
    },
  });

  const init = await build("tenant-a").handle(request({ headers: { authorization: "Bearer static" }, body: rpc(1, "initialize") }));
  const sessionId = init.headers?.["Mcp-Session-Id"];
  assert.ok(sessionId);

  const reused = await build("tenant-b").handle(request({
    headers: { authorization: "Bearer static", "mcp-session-id": sessionId },
    body: rpc(2, "tools/list"),
  }));
  assert.equal(reused.status, 404);
  assert.match(JSON.parse(reused.body).error.message, /会话不存在/);
});
