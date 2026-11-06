import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHttpHandler } from "../src/mcp-http";
import type { McpServer } from "../src/mcp-server";

const TOKEN = "secret-token";

function stubServer(order: string[] = []): McpServer {
  return {
    async handle(message: unknown) {
      const request = message as { id?: number | string; method: string };
      order.push(request.method);
      if (request.method === "slow") await new Promise(resolve => setTimeout(resolve, 15));
      return { jsonrpc: "2.0", id: request.id ?? null, result: { method: request.method } };
    },
  };
}

function handler(overrides: Parameters<typeof createMcpHttpHandler>[0] = {} as never) {
  return createMcpHttpHandler({ server: stubServer(), token: TOKEN, ...overrides });
}

function request(overrides: Partial<Parameters<ReturnType<typeof handler>["handle"]>[0]> = {}) {
  return { method: "POST", url: "/mcp", headers: { authorization: `Bearer ${TOKEN}` } as Record<string, string | undefined>, body: "{}", ...overrides };
}

test("healthz requires the bearer token", async () => {
  const server = handler();
  const unauthorized = await server.handle({ method: "GET", url: "/healthz", headers: {} });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers?.["WWW-Authenticate"], "Bearer");

  const ok = await server.handle({ method: "GET", url: "/healthz", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
});

test("a missing configured token denies everything", async () => {
  const server = createMcpHttpHandler({ server: stubServer(), token: undefined });
  assert.equal((await server.handle(request())).status, 401);
});

test("bearer parsing is case-insensitive and trims whitespace", async () => {
  const server = handler();
  // 鉴权通过之后才会走到会话检查，所以这里期望 400 而不是 401。
  const accepted = await server.handle(request({ headers: { authorization: `  bEaReR   ${TOKEN}  ` } }));
  assert.notEqual(accepted.status, 401);
  const wrong = await server.handle(request({ headers: { authorization: "Bearer other" } }));
  assert.equal(wrong.status, 401);
});

test("initialize issues a session id and later calls must use it", async () => {
  const server = handler();
  const init = await server.handle(request({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }));
  assert.equal(init.status, 200);
  const sessionId = init.headers?.["Mcp-Session-Id"];
  assert.ok(sessionId);
  assert.equal(server.sessionCount(), 1);

  const noSession = await server.handle(request({ body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }));
  assert.equal(noSession.status, 400);
  assert.match(JSON.parse(noSession.body).error.message, /Mcp-Session-Id/);

  const ok = await server.handle(request({ headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId! }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) }));
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).id, 3);
});

test("unknown sessions are rejected and expired sessions are pruned", async () => {
  let clock = 1_000;
  const server = createMcpHttpHandler({ server: stubServer(), token: TOKEN, sessionTtlMs: 100, now: () => clock });
  const init = await server.handle(request({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }));
  const sessionId = init.headers?.["Mcp-Session-Id"];
  assert.ok(sessionId);

  const unknown = await server.handle(request({ headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": "nope" }, body: "{}" }));
  assert.equal(unknown.status, 404);

  clock += 200;
  const expired = await server.handle(request({ headers: { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId }, body: "{}" }));
  assert.equal(expired.status, 404);
  assert.equal(server.sessionCount(), 0);
});

test("malformed payloads, oversized bodies and wrong methods get explicit statuses", async () => {
  const server = handler({ maxBodyBytes: 32 } as never);
  const parseError = await server.handle(request({ body: "{not json" }));
  assert.equal(parseError.status, 400);
  assert.equal(JSON.parse(parseError.body).error.code, -32700);

  const tooLarge = await server.handle(request({ body: JSON.stringify({ jsonrpc: "2.0", method: "x", pad: "a".repeat(64) }) }));
  assert.equal(tooLarge.status, 413);

  const wrongMethod = await server.handle(request({ method: "PUT" }));
  assert.equal(wrongMethod.status, 405);

  const wrongPath = await server.handle(request({ url: "/other" }));
  assert.equal(wrongPath.status, 404);
});

test("requests in the same session run one at a time", async () => {
  const order: string[] = [];
  const server = createMcpHttpHandler({ server: stubServer(order), token: TOKEN });
  const init = await server.handle(request({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }));
  const sessionId = init.headers?.["Mcp-Session-Id"];
  assert.ok(sessionId);
  const headers = { authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId };

  const first = server.handle(request({ headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "slow" }) }));
  const second = server.handle(request({ headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "fast" }) }));
  await Promise.all([first, second]);

  assert.deepEqual(order.filter(method => method !== "initialize"), ["slow", "fast"]);
});
