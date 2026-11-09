/**
 * MCP 的 OAuth 2.1 授权层。
 *
 * 为什么要有这一层：HTTP 传输此前只有一个静态 Bearer token——那是「本机/内网调试」
 * 的做法，规模化接入外部 Agent 时不可用：密钥要人工分发、没有租户概念、客户端
 * 拿不到标准化的发现文档。OAuth 2.1（授权码 + PKCE）把这三件事一次解决：
 *
 * - **标准化**：客户端按 RFC 8414 / RFC 9728 就能自动发现端点，不用人工填 URL；
 * - **租户**：令牌里带租户，服务端据此把请求路由到对应项目；
 * - **可撤销**：客户端可以主动吊销自己的令牌，不必等它自然过期。
 *
 * ## 为什么强制 PKCE
 *
 * 授权码流里，令牌端点是公开的。如果不要求 PKCE，攻击者截获授权码后就能直接
 * 换出访问令牌。OAuth 2.1 因此把 PKCE 对**所有**客户端变成强制项，连有密钥的
 * 机密客户端也一样（S256，不接受 `plain`）。本实现照此执行：`plain` 一律拒绝。
 *
 * ## 授权码是一次性的
 *
 * 授权码只能用一次，且绑定 client_id + redirect_uri + code_challenge。用过即删。
 * 不做「一次性」的话，一个被日志记录下来的授权码就能被重放。
 *
 * ## 令牌在内存里按摘要存储
 *
 * 服务端不保存令牌明文，只保存 SHA-256 摘要。进程内存被 dump 出来也拿不到可用
 * 的令牌。摘要是异步算的（Web Crypto），所以校验路径是异步的。
 *
 * ## 授权码流里的「同意」由宿主决定
 *
 * 本模块不内置同意页。`approve` 回调由宿主提供：默认实现只放行**预先登记**的
 * 客户端——登记本身即视为管理员的预先授权。动态注册的客户端默认一律拒绝，
 * 否则任何人都能给自己发令牌。要接真正的同意页，实现 `approve` 即可。
 *
 * 规格见 `docs/mcp-production.md`。
 */

import type { HttpRequestLike, HttpResponseLike } from "./mcp-http";

export interface OAuthClient {
  clientId: string;
  /** 机密客户端的密钥；公开客户端没有。 */
  clientSecret?: string;
  /** 允许的回调地址，必须精确匹配。 */
  redirectUris: string[];
  /** 允许的授权类型，默认 `["authorization_code", "refresh_token"]`。 */
  grantTypes?: string[];
  /** 这个客户端被允许访问的租户；不填表示所有租户。 */
  tenants?: string[];
  /** 这个客户端被允许申请的 scope；不填表示全部。 */
  scopes?: string[];
  /** 客户端名，写进审计与令牌记录。 */
  name?: string;
}

export interface OAuthClientRegistration {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  grant_types: string[];
  client_name?: string;
  token_endpoint_auth_method: "client_secret_post" | "client_secret_basic" | "none";
}

/** 令牌里带的声明。 */
export interface TokenClaims {
  /** 主体（用户或 Agent）。 */
  sub: string;
  /** 租户；多租户隔离靠它。 */
  tenant?: string;
  scope: string;
  clientId: string;
  issuedAt: number;
  expiresAt: number;
  /** 这次授权的唯一编号；刷新时轮换。 */
  grantId: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface OAuthServerOptions {
  /** 本授权服务器的 issuer，例如 `https://studio.example.com`。 */
  issuer: string;
  /** 预先登记的客户端。 */
  clients?: OAuthClient[];
  /** 是否允许动态客户端注册（RFC 7591）；默认关闭。 */
  allowDynamicRegistration?: boolean;
  /** 访问令牌有效期，默认 1 小时。 */
  accessTokenTtlMs?: number;
  /** 刷新令牌有效期，默认 30 天。 */
  refreshTokenTtlMs?: number;
  /** 授权码有效期，默认 60 秒。 */
  authorizationCodeTtlMs?: number;
  /** 本服务器支持的 scope。 */
  scopes?: string[];
  /** 时间源，测试用。 */
  now?(): number;
  /** 生成随机串，测试用。 */
  randomToken?(): string;
  /**
   * 决定是否批准这次授权请求。
   *
   * 不提供时：只放行**预先登记**的客户端（登记即管理员的预先授权）；
   * 动态注册的客户端一律拒绝。
   */
  approve?(request: OAuthApprovalRequest): Promise<boolean> | boolean;
}

export interface OAuthApprovalRequest {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  scope: string;
  state?: string;
  codeChallenge: string;
  /** 客户端登记的可用租户。 */
  tenants: string[];
}

export interface OAuthServer {
  /** 处理一个 OAuth 相关的请求；不是 OAuth 端点时返回 undefined。 */
  handle(request: HttpRequestLike): Promise<HttpResponseLike | undefined>;
  /** 校验 Bearer 令牌，返回它的声明；无效或过期返回 undefined。 */
  authenticate(token: string): Promise<TokenClaims | undefined>;
  /** 登记一个客户端（动态注册或宿主预登记）。 */
  registerClient(client: OAuthClient): void;
  /** 吊销一个访问令牌；连同它的刷新令牌一起失效。 */
  revoke(accessToken: string): Promise<boolean>;
  /** 客户端清单（不含密钥）。 */
  clients(): Array<{ clientId: string; name?: string; redirectUris: string[]; grantTypes: string[] }>;
}

interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  tenant?: string;
  subject: string;
  expiresAt: number;
}

