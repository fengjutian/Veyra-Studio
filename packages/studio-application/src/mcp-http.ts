import type { McpServer } from "./mcp-server";

/**
 * MCP over HTTP（精简版）。
 *
 * 只实现流式 HTTP 传输里最常用的一段：`POST /mcp` 收发单条 JSON-RPC，配合
 * `Mcp-Session-Id` 做会话隔离，`GET /healthz` 做存活检查。没有实现 SSE 流式
 * 通知（服务端主动推送），因为当前所有工具都是请求-响应式的。
 *
 * 鉴权只有 Bearer token，没有 OAuth：本机/内网部署够用，公网部署要求在反向代理
 * 上再加一层。默认**拒绝在无 token 的情况下启动**，避免把编辑权限裸奔在局域网上。
 */

export interface HttpRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

export interface HttpResponseLike {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export interface McpHttpOptions {
  server: McpServer;
  /** 必填的访问令牌；为空字符串或 undefined 时所有请求都会被拒绝。 */
  token?: string;
  /** 请求体上限，默认 256 KB。 */
  maxBodyBytes?: number;
  /** 会话空闲多久失效，默认 30 分钟。 */
  sessionTtlMs?: number;
  /** 时间源，测试用。 */
  now?(): number;
  /** 生成会话 id，测试用。 */
  createSessionId?(): string;
}

export interface McpHttpHandler {
  handle(request: HttpRequestLike): Promise<HttpResponseLike>;
  /** 当前活跃会话数，便于监控与测试。 */
  sessionCount(): number;
}

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

interface Session {
  lastSeenAt: number;
  /** 同一会话的请求串行执行，避免两个 initialize/apply 交错。 */
  queue: Promise<unknown>;
}

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

    async handle(request: HttpRequestLike): Promise<HttpResponseLike> {
      const method = request.method.toUpperCase();
      const path = request.url.split("?")[0] ?? "/";

      if (!authorized(request, options.token)) {
        return json(401, { error: { code: -32001, message: "缺少或无效的 Bearer token" } }, { "WWW-Authenticate": "Bearer" });
      }

      if (method === "GET" && path === "/healthz") {
        return json(200, { ok: true, sessions: sessions.size });
      }
      if (path !== "/mcp") return json(404, { error: { code: -32601, message: "Not found" } });
      if (method !== "POST") return json(405, { error: { code: -32601, message: "Use POST /mcp" } }, { Allow: "POST" });

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
        sessions.set(id, { lastSeenAt: now(), queue: Promise.resolve() });
        const result = await options.server.handle(message);
        return json(200, result ?? { jsonrpc: "2.0", id: null, result: {} }, { "Mcp-Session-Id": id });
      }

      if (!sessionId) return json(400, { error: { code: -32002, message: "缺少 Mcp-Session-Id；请先调用 initialize" } });
      const session = sessions.get(sessionId);
      if (!session) return json(404, { error: { code: -32003, message: "会话不存在或已过期" } });

      // 同会话串行：前一个请求失败也不能卡死后续请求。
      const run = session.queue.then(() => options.server.handle(message), () => options.server.handle(message));
      session.queue = run.then(() => undefined, () => undefined);
      const result = await run;
      session.lastSeenAt = now();
      return json(200, result ?? { jsonrpc: "2.0", id: null, result: null });
    },
  };
}

function authorized(request: HttpRequestLike, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return Boolean(match && match[1] === token);
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  return { status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
