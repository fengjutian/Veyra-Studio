/**
 * MCP HTTP 传输的端到端探针。
 *
 *   npm run visual:mcp:probe
 *
 * 单元测试用内存里的请求对象，跑得通不代表**真的起了一个 HTTP 服务**能用。
 * 这个探针起一个真的 node http 服务，走完整链路：
 *
 *   ① OAuth 授权码 + PKCE 换令牌（真发 HTTP 请求）
 *   ② 带令牌 initialize → 拿会话 id → tools/call 读文档
 *   ③ 改一个租户的项目，另一个租户**读不到**
 *   ④ GET /mcp 开一条真 SSE 流，提交变更后收到通知
 *
 * 探针失败就退出码非零，CI 靠这个守住。
 */
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { StudioProject } from "../src/studio-project";
import { createMcpServer } from "../src/mcp-server";
import { createMcpHttpHandler, type HttpStreamLike } from "../src/mcp-http";
import { createOAuthServer } from "../src/mcp-auth";
import { createMcpEventHub, createTenantRevisionLedger, documentUpdatedNotification } from "../src/mcp-events";
import { createTenantProjects, type McpTenantConfig } from "../src/mcp-tenants";

const ISSUER = "http://127.0.0.1";
const TENANTS: McpTenantConfig[] = [
  { id: "tenant-a", projectId: "project:a" },
  { id: "tenant-b", projectId: "project:b" },
];

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  else console.log(`✔ ${message}`);
}