interface StoredToken {
  claims: TokenClaims;
  /** 对应的刷新令牌摘要。 */
  refreshHash?: string;
  revoked?: boolean;
}

export const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
export const DEFAULT_OAUTH_SCOPES = ["design:read", "design:write"];

export function createOAuthServer(options: OAuthServerOptions): OAuthServer {
  const now = options.now ?? (() => Date.now());
  const randomToken = options.randomToken ?? (() => defaultRandomToken());
  const supportedScopes = options.scopes ?? DEFAULT_OAUTH_SCOPES;

  const clients = new Map<string, OAuthClient>();
  /** 动态注册的客户端：默认不被批准（登记本身要有人负责）。 */
  const dynamicClients = new Set<string>();
  for (const client of options.clients ?? []) clients.set(client.clientId, client);

  const codes = new Map<string, AuthorizationCode>();
  const accessTokens = new Map<string, StoredToken>();
  const refreshTokens = new Map<string, StoredToken>();

  return {
    clients: () => [...clients.values()].map(client => ({
      clientId: client.clientId,
      ...(client.name ? { name: client.name } : {}),
      redirectUris: [...client.redirectUris],
      grantTypes: client.grantTypes ?? ["authorization_code", "refresh_token"],
    })),

    registerClient(client: OAuthClient): void {
      clients.set(client.clientId, client);
    },

    async revoke(accessToken: string): Promise<boolean> {
      const hash = await digest(accessToken);
      const stored = accessTokens.get(hash);
      if (!stored) return false;
      stored.revoked = true;
      if (stored.refreshHash) {
        const refresh = refreshTokens.get(stored.refreshHash);
        if (refresh) refresh.revoked = true;
      }
      return true;
    },

    async authenticate(token: string): Promise<TokenClaims | undefined> {
      const value = token.trim();
      if (!value) return undefined;
      const stored = accessTokens.get(await digest(value));
      if (!stored || stored.revoked) return undefined;
      if (stored.claims.expiresAt <= now()) return undefined;
      return stored.claims;
    },

    async handle(request: HttpRequestLike): Promise<HttpResponseLike | undefined> {
      const method = request.method.toUpperCase();
      const path = (request.url.split("?")[0] ?? "/").replace(/\/+$/, "") || "/";

      if (path === "/.well-known/oauth-authorization-server" && method === "GET") {
        return json(200, authorizationServerMetadata(options.issuer, supportedScopes));
      }
      if (path === "/.well-known/oauth-protected-resource" && method === "GET") {
        return json(200, protectedResourceMetadata(options.issuer, supportedScopes));
      }
      if (path === "/oauth/register" && method === "POST") {
        return registerClient(request, clients, dynamicClients, options, now, randomToken);
      }
      if (path === "/oauth/authorize" && method === "GET") {
        return authorize(request, clients, dynamicClients, codes, options, now, randomToken, supportedScopes);
      }
      if (path === "/oauth/token" && method === "POST") {
        return token(request, clients, codes, accessTokens, refreshTokens, options, now, randomToken);
      }
      if (path === "/oauth/revoke" && method === "POST") {
        return revoke(request, accessTokens, refreshTokens);
      }
      return undefined;
    },
  };
}

/** 授权服务器元数据（RFC 8414）。 */
export function authorizationServerMetadata(issuer: string, scopes: string[]): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    scopes_supported: scopes,
  };
}

/** 受保护资源元数据（RFC 9728）——MCP 客户端靠它找到授权服务器。 */
export function protectedResourceMetadata(issuer: string, scopes: string[]): Record<string, unknown> {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
  };
}

