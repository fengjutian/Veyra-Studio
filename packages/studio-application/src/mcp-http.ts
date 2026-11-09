import type { McpServer } from "./mcp-server";
import type { OAuthServer } from "./mcp-auth";
import { formatSseEvent, type McpEventHub } from "./mcp-events";
import type { McpPrincipal, McpTenantProjects } from "./mcp-tenants";

/**
 * MCP over HTTP。
 *
 * 三个层次：
 *
 * - **传输**：`POST /mcp` 收发单条 JSON-RPC；`GET /mcp` 开一条 SSE 流，服务端
 *   主动推送通知；`Mcp-Session-Id` 做会话隔离；`GET /healthz` 做存活检查。
 * - **鉴权**：默认是静态 Bearer token（本机/内网）。配了 `oauth` 就走 OAuth 2.1
 *   授权码流——外部 Agent 按标准发现端点、拿令牌、过期了自己刷新。
 * - **隔离**：令牌里带租户，请求按租户路由到对应的项目。租户之间互相看不到。
 *
 * 会话是**绑定租户**的：租户 A 的会话 id 拿到租户 B 的令牌来用会被拒（404，
 * 不是 403——不告诉对方「这个会话存在」）。
 *
 * 规格见 `docs/mcp-production.md`。
 */

export interface HttpRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body?: string;
  /**
   * 传输层附带的上下文。
   *
   * SSE 的流工厂需要拿到「往哪儿写」——但它是由传输层自己创建的，所以只能由
   * 传输层在处理请求时放进来。类型是 `unknown`：这一层不关心它是什么。
   */
  context?: unknown;
}

/** 流式响应（SSE 用）。 */
export interface HttpStreamLike {
  /** 写一段数据。 */
  write(chunk: string): void;
  /** 结束流。 */
  close(): void;
  /** 客户端断开时回调（用来退订）。 */
  onClose(listener: () => void): void;
  /**
   * 传输层写完响应头之后调用。
   *
   * HTTP 的响应头只能发一次，而流是**在**响应头之前就创建出来的——所以在
   * `ready()` 之前写进去的内容必须先缓存，否则第一次 `write()` 会把响应头
   * 隐式发出去（之后 `writeHead` 就会报 ERR_HTTP_HEADERS_SENT）。
   */
  ready?(): void;
}

export interface HttpResponseLike {
  status: number;
  headers?: Record<string, string>;
  /** 非流式响应的正文；流式响应为空。 */
  body: string;
  /** 流式响应（SSE）。 */
  stream?: HttpStreamLike;
}

export interface McpHttpOptions {
  /** 单租户：固定的服务端。与 `resolveServer` 二选一。 */
  server?: McpServer;
  /** 多租户：按主体解析服务端。 */
  resolveServer?(principal: McpPrincipal): McpServer | Promise<McpServer>;
  /** 静态 Bearer token；与 `oauth` 二选一。 */
  token?: string;
  /** OAuth 授权服务器；配了它就走 OAuth 鉴权。 */
  oauth?: OAuthServer;
  /** 租户 → 项目。配了它就按令牌里的租户做隔离。 */
  tenants?: McpTenantProjects;
  /** 事件中心；配了它并提供 `createStream` 就能开 SSE。 */
  events?: McpEventHub;
  /** 令牌里没写租户时落到哪个租户；不配则这类令牌被拒。 */
  defaultTenantId?: string;
  /** 请求体上限，默认 256 KB。 */
  maxBodyBytes?: number;
  /** 会话空闲多久失效，默认 30 分钟。 */
  sessionTtlMs?: number;
  /** 时间源，测试用。 */
  now?(): number;
  /** 生成会话 id，测试用。 */
  createSessionId?(): string;
  /** 创建 SSE 流；不提供就开不了 SSE 端点。参数是请求携带的传输层上下文。 */
  createStream?(context?: unknown): HttpStreamLike;
  /** 资源元数据地址；配了 OAuth 时用于 `WWW-Authenticate` 头。 */
  resourceMetadataUrl?: string;
}

