# MCP 生产化：OAuth / 多租户 / SSE

> 状态：已交付（2026-11-09）。OAuth 2.1（授权码 + PKCE）、多租户隔离、SSE 推送三项都已实现并有测试。

## 为什么做这三件事

此前的 MCP 传输只有一个静态 Bearer token、一个进程、一个项目。外部 Agent 要规模化接进来，缺三样东西：

| 缺口 | 后果 | 现在怎么做 |
| --- | --- | --- |
| 没有 OAuth | 密钥靠人工分发；客户端拿不到标准化发现文档；没有撤销手段 | 内置 OAuth 2.1 授权服务器（授权码 + PKCE） |
| 没有租户 | 所有接入方看到同一份设计，无法区分「谁改的」 | 令牌带租户，请求按租户路由到各自的项目 |
| 没有推送 | Agent 只能轮询 `design.read`，人类改一次它拉一次全量 | SSE 推送变更通知 |

规格：`docs/mcp-production.md`。端点与配置见 `packages/studio-application/bin/studio-mcp-http.ts` 的文件头注释。

## 一、OAuth 2.1

### 端点

| 端点 | 说明 |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | 授权服务器元数据（RFC 8414） |
| `GET /.well-known/oauth-protected-resource` | 受保护资源元数据（RFC 9728）——MCP 客户端靠它找到授权服务器 |
| `GET /oauth/authorize` | 授权端点，成功时 302 到回调地址并带上 `code` |
| `POST /oauth/token` | 令牌端点：`authorization_code` 与 `refresh_token` |
| `POST /oauth/revoke` | 吊销（RFC 7009） |
| `POST /oauth/register` | 动态客户端注册（RFC 7591），**默认关闭** |

发现文档在**鉴权之前**就能取到——客户端得先知道去哪儿授权。

### 强制 PKCE

授权码流里令牌端点是公开的，不要求 PKCE 的话，攻击者截获授权码就能直接换出访问令牌。OAuth 2.1 因此把 PKCE 对**所有**客户端变成强制项。

本实现照此执行：`code_challenge_method` 只接受 `S256`，`plain` 一律拒绝；没有 `code_challenge` 就不发授权码。

### 授权码是一次性的

授权码只能用一次，且绑定 `client_id` + `redirect_uri` + `code_challenge`。用过的码立刻删除——否则一个被日志记录下来的授权码就能被重放。

### 刷新令牌轮换

用刷新令牌换新令牌时，旧的刷新令牌**立刻作废**，旧的访问令牌一并作废。旧令牌被复制走时，最多只能用一次。

### 令牌按摘要存储

服务端不保存令牌明文，只保存 SHA-256 摘要。进程内存被 dump 出来也拿不到可用的令牌。

### 回调地址必须登记

未登记的回调地址**不会被重定向**——否则就成了开放重定向。回调地址必须是 `https`，或者是本机的 `http://localhost`（本机开发没有 TLS，但不能是任意主机名）。

### 「同意」由宿主决定

本模块不内置同意页。默认规则：**只放行预先登记的客户端**，登记本身即视为管理员的预先授权；动态注册的客户端默认一律拒绝——否则任何人都能给自己发令牌。

要接真正的同意页，实现 `approve` 回调即可。

## 二、多租户隔离

### 模型

每个租户绑定**一个项目 id**。令牌里带租户，服务端据此路由。

- 租户之间共享同一个仓库（磁盘布局不变），但**互相看不到对方的内容**：令牌解析出来的租户决定了能打开哪个项目，别的项目根本不会被碰到。
- 令牌里没带租户时，落到显式配置的默认租户；没有默认租户就拒绝——**绝不猜一个**。
- 租户的项目句柄是**懒加载 + 缓存**的：第一次用到才打开，之后复用。

### 会话绑定租户

`Mcp-Session-Id` 记录了它归属的租户。别的租户拿着这个 id 来用会被拒（404，不是 403——不告诉对方「这个会话存在」）。

### scope

工具声明了需要的 scope：

| 工具 | scope |
| --- | --- |
| `design.read` | `design:read` |
| `design.preview` | `design:read` |
| `design.apply` | `design:write` |

scope 不够时调用被挡下，返回 `scope_denied`，并留下审计记录。**没有主体时不做这层判断**——单租户部署与 stdio 本地调用保持原行为。

### 审计

审计记录现在带**主体**（谁）和**租户**（哪个租户），不再是 `mcp:client` 这种占位。

## 三、SSE 推送

### 端点

`GET /mcp` 开一条 SSE 流。通知格式是标准 JSON-RPC 通知：

```
event: message
data: {"jsonrpc":"2.0","method":"notifications/resources/updated","params":{"uri":"studio://tenant-a/project:a","revision":7,"at":"..."}}

```

分发键一律是租户 id，没有任何「广播给所有人」的入口——跨租户串台是这里最不能出的错。

### 变更从哪来

有两条来源，用**修订号账本**去重，保证同一个修订号只推一次：

1. **本进程提交**：给 `StudioProject` 加了 `onCommit` 订阅接口，提交成功后立刻推。
2. **别的进程提交**：MCP 服务和网页端各开各的项目实例，内存里不共享。要发现人类在网页上改了什么，只能回到**共同的存储**上——轮询事务日志（`listTransactions(projectId, afterRevision)`）看有没有新条目。

第二条是兜底：只覆盖产生了事务的改动，且有轮询延迟（默认 2 秒）。

### 心跳

开流后先发一条 SSE 注释帧（`: connected`），让客户端确认流已建立；注释会被 SSE 客户端忽略。

## 配置

```bash
# 多租户 + OAuth + SSE
STUDIO_PROJECT_DIR=/path \
STUDIO_MCP_OAUTH_ISSUER=https://studio.example.com \
STUDIO_MCP_OAUTH_CLIENTS='[{"clientId":"agent-1","clientSecret":"...","redirectUris":["https://agent.example.com/cb"],"tenants":["t1"],"scopes":["design:read","design:write"]}]' \
STUDIO_MCP_TENANTS='[{"id":"t1","projectId":"project:xxx"}]' \
STUDIO_MCP_SSE=1 \
npm run mcp:http
```

不设 `STUDIO_MCP_OAUTH_ISSUER` 时退回**静态 Bearer token**（`STUDIO_MCP_HTTP_TOKEN`），行为与之前一致。

## 没做的

- **没有真正的同意页**：默认按「预登记即授权」处理，`approve` 回调留给宿主。
- **令牌不落盘**：授权服务器的状态全在进程内存里，进程重启令牌就失效。这对单实例部署够用，多实例需要共享存储。
- **没有刷新令牌吊销端点的独立语义**：吊销访问令牌会连带作废它的刷新令牌，反向没有单独入口。
- **SSE 事件源不是实时的跨进程推送**：跨进程靠轮询事务日志，默认 2 秒延迟。
- **没有限流**：同一租户的请求速率没有限制。