async function registerClient(
  request: HttpRequestLike,
  clients: Map<string, OAuthClient>,
  dynamicClients: Set<string>,
  options: OAuthServerOptions,
  now: () => number,
  randomToken: () => string,
): Promise<HttpResponseLike> {
  if (!options.allowDynamicRegistration) {
    return json(400, { error: "invalid_request", error_description: "未开放动态客户端注册" });
  }
  let payload: Record<string, unknown>;
  try {
    payload = parseFormOrJson(request);
  } catch {
    return json(400, { error: "invalid_request", error_description: "请求体不是合法的表单或 JSON" });
  }
  const redirectUris = Array.isArray(payload.redirect_uris)
    ? payload.redirect_uris.filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!redirectUris.length) return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris 不能为空" });
  for (const uri of redirectUris) {
    const problem = validateRedirectUri(uri);
    if (problem) return json(400, { error: "invalid_redirect_uri", error_description: problem });
  }
  const clientId = `client_${randomToken()}`;
  const clientSecret = `secret_${randomToken()}`;
  const client: OAuthClient = {
    clientId,
    clientSecret,
    redirectUris,
    grantTypes: ["authorization_code", "refresh_token"],
    ...(typeof payload.client_name === "string" ? { name: payload.client_name } : {}),
  };
  clients.set(clientId, client);
  dynamicClients.add(clientId);
  return json(201, {
    client_id: clientId,
    client_secret: clientSecret,
    client_id_issued_at: Math.floor(now() / 1000),
    redirect_uris: redirectUris,
    grant_types: client.grantTypes ?? ["authorization_code", "refresh_token"],
    client_name: client.name,
    token_endpoint_auth_method: "client_secret_post",
  } satisfies OAuthClientRegistration);
}

