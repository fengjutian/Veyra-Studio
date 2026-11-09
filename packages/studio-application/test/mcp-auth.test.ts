import assert from "node:assert/strict";
import test from "node:test";
import { createOAuthServer, validateRedirectUri, type OAuthClient } from "../src/mcp-auth";
import type { HttpRequestLike } from "../src/mcp-http";

const ISSUER = "https://studio.example.test";

/** 固定的随机串：便于断言。 */
function fixedTokens(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}${++counter}`;
}

/** base64url(SHA-256(verifier))——PKCE 的 S256 方式。 */
async function challengeFor(verifier: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

function server(overrides: Partial<Parameters<typeof createOAuthServer>[0]> = {}) {
  return createOAuthServer({ issuer: ISSUER, clients: [CLIENT], randomToken: fixedTokens("tok"), ...overrides });
}

test("发现文档：授权服务器与受保护资源元数据", async () => {
  const oauth = server();
  const as = await oauth.handle(get("/.well-known/oauth-authorization-server"));
  assert.equal(as?.status, 200);
  const metadata = JSON.parse(as!.body);
  assert.equal(metadata.issuer, ISSUER);
  assert.equal(metadata.token_endpoint, `${ISSUER}/oauth/token`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);

  const resource = await oauth.handle(get("/.well-known/oauth-protected-resource"));
  assert.equal(resource?.status, 200);
  assert.deepEqual(JSON.parse(resource!.body).authorization_servers, [ISSUER]);
});

test("完整的授权码流程：授权 → 换令牌 → 访问 → 刷新", async () => {
  const oauth = server();
  const verifier = "a".repeat(64);
  const challenge = await challengeFor(verifier);

  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&scope=${encodeURIComponent("design:read design:write")}`
    + `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&state=xyz&tenant=tenant-a`,
  ));
  assert.equal(authorize?.status, 302);
  const location = authorize!.headers!.Location!;
  assert.ok(location.startsWith(`${CLIENT.redirectUris[0]}?code=`));
  assert.ok(location.includes("state=xyz"));
  const code = new URL(location).searchParams.get("code")!;
  assert.ok(code);

  const exchanged = await oauth.handle(post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "secret-1",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: verifier,
  }));
  assert.equal(exchanged?.status, 200);
  const tokens = JSON.parse(exchanged!.body);
  assert.equal(tokens.token_type, "Bearer");
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.equal(tokens.scope, "design:read design:write");

  const claims = await oauth.authenticate(tokens.access_token);
  assert.equal(claims?.tenant, "tenant-a");
  assert.equal(claims?.clientId, "client-1");
  assert.equal(claims?.sub, "client-1");

  const refreshed = await oauth.handle(post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: "client-1",
    client_secret: "secret-1",
  }));
  assert.equal(refreshed?.status, 200);
  const next = JSON.parse(refreshed!.body);
  assert.notEqual(next.access_token, tokens.access_token);
  assert.equal((await oauth.authenticate(next.access_token))?.tenant, "tenant-a");
});

test("授权码只能用一次：重放被拒", async () => {
  const oauth = server();
  const verifier = "b".repeat(64);
  const challenge = await challengeFor(verifier);
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
  ));
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;

  const body = {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "secret-1",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: verifier,
  };
  const first = await oauth.handle(post("/oauth/token", body));
  assert.equal(first?.status, 200);
  const second = await oauth.handle(post("/oauth/token", body));
  assert.equal(second?.status, 400);
  assert.equal(JSON.parse(second!.body).error, "invalid_grant");
});

test("刷新令牌轮换：旧的立刻作废", async () => {
  const oauth = server();
  const verifier = "c".repeat(64);
  const challenge = await challengeFor(verifier);
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
  ));
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle(post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "secret-1",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: verifier,
  }));
  const refreshToken = JSON.parse(exchanged!.body).refresh_token;

  const first = await oauth.handle(post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: "client-1",
    client_secret: "secret-1",
  }));
  assert.equal(first?.status, 200);
  // 同一个刷新令牌再换一次就该失败——被复制走的旧令牌最多只能用一次。
  const replay = await oauth.handle(post("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: "client-1",
    client_secret: "secret-1",
  }));
  assert.equal(replay?.status, 400);
});

test("PKCE 是强制的：没有 challenge 就不发码，plain 也不接受", async () => {
  const oauth = server();
  const noChallenge = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}&response_type=code`,
  ));
  assert.equal(noChallenge?.status, 400);
  assert.match(JSON.parse(noChallenge!.body).error_description, /PKCE/);

  const plain = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=abc&code_challenge_method=plain`,
  ));
  assert.equal(plain?.status, 400);
  assert.match(JSON.parse(plain!.body).error_description, /S256/);
});

