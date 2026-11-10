/**
 * Studio MCP server（HTTP）。
 *
 * 用法：
 *   STUDIO_PROJECT_DIR=/path STUDIO_PROJECT_ID=project:xxx \
 *   STUDIO_MCP_HTTP_TOKEN=<token> npm run mcp:http
 *
 * 环境变量：
 * - `STUDIO_PROJECT_DIR`  必填；仓库目录。
 * - `STUDIO_PROJECT_ID`   必填；单租户模式下的项目 id。
 * - `STUDIO_MCP_HTTP_TOKEN`  静态 Bearer token。没有它时拒绝启动（除非显式允许并随机生成）。
 * - `STUDIO_MCP_HTTP_PORT`   默认 4599
 * - `STUDIO_MCP_HTTP_HOST`   默认 127.0.0.1（不要默认暴露到 0.0.0.0）
 * - `STUDIO_MCP_AUTO_APPROVE=1`、`STUDIO_MCP_ALLOWED_COMMANDS`、`STUDIO_MCP_ALLOW_RESTORE=1`
 *   与 stdio 版本一致，控制本进程的授权范围。
 *
 * 多租户 + OAuth（规模化接入外部 Agent）：
 * - `STUDIO_MCP_OAUTH_ISSUER`  设了它就启用 OAuth 2.1 授权服务器（授权码 + PKCE）。
 * - `STUDIO_MCP_OAUTH_CLIENTS`  JSON 数组，预登记的客户端：
 *   `[{"clientId":"...","clientSecret":"...","redirectUris":["https://..."],"tenants":["t1"],"scopes":["design:read"]}]`
 * - `STUDIO_MCP_TENANTS`       JSON 数组，多租户表：
 *   `[{"id":"t1","projectId":"project:xxx"}]`
 * - `STUDIO_MCP_SSE=1`         打开 `GET /mcp` 的 SSE 推送。
 *
 * 端点：
 * - `POST /mcp`（JSON-RPC）、`GET /mcp`（SSE 推送）、`DELETE /mcp`（结束会话）
 * - `GET /healthz`
 * - `GET /.well-known/oauth-authorization-server`、`GET /.well-known/oauth-protected-resource`
 * - `GET /oauth/authorize`、`POST /oauth/token`、`POST /oauth/revoke`、`POST /oauth/register`
 */
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { FileSystemProjectRepository } from "@ufira/design-persistence/filesystem";
import { installPaperBooleanEngine } from "../src/boolean-engine";
import { createMcpServer } from "../src/mcp-server";
import { createMcpHttpHandler, type HttpStreamLike } from "../src/mcp-http";
import { createOAuthServer, type OAuthClient } from "../src/mcp-auth";
import { createStoreOAuthState } from "../src/mcp-auth-state";
import { createMcpEventHub, createTenantRevisionLedger, documentUpdatedNotification, startTenantEventPoller } from "../src/mcp-events";
import { createFileMcpStore } from "../src/mcp-store";
import { createTenantProjects, type McpTenantConfig } from "../src/mcp-tenants";
import type { McpPolicy } from "../src/mcp";
import type { DesignCommand } from "@ufira/design-runtime";

// 曲线级布尔：导出 HTML / SVG 时布尔组保留贝塞尔曲线。
installPaperBooleanEngine();

const directory = process.env.STUDIO_PROJECT_DIR;
const projectId = process.env.STUDIO_PROJECT_ID;
if (!directory || !projectId) {
  console.error("需要 STUDIO_PROJECT_DIR 与 STUDIO_PROJECT_ID");
  process.exit(2);
}

const policy: McpPolicy = {
  ...(process.env.STUDIO_MCP_ALLOWED_COMMANDS
    ? { allowedCommandTypes: process.env.STUDIO_MCP_ALLOWED_COMMANDS.split(",").map(item => item.trim()).filter(Boolean) as DesignCommand["type"][] }
    : {}),
  allowDocumentRestore: process.env.STUDIO_MCP_ALLOW_RESTORE === "1",
};

const repository = new FileSystemProjectRepository(directory);

// ── 租户表 ────────────────────────────────────────────────────────────────
const tenants: McpTenantConfig[] = process.env.STUDIO_MCP_TENANTS
  ? parseJson<McpTenantConfig[]>(process.env.STUDIO_MCP_TENANTS, "STUDIO_MCP_TENANTS")
  : [{ id: "default", projectId }];
// 共享状态目录：多个实例指向同一个目录，就共享了 OAuth 状态与事件总线。
// 不给就是单实例模式（状态在进程内存里，事件只在本进程内分发）。
const stateDirectory = process.env.STUDIO_MCP_STATE_DIR?.trim();
const store = stateDirectory ? createFileMcpStore({ directory: stateDirectory }) : undefined;
const hub = createMcpEventHub(store ? { store } : {});
const ledger = createTenantRevisionLedger();
const tenantProjects = createTenantProjects({ repository, tenants });