export interface McpHttpHandler {
  handle(request: HttpRequestLike): Promise<HttpResponseLike>;
  /** 当前活跃会话数，便于监控与测试。 */
  sessionCount(): number;
  /** 当前 SSE 订阅数。 */
  subscriberCount(): number;
}

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

interface Session {
  lastSeenAt: number;
  /** 同一会话的请求串行执行，避免两个 initialize/apply 交错。 */
  queue: Promise<unknown>;
  /** 会话归属的租户；换租户来用这个会话会被拒。 */
  tenantId: string;
  /** 会话归属的主体。 */
  subject: string;
}

type AuthOutcome = { ok: true; principal: McpPrincipal } | { ok: false; response: HttpResponseLike };

export function createMcpHttpHandler(options: McpHttpOptions): McpHttpHandler {
  const sessions = new Map<string, Session>();
  const now = options.now ?? (() => Date.now());
  const createSessionId = options.createSessionId ?? (() => globalThis.crypto.randomUUID());
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const ttl = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

  const prune = () => {
    const cutoff = now() - ttl;
    for (const [id, session] of sessions) if (session.lastSeenAt < cutoff) sessions.delete(id);
  };

  return {
    sessionCount: () => sessions.size,
    subscriberCount: () => options.events?.subscriberCount() ?? 0,

    async handle(request: HttpRequestLike): Promise<HttpResponseLike> {
      const method = request.method.toUpperCase();
      const path = (request.url.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";

      // OAuth 端点在鉴权之前：客户端要先拿到发现文档，才知道去哪儿授权。
      if (options.oauth) {
        const oauthResponse = await options.oauth.handle(request);
        if (oauthResponse) return oauthResponse;
      }

      const auth = await authenticate(request, options);
      if (!auth.ok) return auth.response;
      const principal = auth.principal;

      if (method === "GET" && path === "/healthz") {
        return json(200, { ok: true, sessions: sessions.size, subscribers: options.events?.subscriberCount() ?? 0 });
      }
      if (path !== "/mcp") return json(404, { error: { code: -32601, message: "Not found" } });

      if (method === "GET") return openEventStream(principal, options, request.context);
      if (method === "DELETE") return terminateSession(request, sessions);
      if (method !== "POST") return json(405, { error: { code: -32601, message: "Use POST or GET /mcp" } }, { Allow: "POST, GET" });

      const body = request.body ?? "";
      if (body.length > maxBodyBytes) return json(413, { error: { code: -32600, message: "请求体超过上限" } });

      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }

      prune();
      const sessionId = request.headers["mcp-session-id"];
      const isInitialize = isRecord(message) && message.method === "initialize";

      if (isInitialize) {
        const id = createSessionId();
        sessions.set(id, { lastSeenAt: now(), queue: Promise.resolve(), tenantId: principal.tenantId, subject: principal.subject });
        const server = await resolveServer(principal, options);
        const result = await server.handle(message);
        return json(200, result ?? { jsonrpc: "2.0", id: null, result: {} }, { "Mcp-Session-Id": id });
      }

      if (!sessionId) return json(400, { error: { code: -32002, message: "缺少 Mcp-Session-Id；请先调用 initialize" } });
      const session = sessions.get(sessionId);
      if (!session) return json(404, { error: { code: -32003, message: "会话不存在或已过期" } });
      // 会话绑定租户：别的租户拿着这个 id 来用，不告诉它「会话存在」。
      if (session.tenantId !== principal.tenantId) return json(404, { error: { code: -32003, message: "会话不存在或已过期" } });

      const server = await resolveServer(principal, options);
      // 同会话串行：前一个请求失败也不能卡死后续请求。
      const run = session.queue.then(() => server.handle(message), () => server.handle(message));
      session.queue = run.then(() => undefined, () => undefined);
      const result = await run;
      session.lastSeenAt = now();
      return json(200, result ?? { jsonrpc: "2.0", id: null, result: null });
    },
  };
}