test("code_verifier 对不上就换不出令牌", async () => {
  const oauth = server();
  const challenge = await challengeFor("d".repeat(64));
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
  ));
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle(post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "secret-1",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: "wrong-verifier-that-is-long-enough-to-pass-length-check",
  }));
  assert.equal(exchanged?.status, 400);
  assert.match(JSON.parse(exchanged!.body).error_description, /code_verifier/);
});

test("未登记的回调地址不会被重定向（不制造开放重定向）", async () => {
  const oauth = server();
  const response = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent("https://evil.test/steal")}&response_type=code`
    + `&code_challenge=${encodeURIComponent("x".repeat(43))}&code_challenge_method=S256`,
  ));
  assert.equal(response?.status, 400);
  assert.equal(response?.headers?.Location, undefined);
});

test("客户端密钥不对就换不出令牌", async () => {
  const oauth = server();
  const verifier = "e".repeat(64);
  const challenge = await challengeFor(verifier);
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
  ));
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle(post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "wrong",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: verifier,
  }));
  assert.equal(exchanged?.status, 401);
});

test("吊销之后令牌立刻失效", async () => {
  const oauth = server();
  const verifier = "f".repeat(64);
  const challenge = await challengeFor(verifier);
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
  ));
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle(post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "secret-1",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: verifier,
  }));
  const accessToken = JSON.parse(exchanged!.body).access_token;
  assert.ok(await oauth.authenticate(accessToken));
  assert.equal(await oauth.revoke(accessToken), true);
  assert.equal(await oauth.authenticate(accessToken), undefined);
});

test("过期令牌不再被接受", async () => {
  let clock = 1_000;
  const oauth = server({ now: () => clock, accessTokenTtlMs: 500 });
  const verifier = "g".repeat(64);
  const challenge = await challengeFor(verifier);
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
  ));
  const code = new URL(authorize!.headers!.Location!).searchParams.get("code")!;
  const exchanged = await oauth.handle(post("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: "client-1",
    client_secret: "secret-1",
    redirect_uri: CLIENT.redirectUris[0]!,
    code_verifier: verifier,
  }));
  const accessToken = JSON.parse(exchanged!.body).access_token;
  clock += 1_000;
  assert.equal(await oauth.authenticate(accessToken), undefined);
});

test("动态注册默认关闭；开放后也默认不批准授权", async () => {
  const closed = server();
  const rejected = await closed.handle({
    method: "POST",
    url: "/oauth/register",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://agent.example.test/cb"] }),
  });
  assert.equal(rejected?.status, 400);

  const open = server({ allowDynamicRegistration: true });
  const registered = await open.handle({
    method: "POST",
    url: "/oauth/register",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://agent.example.test/cb"], client_name: "agent" }),
  });
  assert.equal(registered?.status, 201);
  const dynamic = JSON.parse(registered!.body);

  const authorize = await open.handle(get(
    `/oauth/authorize?client_id=${dynamic.client_id}&redirect_uri=${encodeURIComponent("https://agent.example.test/cb")}`
    + `&response_type=code&code_challenge=${encodeURIComponent("y".repeat(43))}&code_challenge_method=S256`,
  ));
  // 默认不批准：重定向回去带上 access_denied。
  assert.equal(authorize?.status, 302);
  assert.match(authorize!.headers!.Location!, /error=access_denied/);
});

test("宿主可以接管批准决定", async () => {
  const oauth = server({ approve: () => true });
  const authorize = await oauth.handle(get(
    `/oauth/authorize?client_id=client-1&redirect_uri=${encodeURIComponent(CLIENT.redirectUris[0]!)}`
    + `&response_type=code&code_challenge=${encodeURIComponent("z".repeat(43))}&code_challenge_method=S256`,
  ));
  assert.equal(authorize?.status, 302);
  assert.match(authorize!.headers!.Location!, /code=/);
});

test("回调地址必须是 https 或本机", () => {
  assert.equal(validateRedirectUri("https://agent.example.test/cb"), undefined);
  assert.equal(validateRedirectUri("http://localhost:1234/cb"), undefined);
  assert.equal(validateRedirectUri("http://127.0.0.1/cb"), undefined);
  assert.ok(validateRedirectUri("http://agent.example.test/cb"));
  assert.ok(validateRedirectUri("not a url"));
});