async function sha256Base64Url(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "studio-mcp-probe-"));
  const repository = new FileSystemProjectRepository(directory);
  await StudioProject.create(repository, "project:a", "甲的项目");
  await StudioProject.create(repository, "project:b", "乙的项目");

  const hub = createMcpEventHub();
  const ledger = createTenantRevisionLedger();
  const tenantProjects = createTenantProjects({ repository, tenants: TENANTS });
  tenantProjects.onOpen((tenant, project) => {
    project.onCommit(event => {
      if (ledger.note(tenant.id, event.revision)) {
        hub.publish(tenant.id, documentUpdatedNotification(tenant.id, tenant.projectId, event.revision));
      }
    });
  });

  const oauth = createOAuthServer({
    issuer: ISSUER,
    clients: [{
      clientId: "probe-client",
      clientSecret: "probe-secret",
      redirectUris: ["http://127.0.0.1/probe-cb"],
      tenants: ["tenant-a", "tenant-b"],
    }],
  });

  const handler = createMcpHttpHandler({
    tenants: tenantProjects,
    oauth,
    events: hub,
    resourceMetadataUrl: `${ISSUER}/.well-known/oauth-protected-resource`,
    resolveServer: async principal => {
      const project = await tenantProjects.open(principal.tenantId);
      if (!project) throw new Error("租户不存在");
      return createMcpServer(project, { autoApprove: true, principal });
    },
    createStream: (context): HttpStreamLike => {
      const response = context as import("node:http").ServerResponse;
      const closeListeners: Array<() => void> = [];
      const pending: string[] = [];
      let ready = false;
      return {
        write(chunk: string): void {
          if (ready) response.write(chunk);
          else pending.push(chunk);
        },
        ready(): void {
          if (ready) return;
          ready = true;
          for (const chunk of pending) response.write(chunk);
          pending.length = 0;
        },
        close(): void { response.end(); for (const listener of closeListeners) listener(); },
        onClose(listener: () => void): void { closeListeners.push(listener); },
      };
    },
  });

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      void handler.handle({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
        context: response,
      }).then(result => {
        if (result.stream) {
          response.writeHead(result.status, result.headers);
          result.stream.ready?.();
          request.on("close", () => result.stream?.close());
          return;
        }
        response.writeHead(result.status, result.headers);
        response.end(result.body);
      }).catch(error => {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }));
      });
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("没能拿到监听端口");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // ① 发现文档不需要鉴权。
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`);
    check(metadata.status === 200, "发现文档在鉴权之前就能取到");
    const metadataBody = await metadata.json() as { authorization_servers?: string[] };
    check(Array.isArray(metadataBody.authorization_servers), "受保护资源元数据带授权服务器地址");

    // ② 完整的 OAuth 授权码 + PKCE 流程。
    const verifier = "p".repeat(64);
    const challenge = await sha256Base64Url(verifier);
    const authorizeUrl = `${base}/oauth/authorize?client_id=probe-client`
      + `&redirect_uri=${encodeURIComponent("http://127.0.0.1/probe-cb")}&response_type=code`
      + `&scope=${encodeURIComponent("design:read design:write")}`
      + `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&tenant=tenant-a`;
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    check(authorize.status === 302, "授权端点返回 302");
    const location = authorize.headers.get("location") ?? "";
    const code = new URL(location).searchParams.get("code") ?? "";
    check(Boolean(code), "授权码发出来了");

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "probe-client",
        client_secret: "probe-secret",
        redirect_uri: "http://127.0.0.1/probe-cb",
        code_verifier: verifier,
      }).toString(),
    });
    check(tokenResponse.status === 200, "授权码换到了访问令牌");
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    check(Boolean(tokens.access_token), "访问令牌非空");

    // ③ 带令牌 initialize → 会话 id → 读文档。
    const init = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    check(init.status === 200, "initialize 成功");
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    check(Boolean(sessionId), "下发了会话 id");

    const read = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}`, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "design.read", arguments: {} } }),
    });
    const readBody = await read.json() as { result?: { content?: Array<{ text: string }> } };
    const payload = JSON.parse(readBody.result?.content?.[0]?.text ?? "{}") as { name?: string };
    check(payload.name === "甲的项目", "读到的是自己租户的项目");

    // ④ 没有令牌就被拒。
    const anonymous = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize" }),
    });
    check(anonymous.status === 401, "没有令牌时拒绝");

    // ⑤ 另一个租户读不到甲的项目。
    const verifierB = "q".repeat(64);
    const challengeB = await sha256Base64Url(verifierB);
    const authorizeB = await fetch(`${base}/oauth/authorize?client_id=probe-client`
      + `&redirect_uri=${encodeURIComponent("http://127.0.0.1/probe-cb")}&response_type=code`
      + `&scope=${encodeURIComponent("design:read")}`
      + `&code_challenge=${encodeURIComponent(challengeB)}&code_challenge_method=S256&tenant=tenant-b`, { redirect: "manual" });
    const codeB = new URL(authorizeB.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokenB = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: codeB, client_id: "probe-client", client_secret: "probe-secret",
        redirect_uri: "http://127.0.0.1/probe-cb", code_verifier: verifierB,
      }).toString(),
    });
    const tokensB = await tokenB.json() as { access_token: string };
    const initB = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokensB.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize" }),
    });
    const sessionB = initB.headers.get("mcp-session-id") ?? "";
    const readB = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokensB.access_token}`, "mcp-session-id": sessionB },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "design.read", arguments: {} } }),
    });
    const readBodyB = await readB.json() as { result?: { content?: Array<{ text: string }> } };
    const payloadB = JSON.parse(readBodyB.result?.content?.[0]?.text ?? "{}") as { name?: string };
    check(payloadB.name === "乙的项目", "另一个租户读到的是它自己的项目");

    // ⑥ 真 SSE 流：提交变更后收到通知。
    const streamResponse = await fetch(`${base}/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: "text/event-stream" },
    });
    check(streamResponse.status === 200, "SSE 流建立成功");
    check(streamResponse.headers.get("content-type")?.includes("text/event-stream") === true, "SSE 流的内容类型正确");

    const received: string[] = [];
    const reader = streamResponse.body?.getReader();
    const pump = (async () => {
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      while (received.length < 2) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.includes("data:")) received.push(frame);
          index = buffer.indexOf("\n\n");
        }
      }
    })();

    // 通过 MCP 提交一条命令 → 项目提交 → 事件中心 → SSE。
    await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}`, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 6, method: "tools/call",
        params: { name: "design.apply", arguments: { commands: [{ type: "document.rename", payload: { name: "甲改名了" } }], baseRevision: 0 } },
      }),
    });

    await Promise.race([pump, new Promise(resolve => setTimeout(resolve, 4000))]);
    check(received.some(frame => frame.includes("notifications/resources/updated")), "SSE 收到了变更通知");
    check(received.some(frame => frame.includes("tenant-a")), "通知里带着租户");
    await reader?.cancel();
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\nMCP HTTP 探针失败：${failures.length} 个问题`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log("\nMCP HTTP 探针通过：OAuth 授权码 + PKCE、令牌鉴权、多租户隔离与 SSE 推送都走通了。");
}

await main();