/**
 * 鉴权。
 *
 * 两种模式：OAuth 令牌（校验通过后拿它的声明当主体）或静态 token。
 * 两者都没有配 → 一律拒绝——**绝不能**出现「没配鉴权就放行」的分支。
 */
async function authenticate(request: HttpRequestLike, options: McpHttpOptions): Promise<AuthOutcome> {
  const token = bearerToken(request);
  const challenge = options.resourceMetadataUrl
    ? `Bearer resource_metadata="${options.resourceMetadataUrl}"`
    : "Bearer";

  if (!token) {
    return { ok: false, response: json(401, { error: { code: -32001, message: "缺少或无效的 Bearer token" } }, { "WWW-Authenticate": challenge }) };
  }

  if (options.oauth) {
    const claims = await options.oauth.authenticate(token);
    if (!claims) {
      return { ok: false, response: json(401, { error: { code: -32001, message: "缺少或无效的 Bearer token" } }, { "WWW-Authenticate": challenge }) };
    }
    const tenantId = claims.tenant ?? options.defaultTenantId ?? "";
    // 配了租户表却没有租户 → 拒绝。绝不「猜一个租户」。
    if (options.tenants && !tenantId) {
      return { ok: false, response: json(403, { error: { code: -32004, message: "令牌没有绑定租户" } }) };
    }
    if (options.tenants && !options.tenants.tenants().some(tenant => tenant.id === tenantId)) {
      return { ok: false, response: json(403, { error: { code: -32004, message: `未知租户：${tenantId}` } }) };
    }
    return {
      ok: true,
      principal: {
        subject: claims.sub,
        tenantId,
        scopes: claims.scope.split(" ").filter(Boolean),
        clientId: claims.clientId,
      },
    };
  }

  if (options.token && token === options.token) {
    return {
      ok: true,
      principal: {
        subject: "static-token",
        tenantId: options.defaultTenantId ?? "",
        scopes: ["design:read", "design:write"],
        clientId: "static",
      },
    };
  }

  return { ok: false, response: json(401, { error: { code: -32001, message: "缺少或无效的 Bearer token" } }, { "WWW-Authenticate": challenge }) };
}

async function resolveServer(principal: McpPrincipal, options: McpHttpOptions): Promise<McpServer> {
  if (options.resolveServer) return options.resolveServer(principal);
  if (options.server) return options.server;
  throw new Error("既没有 server 也没有 resolveServer：MCP 服务端无法处理请求");
}

/** 开一条 SSE 流，把该租户的事件推给客户端。 */
function openEventStream(principal: McpPrincipal, options: McpHttpOptions, context: unknown): HttpResponseLike {
  if (!options.events) return json(405, { error: { code: -32601, message: "服务端未启用事件推送" } });
  if (!options.createStream) return json(501, { error: { code: -32603, message: "服务端没有配置 SSE 流" } });

  const stream = options.createStream(context);
  const unsubscribe = options.events.subscribe(principal.tenantId, notification => {
    stream.write(formatSseEvent(notification));
  });
  stream.onClose(() => unsubscribe());
  // 先发一条注释帧，让客户端确认流已经建立（注释会被 SSE 客户端忽略）。
  stream.write(": connected\n\n");

  return {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
    body: "",
    stream,
  };
}

/** 结束会话（MCP 传输规范里的 DELETE /mcp）。 */
function terminateSession(request: HttpRequestLike, sessions: Map<string, Session>): HttpResponseLike {
  const sessionId = request.headers["mcp-session-id"];
  if (!sessionId) return json(400, { error: { code: -32002, message: "缺少 Mcp-Session-Id" } });
  if (!sessions.delete(sessionId)) return json(404, { error: { code: -32003, message: "会话不存在或已过期" } });
  return json(200, {});
}

function bearerToken(request: HttpRequestLike): string | undefined {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : undefined;
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  return { status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