// 本进程提交后立刻推送；别的进程改了则由轮询发现。
tenantProjects.onOpen((tenant, project) => {
  project.onCommit(event => {
    if (ledger.note(tenant.id, event.revision)) {
      hub.publish(tenant.id, documentUpdatedNotification(tenant.id, tenant.projectId, event.revision));
    }
  });
});
const poller = startTenantEventPoller({ repository, tenants, hub, ledger });

// ── 鉴权 ──────────────────────────────────────────────────────────────────
const oauthIssuer = process.env.STUDIO_MCP_OAUTH_ISSUER?.trim();
let oauth: ReturnType<typeof createOAuthServer> | undefined;
let staticToken = process.env.STUDIO_MCP_HTTP_TOKEN?.trim() ?? "";

if (oauthIssuer) {
  const clients = process.env.STUDIO_MCP_OAUTH_CLIENTS
    ? parseJson<OAuthClient[]>(process.env.STUDIO_MCP_OAUTH_CLIENTS, "STUDIO_MCP_OAUTH_CLIENTS")
    : [];
  oauth = createOAuthServer({
    issuer: oauthIssuer,
    clients,
    // 有共享存储时，客户端登记、授权码与令牌跨实例可见。
    ...(store ? { state: createStoreOAuthState(store) } : {}),
  });
  console.error(`已启用 OAuth 2.1 授权服务器（issuer ${oauthIssuer}），预登记客户端 ${clients.length} 个`);
} else {
  if (!staticToken) {
    if (process.env.STUDIO_MCP_HTTP_INSECURE !== "1") {
      console.error("缺少 STUDIO_MCP_HTTP_TOKEN；如果只是本机临时调试，显式设置 STUDIO_MCP_HTTP_INSECURE=1 让服务随机生成一个令牌");
      process.exit(2);
    }
    staticToken = randomUUID();
    console.error(`已随机生成临时令牌（仅本次进程有效）：${staticToken}`);
  }
}

// ── MCP 服务端 ────────────────────────────────────────────────────────────
const makeServer = async (principal: { subject: string; tenantId: string; scopes: string[]; clientId: string }) => {
  const tenant = tenants.find(item => item.id === principal.tenantId);
  const project = await tenantProjects.open(principal.tenantId);
  if (!project) throw new Error(`租户不存在：${principal.tenantId}`);
  return createMcpServer(project, {
    policy: tenant?.policy ?? policy,
    autoApprove: process.env.STUDIO_MCP_AUTO_APPROVE === "1",
    principal,
    onAudit: entry => console.error(JSON.stringify({ audit: entry })),
  });
};

const sseEnabled = process.env.STUDIO_MCP_SSE === "1";
const handler = createMcpHttpHandler({
  tenants: tenantProjects,
  events: sseEnabled ? hub : undefined,
  ...(oauth ? { oauth, resourceMetadataUrl: `${oauthIssuer}/.well-known/oauth-protected-resource` } : { token: staticToken }),
  defaultTenantId: oauth ? undefined : tenants[0]?.id,
  resolveServer: makeServer,
  createStream: sseEnabled ? (context?: unknown) => nodeStream(context as ServerResponse) : undefined,
});

/** 把 SSE 流接到 Node 的响应对象上。 */
function nodeStream(response: ServerResponse): HttpStreamLike {
  const closeListeners: Array<() => void> = [];
  /** 响应头写好之前写进来的内容先存着。 */
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
    close(): void {
      response.end();
      for (const listener of closeListeners) listener();
    },
    onClose(listener: () => void): void { closeListeners.push(listener); },
  };
}

const maxBodyBytes = 256 * 1024;
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.writeHead(413, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: -32600, message: "请求体超过上限" } }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    void handler.handle({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers,
      body: Buffer.concat(chunks).toString("utf8"),
      // SSE 的流工厂要拿到响应对象才能往里写。
      context: response,
    }).then(result => {
      if (result.stream) {
        // SSE：响应头先发，之后靠流推数据。
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

const port = Number(process.env.STUDIO_MCP_HTTP_PORT ?? 4599);
const host = process.env.STUDIO_MCP_HTTP_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  console.error(`Studio MCP HTTP 已监听 http://${host}:${port}（${tenants.length} 个租户${sseEnabled ? "，SSE 已开启" : ""}）`);
});
// 服务停下来时把轮询也停掉——否则进程退不出去。
server.on("close", () => poller.stop());

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`${label} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
