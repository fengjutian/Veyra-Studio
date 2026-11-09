import type { ProjectRepository } from "@ufira/design-persistence";
import { StudioProject } from "./studio-project";
import type { McpPolicy } from "./mcp";

/**
 * MCP 的多租户隔离。
 *
 * 此前 HTTP 传输只有一个进程、一个项目、一个静态 token——本机调试够用，但外部
 * Agent 规模化接入时，「谁能看到哪份设计」就是硬需求了。租户模型解决它：
 *
 * - 每个租户绑定**一个项目 id**；令牌里带租户，服务端据此路由。
 * - 租户之间共享同一个仓库（磁盘布局不变），但**互相看不到对方的内容**：
 *   令牌解析出来的租户决定了能打开哪个项目，别的项目的 id 根本不会被碰到。
 * - 令牌里没带租户时，只能落到显式配置的默认租户——没有默认租户就拒绝，
 *   绝不「猜一个」。
 *
 * 租户的项目句柄是**懒加载 + 缓存**的：第一次用到才打开，之后复用。外部 Agent
 * 连上时只会有它自己那个租户被打开，不会因为注册了一百个租户就开一百个句柄。
 */

export interface McpTenantConfig {
  /** 租户 id；会出现在令牌里。 */
  id: string;
  /** 这个租户对应的项目 id。 */
  projectId: string;
  /** 给人看的名字。 */
  label?: string;
  /** 这个租户的授权策略；不填用全局策略。 */
  policy?: McpPolicy;
  /** 访问这个租户需要的 scope；不填表示不额外限制。 */
  scopes?: string[];
}

/** 通过鉴权之后拿到的「谁」。 */
export interface McpPrincipal {
  /** 主体：用户或 Agent。 */
  subject: string;
  /** 租户 id。 */
  tenantId: string;
  /** 这个主体被授予的 scope。 */
  scopes: string[];
  /** 发起请求的客户端。 */
  clientId: string;
}

export interface McpTenantProjects {
  /** 打开（并缓存）某租户的项目；租户不存在返回 undefined。 */
  open(tenantId: string): Promise<StudioProject | undefined>;
  /** 租户清单。 */
  tenants(): McpTenantConfig[];
  /** 某个租户的项目是否已经打开。 */
  isLoaded(tenantId: string): boolean;
  /** 卸载一个租户的句柄（关掉文件监听、释放内存）。 */
  close(tenantId: string): Promise<void>;
  /**
   * 订阅「租户项目被打开」的事件。
   *
   * 外部集成靠它挂变更监听（SSE 推送）——项目是懒加载的，只有真的用到才会打开，
   * 所以监听只能挂在打开的那一刻。
   */
  onOpen(listener: (tenant: McpTenantConfig, project: StudioProject) => void): () => void;
}

export interface TenantProjectsOptions {
  repository: ProjectRepository;
  tenants: McpTenantConfig[];
  /** 打开时的回调，便于挂变更监听。 */
  onOpen?(tenant: McpTenantConfig, project: StudioProject): void;
}

export function createTenantProjects(options: TenantProjectsOptions): McpTenantProjects {
  const configs = new Map<string, McpTenantConfig>();
  for (const tenant of options.tenants) configs.set(tenant.id, tenant);
  const opened = new Map<string, StudioProject>();
  /** 同一个租户的并发 open 只打开一次。 */
  const pending = new Map<string, Promise<StudioProject | undefined>>();
  const openListeners = new Set<(tenant: McpTenantConfig, project: StudioProject) => void>();

  return {
    tenants: () => [...configs.values()],

    isLoaded: tenantId => opened.has(tenantId),

    onOpen(listener: (tenant: McpTenantConfig, project: StudioProject) => void): () => void {
      openListeners.add(listener);
      return () => { openListeners.delete(listener); };
    },

    async close(tenantId: string): Promise<void> {
      opened.delete(tenantId);
      pending.delete(tenantId);
    },

    async open(tenantId: string): Promise<StudioProject | undefined> {
      const tenant = configs.get(tenantId);
      if (!tenant) return undefined;
      const existing = opened.get(tenantId);
      if (existing) return existing;
      const inFlight = pending.get(tenantId);
      if (inFlight) return inFlight;

      const loading = (async () => {
        try {
          const { project } = await StudioProject.open(options.repository, tenant.projectId);
          opened.set(tenantId, project);
          options.onOpen?.(tenant, project);
          for (const listener of [...openListeners]) {
            try {
              listener(tenant, project);
            } catch {
              // 监听者的问题不该让租户打不开。
            }
          }
          return project;
        } finally {
          pending.delete(tenantId);
        }
      })();
      pending.set(tenantId, loading);
      return loading;
    },
  };
}

/**
 * 主体能不能访问某租户。
 *
 * 令牌上的租户必须**恰好**是这个租户——不做「管理员能看所有租户」这种放宽：
 * 放宽了就没有隔离可言了。需要跨租户的管理员，另走一条显式的接口。
 */
export function tenantAccessible(principal: McpPrincipal, tenantId: string): boolean {
  return principal.tenantId === tenantId;
}

/**
 * 主体在某个租户上的 scope。
 *
 * 租户可以额外要求 scope（例如只允许读不许写）。令牌没有 scope 时按「只读」算——
 * 默认拒绝比默认放行安全。
 */
export function effectiveScopes(principal: McpPrincipal, tenant: McpTenantConfig | undefined): string[] {
  const granted = principal.scopes;
  if (!tenant?.scopes?.length) return granted;
  return granted.filter(scope => tenant.scopes!.includes(scope));
}

/** scope 是否包含某个能力。 */
export function hasScope(scopes: readonly string[], scope: string): boolean {
  return scopes.includes(scope);
}
