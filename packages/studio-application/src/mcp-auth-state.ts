import type { OAuthClient, TokenClaims } from "./mcp-auth";
import type { McpStateStore } from "./mcp-store";

/**
 * OAuth 授权服务器的状态存取。
 *
 * 状态有三类：客户端登记、授权码、令牌（访问 + 刷新）。它们原本全是进程内存里的
 * Map——起两个实例，各自认一半的客户端，令牌在另一个实例上验不过，客户端只能
 * 被负载均衡打到「活着」的那一个。
 *
 * 两种实现：
 *
 * - {@link createMemoryOAuthState}：进程内存（单实例部署，行为与从前一致）；
 * - {@link createStoreOAuthState}：共享存储（同一台机器上的多个实例共享同一份）。
 *
 * 键在共享存储里是带前缀的（`oauth:client:` 之类），过期时间交给存储自己管——
 * 授权码 60 秒、访问令牌 1 小时、刷新令牌 30 天。
 */

/** 授权码。 */
export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  tenant?: string;
  subject: string;
  expiresAt: number;
}

/** 存下来的令牌。 */
export interface StoredToken {
  claims: TokenClaims;
  /** 对应的刷新令牌摘要。 */
  refreshHash?: string;
  revoked?: boolean;
}

/** OAuth 状态的存取接口。 */
export interface OAuthState {
  /** 全部客户端。 */
  clients(): Promise<OAuthClient[]>;
  /** 按 id 找一个客户端。 */
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  /** 登记一个客户端；`dynamic` 表示它是动态注册的（默认不被批准）。 */
  putClient(client: OAuthClient, dynamic: boolean): Promise<void>;
  /** 这个客户端是不是动态注册的。 */
  isDynamic(clientId: string): Promise<boolean>;
  /** 存一个授权码。 */
  putCode(hash: string, code: AuthorizationCode, ttlMs: number): Promise<void>;
  /** 取出并删除一个授权码（授权码只能用一次）。 */
  takeCode(hash: string): Promise<AuthorizationCode | undefined>;
  /** 存一个访问令牌。 */
  putAccessToken(hash: string, token: StoredToken, ttlMs: number): Promise<void>;
  /** 存一个刷新令牌。 */
  putRefreshToken(hash: string, token: StoredToken, ttlMs: number): Promise<void>;
  /** 读一个访问令牌。 */
  getAccessToken(hash: string): Promise<StoredToken | undefined>;
  /** 读一个刷新令牌。 */
  getRefreshToken(hash: string): Promise<StoredToken | undefined>;
  /** 全部访问令牌（刷新令牌轮换时要把同一族的旧令牌一起吊销）。 */
  listAccessTokens(): Promise<Array<{ hash: string; token: StoredToken }>>;
  /** 把一个访问令牌标记为已吊销。 */
  revokeAccessToken(hash: string): Promise<void>;
  /** 把一个刷新令牌标记为已吊销。 */
  revokeRefreshToken(hash: string): Promise<void>;
}

/** 进程内存实现：单实例部署用，行为与从前一致。 */
export function createMemoryOAuthState(): OAuthState {
  const clients = new Map<string, OAuthClient>();
  const dynamic = new Set<string>();
  const codes = new Map<string, AuthorizationCode>();
  const access = new Map<string, StoredToken>();
  const refresh = new Map<string, StoredToken>();

  return {
    clients: async () => [...clients.values()],
    getClient: async (clientId) => clients.get(clientId),
    putClient: async (client, isDynamic) => {
      clients.set(client.clientId, client);
      if (isDynamic) dynamic.add(client.clientId);
    },
    isDynamic: async (clientId) => dynamic.has(clientId),
    putCode: async (hash, code) => { codes.set(hash, code); },
    takeCode: async (hash) => {
      const code = codes.get(hash);
      codes.delete(hash);
      return code;
    },
    putAccessToken: async (hash, token) => { access.set(hash, token); },
    putRefreshToken: async (hash, token) => { refresh.set(hash, token); },
    getAccessToken: async (hash) => access.get(hash),
    getRefreshToken: async (hash) => refresh.get(hash),
    listAccessTokens: async () => [...access.entries()].map(([hash, token]) => ({ hash, token })),
    revokeAccessToken: async (hash) => {
      const token = access.get(hash);
      if (token) token.revoked = true;
    },
    revokeRefreshToken: async (hash) => {
      const token = refresh.get(hash);
      if (token) token.revoked = true;
    },
  };
}

/** 共享存储实现：多个实例指向同一个存储就共享同一份状态。 */
export function createStoreOAuthState(store: McpStateStore): OAuthState {
  const clientKey = (clientId: string) => `oauth:client:${clientId}`;
  const dynamicKey = (clientId: string) => `oauth:dynamic:${clientId}`;
  const codeKey = (hash: string) => `oauth:code:${hash}`;
  const accessKey = (hash: string) => `oauth:access:${hash}`;
  const refreshKey = (hash: string) => `oauth:refresh:${hash}`;

  return {
    async clients(): Promise<OAuthClient[]> {
      const entries = await store.list<OAuthClient>("oauth:client:");
      return entries.map(entry => entry.value);
    },
    async getClient(clientId: string): Promise<OAuthClient | undefined> {
      return store.get<OAuthClient>(clientKey(clientId));
    },
    async putClient(client: OAuthClient, dynamic: boolean): Promise<void> {
      await store.set(clientKey(client.clientId), client);
      if (dynamic) await store.set(dynamicKey(client.clientId), true);
    },
    async isDynamic(clientId: string): Promise<boolean> {
      return (await store.get<boolean>(dynamicKey(clientId))) === true;
    },
    async putCode(hash: string, code: AuthorizationCode, ttlMs: number): Promise<void> {
      await store.set(codeKey(hash), code, { ttlMs });
    },
    async takeCode(hash: string): Promise<AuthorizationCode | undefined> {
      const code = await store.get<AuthorizationCode>(codeKey(hash));
      // 授权码只能用一次：用过就删（并发下第二个请求会拿不到）。
      await store.delete(codeKey(hash));
      return code;
    },
    async putAccessToken(hash: string, token: StoredToken, ttlMs: number): Promise<void> {
      await store.set(accessKey(hash), token, { ttlMs });
    },
    async putRefreshToken(hash: string, token: StoredToken, ttlMs: number): Promise<void> {
      await store.set(refreshKey(hash), token, { ttlMs });
    },
    async getAccessToken(hash: string): Promise<StoredToken | undefined> {
      return store.get<StoredToken>(accessKey(hash));
    },
    async getRefreshToken(hash: string): Promise<StoredToken | undefined> {
      return store.get<StoredToken>(refreshKey(hash));
    },
    async listAccessTokens(): Promise<Array<{ hash: string; token: StoredToken }>> {
      const entries = await store.list<StoredToken>("oauth:access:");
      return entries.map(entry => ({ hash: entry.key.slice("oauth:access:".length), token: entry.value }));
    },
    async revokeAccessToken(hash: string): Promise<void> {
      const token = await store.get<StoredToken>(accessKey(hash));
      if (!token) return;
      await store.set(accessKey(hash), { ...token, revoked: true });
    },
    async revokeRefreshToken(hash: string): Promise<void> {
      const token = await store.get<StoredToken>(refreshKey(hash));
      if (!token) return;
      await store.set(refreshKey(hash), { ...token, revoked: true });
    },
  };
}