async function authorize(
  request: HttpRequestLike,
  clients: Map<string, OAuthClient>,
  dynamicClients: Set<string>,
  codes: Map<string, AuthorizationCode>,
  options: OAuthServerOptions,
  now: () => number,
  randomToken: () => string,
  supportedScopes: string[],
): Promise<HttpResponseLike> {
  const params = queryParams(request.url);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const responseType = params.get("response_type") ?? "";
  const state = params.get("state") ?? undefined;
  const scope = params.get("scope") ?? supportedScopes.join(" ");
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";

  const client = clients.get(clientId);
  // 客户端不存在或回调地址没登记时，**不能**重定向——否则就成了开放重定向。
  if (!client) return json(400, { error: "invalid_client", error_description: "未登记的客户端" });
  if (!client.redirectUris.includes(redirectUri)) return json(400, { error: "invalid_redirect_uri", error_description: "回调地址未登记" });
  const uriProblem = validateRedirectUri(redirectUri);
  if (uriProblem) return json(400, { error: "invalid_redirect_uri", error_description: uriProblem });
  if (responseType !== "code") return json(400, { error: "unsupported_response_type", error_description: "只支持 code" });
  // PKCE 是强制的：没有它就不发码。
  if (!codeChallenge) return json(400, { error: "invalid_request", error_description: "缺少 code_challenge（PKCE 是强制的）" });
  if (codeChallengeMethod !== "S256") return json(400, { error: "invalid_request", error_description: "只接受 code_challenge_method=S256" });
  if (codeChallenge.length < 43 || codeChallenge.length > 128) return json(400, { error: "invalid_request", error_description: "code_challenge 长度不合法" });

  const requestedScopes = scope.split(" ").filter(Boolean);
  const allowedScopes = requestedScopes.filter(item => supportedScopes.includes(item));
  if (requestedScopes.length !== allowedScopes.length) {
    const unknown = requestedScopes.filter(item => !supportedScopes.includes(item));
    return json(400, { error: "invalid_scope", error_description: `不支持的 scope：${unknown.join(" ")}` });
  }
  if (client.scopes && !allowedScopes.every(item => client.scopes?.includes(item))) {
    return json(400, { error: "invalid_scope", error_description: "客户端没有该 scope 的授权" });
  }

  const tenant = params.get("tenant") ?? undefined;
  if (client.tenants && tenant && !client.tenants.includes(tenant)) {
    return json(400, { error: "invalid_request", error_description: "客户端没有该租户的权限" });
  }

  const approval: OAuthApprovalRequest = {
    clientId,
    ...(client.name ? { clientName: client.name } : {}),
    redirectUri,
    scope: allowedScopes.join(" "),
    ...(state ? { state } : {}),
    codeChallenge,
    tenants: client.tenants ?? [],
  };
  const approved = options.approve ? await options.approve(approval) : !dynamicClients.has(clientId);
  if (!approved) {
    const location = `${redirectUri}?error=access_denied${state ? `&state=${encodeURIComponent(state)}` : ""}`;
    return { status: 302, headers: { Location: location }, body: "" };
  }

  const code = `mcp_ac_${randomToken()}`;
  codes.set(await digest(code), {
    clientId,
    redirectUri,
    scope: allowedScopes.join(" "),
    codeChallenge,
    ...(tenant ? { tenant } : {}),
    subject: params.get("subject") ?? clientId,
    expiresAt: now() + (options.authorizationCodeTtlMs ?? DEFAULT_AUTHORIZATION_CODE_TTL_MS),
  });
  const location = `${redirectUri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
  return { status: 302, headers: { Location: location }, body: "" };
}

async function token(
  request: HttpRequestLike,
  clients: Map<string, OAuthClient>,
  codes: Map<string, AuthorizationCode>,
  accessTokens: Map<string, StoredToken>,
  refreshTokens: Map<string, StoredToken>,
  options: OAuthServerOptions,
  now: () => number,
  randomToken: () => string,
): Promise<HttpResponseLike> {
  let payload: Record<string, unknown>;
  try {
    payload = parseFormOrJson(request);
  } catch {
    return json(400, { error: "invalid_request", error_description: "请求体不是合法的表单或 JSON" });
  }
  const grantType = String(payload.grant_type ?? "");
  const basic = basicCredentials(request);
  const clientId = String(payload.client_id ?? basic?.clientId ?? "");
  const client = clients.get(clientId);
  if (!client) return json(401, { error: "invalid_client", error_description: "未登记的客户端" });

  if (grantType === "authorization_code") {
    const code = String(payload.code ?? "");
    const redirectUri = String(payload.redirect_uri ?? "");
    const codeVerifier = String(payload.code_verifier ?? "");

    const hash = await digest(code);
    const stored = codes.get(hash);
    // 授权码只能用一次：用过就删。
    codes.delete(hash);
    if (!stored) return json(400, { error: "invalid_grant", error_description: "授权码无效、已用过或已过期" });
    if (stored.expiresAt <= now()) return json(400, { error: "invalid_grant", error_description: "授权码已过期" });
    if (stored.clientId !== clientId) return json(400, { error: "invalid_grant", error_description: "授权码与客户端不匹配" });
    if (stored.redirectUri !== redirectUri) return json(400, { error: "invalid_grant", error_description: "回调地址与授权时不一致" });
    const authError = authenticateClient(request, payload, client, basic);
    if (authError) return authError;
    // PKCE 校验：verifier 的 S256 摘要必须等于授权时登记的 challenge。
    if (!codeVerifier) return json(400, { error: "invalid_grant", error_description: "缺少 code_verifier" });
    if ((await sha256Base64Url(codeVerifier)) !== stored.codeChallenge) {
      return json(400, { error: "invalid_grant", error_description: "code_verifier 校验失败" });
    }

    const issued = await issueTokens({
      subject: stored.subject,
      tenant: stored.tenant,
      scope: stored.scope,
      clientId,
      accessTokens,
      refreshTokens,
      options,
      now,
      randomToken,
    });
    return json(200, issued);
  }

  if (grantType === "refresh_token") {
    const presented = String(payload.refresh_token ?? "");
    const hash = await digest(presented);
    const stored = refreshTokens.get(hash);
    if (!stored || stored.revoked) return json(400, { error: "invalid_grant", error_description: "刷新令牌无效或已被吊销" });
    if (stored.claims.expiresAt <= now()) return json(400, { error: "invalid_grant", error_description: "刷新令牌已过期" });
    if (stored.claims.clientId !== clientId) return json(400, { error: "invalid_grant", error_description: "刷新令牌与客户端不匹配" });
    const authError = authenticateClient(request, payload, client, basic);
    if (authError) return authError;

    // 轮换：旧的刷新令牌立刻作废，旧 access token 一并作废。
    // 旧令牌被复制走时，最多只能用一次。
    stored.revoked = true;
    for (const access of accessTokens.values()) {
      if (access.refreshHash === hash) access.revoked = true;
    }

    const issued = await issueTokens({
      subject: stored.claims.sub,
      tenant: stored.claims.tenant,
      scope: stored.claims.scope,
      clientId: stored.claims.clientId,
      accessTokens,
      refreshTokens,
      options,
      now,
      randomToken,
    });
    return json(200, issued);
  }

  return json(400, { error: "unsupported_grant_type", error_description: `不支持的 grant_type：${grantType}` });
}

async function issueTokens(input: {
  subject: string;
  tenant?: string;
  scope: string;
  clientId: string;
  accessTokens: Map<string, StoredToken>;
  refreshTokens: Map<string, StoredToken>;
  options: OAuthServerOptions;
  now: () => number;
  randomToken: () => string;
}): Promise<TokenResponse> {
  const accessTtl = input.options.accessTokenTtlMs ?? DEFAULT_ACCESS_TOKEN_TTL_MS;
  const refreshTtl = input.options.refreshTokenTtlMs ?? DEFAULT_REFRESH_TOKEN_TTL_MS;
  const accessToken = `mcp_at_${input.randomToken()}`;
  const refreshToken = `mcp_rt_${input.randomToken()}`;
  const accessHash = await digest(accessToken);
  const refreshHash = await digest(refreshToken);
  const issuedAt = input.now();
  const claims: TokenClaims = {
    sub: input.subject,
    ...(input.tenant ? { tenant: input.tenant } : {}),
    scope: input.scope,
    clientId: input.clientId,
    issuedAt,
    expiresAt: issuedAt + accessTtl,
    grantId: input.randomToken(),
  };
  input.accessTokens.set(accessHash, { claims, refreshHash });
  input.refreshTokens.set(refreshHash, { claims: { ...claims, expiresAt: issuedAt + refreshTtl } });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(accessTtl / 1000),
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

/**
 * 客户端认证。
 *
 * 机密客户端可以用 HTTP Basic 或 POST 体带密钥；公开客户端（没有密钥）只能用
 * PKCE，此时这里直接放行——安全性由 code_verifier 校验兜底。
 */
function authenticateClient(
  request: HttpRequestLike,
  payload: Record<string, unknown>,
  client: OAuthClient,
  basic: BasicCredentials | undefined,
): HttpResponseLike | undefined {
  if (!client.clientSecret) return undefined;
  const presented = basic?.clientSecret ?? (typeof payload.client_secret === "string" ? payload.client_secret : undefined);
  if (!presented) return json(401, { error: "invalid_client", error_description: "缺少客户端密钥" });
  if (presented !== client.clientSecret) return json(401, { error: "invalid_client", error_description: "客户端密钥不正确" });
  void request;
  return undefined;
}

interface BasicCredentials {
  clientId: string;
  clientSecret: string;
}

/** 解析 HTTP Basic 头里的客户端 id 与密钥。 */
function basicCredentials(request: HttpRequestLike): BasicCredentials | undefined {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (!header) return undefined;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return undefined;
  try {
    const decoded = atob(match[1]!);
    const separator = decoded.indexOf(":");
    if (separator === -1) return undefined;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
}

async function revoke(
  request: HttpRequestLike,
  accessTokens: Map<string, StoredToken>,
  refreshTokens: Map<string, StoredToken>,
): Promise<HttpResponseLike> {
  let payload: Record<string, unknown>;
  try {
    payload = parseFormOrJson(request);
  } catch {
    return json(400, { error: "invalid_request", error_description: "请求体不是合法的表单或 JSON" });
  }
  const token = String(payload.token ?? "");
  if (!token) return json(400, { error: "invalid_request", error_description: "缺少 token" });
  const stored = accessTokens.get(await digest(token));
  // RFC 7009：吊销不存在的令牌也返回 200，不泄露信息。
  if (stored) {
    stored.revoked = true;
    if (stored.refreshHash) {
      const refresh = refreshTokens.get(stored.refreshHash);
      if (refresh) refresh.revoked = true;
    }
  }
  return json(200, {});
}

/**
 * 回调地址校验。
 *
 * 必须是 https，或者本机地址。`http://localhost` 放行是因为本机开发没有 TLS，
 * 但它**不能**是任意主机名——否则授权码会走明文。
 */
export function validateRedirectUri(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return "回调地址不是合法的 URL";
  }
  if (parsed.protocol === "https:") return undefined;
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol === "http:" && isLocal) return undefined;
  return "回调地址必须是 https，或本机的 http://localhost";
}

/** 表单或 JSON 请求体。 */
export function parseFormOrJson(request: HttpRequestLike): Record<string, unknown> {
  const body = request.body ?? "";
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(body).entries());
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是对象");
  return parsed as Record<string, unknown>;
}

function queryParams(url: string): URLSearchParams {
  const index = url.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : url.slice(index + 1));
}

function json(status: number, payload: unknown): HttpResponseLike {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(payload) };
}

/** 随机串。 */
function defaultRandomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 十六进制摘要。 */
async function digest(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** base64url(SHA-256(verifier))——PKCE 的 S256 方式。 */
async function sha256Base64Url(value: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(hash));
}
