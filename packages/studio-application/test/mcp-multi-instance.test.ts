import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOAuthServer, type OAuthClient } from "../src/mcp-auth";
import { createStoreOAuthState } from "../src/mcp-auth-state";
import { createMcpEventHub } from "../src/mcp-events";
import { createFileMcpStore } from "../src/mcp-store";
import type { HttpRequestLike } from "../src/mcp-http";

/**
 * 多实例：共享存储让 OAuth 状态与事件跨实例可见。
 *
 * 规格见 `docs/mcp-production.md`。
 */

const ISSUER = "https://studio.example.test";

const CLIENT: OAuthClient = {
  clientId: "client-1",
  clientSecret: "secret-1",
  redirectUris: ["https://agent.example.test/callback"],
  tenants: ["tenant-a"],
};

function get(url: string): HttpRequestLike {
  return { method: "GET", url, headers: {} };
}

function post(url: string, body: Record<string, string>): HttpRequestLike {
  return {
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  };
}

/** base64url(SHA-256(verifier))——PKCE 的 S256 方式。 */
async function challengeFor(verifier: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 一个临时目录（共享存储的落点）。 */
function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "studio-mcp-store-"));
}

test("多实例：客户端登记与授权码跨实例可见（另一个实例能换出令牌）", async () => {
  const directory = temporaryDirectory();
  const storeA = createFileMcpStore({ directory, pollIntervalMs: 50 });
  const storeB = createFileMcpStore({ directory, pollIntervalMs: 50 });
  try {
    const serverA = createOAuthServer({
      issuer: ISSUER,
      clients: [CLIENT],
      state: createStoreOAuthState(storeA),
    });
    const serverB = createOAuthServer({
      issuer: ISSUER,
      // 实例 B 自己没有预登记客户端：它得从共享存储里读到实例 A 登记的。
      state: createStoreOAuthState(storeB),
    });

    const verifier = "v".repeat(64);
    const challenge = await challengeFor(verifier);
    const authorized = await serverA.handle(get(
      `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
      + `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&tenant=tenant-a`,
    ));
    assert.equal(authorized?.status, 302);
    const code = new URL(authorized!.headers!.Location!).searchParams.get("code")!;
    assert.ok(code);

    // 授权码是在实例 A 上发的，却在实例 B 上换成了令牌。
    const exchanged = await serverB.handle(post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT.redirectUris[0]!,
      client_id: "client-1",
      client_secret: "secret-1",
      code_verifier: verifier,
    }));
    assert.equal(exchanged?.status, 200);
    const payload = JSON.parse(exchanged!.body) as { access_token: string };
    assert.ok(payload.access_token);

    // 令牌在实例 A 上也验得过——状态是共享的，不是各签各的。
    const claims = await serverA.authenticate(payload.access_token);
    assert.ok(claims, "令牌应该在另一个实例上也能验证");
    assert.equal(claims!.tenant, "tenant-a");
  } finally {
    storeA.close();
    storeB.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多实例：吊销跨实例生效", async () => {
  const directory = temporaryDirectory();
  const storeA = createFileMcpStore({ directory, pollIntervalMs: 50 });
  const storeB = createFileMcpStore({ directory, pollIntervalMs: 50 });
  try {
    const serverA = createOAuthServer({ issuer: ISSUER, clients: [CLIENT], state: createStoreOAuthState(storeA) });
    const serverB = createOAuthServer({ issuer: ISSUER, clients: [CLIENT], state: createStoreOAuthState(storeB) });
    // 直接放一个令牌进去（B 实例签发）。
    const verifier = "v".repeat(64);
    const challenge = await challengeFor(verifier);
    const authorized = await serverB.handle(get(
      `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
      + `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&tenant=tenant-a`,
    ));
    const code = new URL(authorized!.headers!.Location!).searchParams.get("code")!;
    const exchanged = await serverB.handle(post("/oauth/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: CLIENT.redirectUris[0]!,
      client_id: "client-1",
      client_secret: "secret-1",
      code_verifier: verifier,
    }));
    const token = (JSON.parse(exchanged!.body) as { access_token: string }).access_token;

    // A 实例吊销，B 实例立刻验不过。
    assert.equal(await serverA.revoke(token), true);
    assert.equal(await serverB.authenticate(token), undefined);
  } finally {
    storeA.close();
    storeB.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多实例：事件跨实例到达（SSE 不必等轮询）", async () => {
  const directory = temporaryDirectory();
  const storeA = createFileMcpStore({ directory, pollIntervalMs: 50 });
  const storeB = createFileMcpStore({ directory, pollIntervalMs: 50 });
  try {
    const hubA = createMcpEventHub({ store: storeA });
    const hubB = createMcpEventHub({ store: storeB });
    const received: string[] = [];
    hubB.subscribe("tenant-a", notification => received.push(notification.method));

    hubA.publish("tenant-a", { method: "notifications/resources/updated", params: { revision: 7 } });

    // 等文件监听（或兜底轮询）把事件送过来。
    const deadline = Date.now() + 3000;
    while (!received.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.deepEqual(received, ["notifications/resources/updated"]);
  } finally {
    storeA.close();
    storeB.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多实例：事件只投一次（文件监听与兜底轮询都报也不会重复）", async () => {
  const directory = temporaryDirectory();
  const storeA = createFileMcpStore({ directory, pollIntervalMs: 50 });
  const storeB = createFileMcpStore({ directory, pollIntervalMs: 50 });
  try {
    const hubA = createMcpEventHub({ store: storeA });
    const hubB = createMcpEventHub({ store: storeB });
    const received: string[] = [];
    hubB.subscribe("tenant-a", notification => received.push(notification.method));

    hubA.publish("tenant-a", { method: "notifications/resources/updated" });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(received, ["notifications/resources/updated"]);
  } finally {
    storeA.close();
    storeB.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("多实例：没有共享存储时状态仍是各自独立的（单实例行为不变）", async () => {
  const serverA = createOAuthServer({ issuer: ISSUER, clients: [CLIENT] });
  const serverB = createOAuthServer({ issuer: ISSUER });
  assert.equal((await serverB.clients()).length, 0);
  assert.equal((await serverA.clients()).length, 1);
});
