/**
 * MCP 的事件推送（SSE）。
 *
 * 此前 MCP 只有请求-响应式交互：外部 Agent 想知道「设计改了没」只能反复调
 * `design.read` 轮询。这在真实协作里很浪费——人类在网页上改一个节点，Agent
 * 却在每 5 秒拉一次全量文档。
 *
 * 事件中心按**租户**分发：某个租户的项目变了，只有订阅了这个租户的连接会收到
 * 通知。跨租户串台是这里最不能出的错，所以分发键一律是租户 id，没有任何
 * 「广播给所有人」的入口。
 *
 * 规格见 `docs/mcp-production.md`。
 */

import type { ProjectRepository } from "@ufira/design-persistence";
import type { McpTenantConfig } from "./mcp-tenants";

/** JSON-RPC 通知（没有 id 的消息）。 */
export interface McpNotification {
  /** 方法名，例如 `notifications/resources/updated`。 */
  method: string;
  params?: unknown;
}

export interface McpEventHub {
  /** 订阅某租户的事件；返回取消订阅的函数。 */
  subscribe(tenantId: string, listener: (notification: McpNotification) => void): () => void;
  /** 向某租户的所有订阅者推送一条通知。 */
  publish(tenantId: string, notification: McpNotification): void;
  /** 订阅者数量；不给租户就是总数。 */
  subscriberCount(tenantId?: string): number;
}

export function createMcpEventHub(): McpEventHub {
  const subscribers = new Map<string, Set<(notification: McpNotification) => void>>();

  return {
    subscriberCount(tenantId?: string): number {
      if (tenantId !== undefined) return subscribers.get(tenantId)?.size ?? 0;
      let total = 0;
      for (const listeners of subscribers.values()) total += listeners.size;
      return total;
    },

    subscribe(tenantId: string, listener: (notification: McpNotification) => void): () => void {
      const listeners = subscribers.get(tenantId) ?? new Set();
      listeners.add(listener);
      subscribers.set(tenantId, listeners);
      return () => {
        const current = subscribers.get(tenantId);
        if (!current) return;
        current.delete(listener);
        if (!current.size) subscribers.delete(tenantId);
      };
    },

    publish(tenantId: string, notification: McpNotification): void {
      const listeners = subscribers.get(tenantId);
      if (!listeners?.size) return;
      // 复制一份再发：监听器可能在回调里取消订阅，边发边改集合会漏发或多发。
      for (const listener of [...listeners]) {
        try {
          listener(notification);
        } catch {
          // 一个订阅者出错不能影响其他人——推送失败只影响这一条连接。
        }
      }
    },
  };
}

/**
 * 序列化成 SSE 帧。
 *
 * 格式按 SSE 规范：`event:` 是事件名（客户端可以用 `addEventListener` 按名监听），
 * `data:` 是 JSON-RPC 通知，`id:` 让客户端能记录最后一条事件号（断线重连时用
 * `Last-Event-ID` 续传）。
 */
export function formatSseEvent(notification: McpNotification, id?: string): string {
  const payload = JSON.stringify({ jsonrpc: "2.0", method: notification.method, ...(notification.params !== undefined ? { params: notification.params } : {}) });
  const lines: string[] = [];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push("event: message");
  lines.push(`data: ${payload}`);
  return `${lines.join("\n")}\n\n`;
}

/** 心跳注释帧：穿过代理时保活，客户端会忽略注释。 */
export function formatSseHeartbeat(): string {
  return ": keep-alive\n\n";
}

/**
 * 文档变更通知。
 *
 * `uri` 用 `studio://<租户>/<项目 id>` 的形式——资源标识要能唯一定位，
 * 客户端才能据此判断「要重新拉哪一份」。
 */
export function documentUpdatedNotification(tenantId: string, projectId: string, revision: number): McpNotification {
  return {
    method: "notifications/resources/updated",
    params: {
      uri: `studio://${tenantId}/${projectId}`,
      revision,
      at: new Date().toISOString(),
    },
  };
}

/**
 * 修订号账本：保证同一个修订号只推一次通知。
 *
 * 推送有两条来源——本进程提交后立刻推（`StudioProject.onCommit`），以及轮询发现
 * 别的进程改了仓库。没有这道闸的话，本进程的改动会被推两遍。
 */
export interface TenantRevisionLedger {
  /** 记录一个修订号；只有比上次新才返回 true（表示应该推送）。 */
  note(tenantId: string, revision: number): boolean;
  /** 某租户最近推送过的修订号；没有则返回 -1。 */
  lastRevision(tenantId: string): number;
}

export function createTenantRevisionLedger(): TenantRevisionLedger {
  const revisions = new Map<string, number>();
  return {
    note(tenantId: string, revision: number): boolean {
      const last = revisions.get(tenantId) ?? -1;
      if (revision <= last) return false;
      revisions.set(tenantId, revision);
      return true;
    },
    lastRevision: (tenantId: string) => revisions.get(tenantId) ?? -1,
  };
}

export interface TenantEventPollerOptions {
  repository: ProjectRepository;
  tenants: McpTenantConfig[];
  hub: McpEventHub;
  ledger: TenantRevisionLedger;
  /** 轮询间隔，默认 2000 毫秒。 */
  intervalMs?: number;
  /** 定时器，测试用。 */
  setInterval?(handler: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export interface TenantEventPoller {
  /** 立刻检查一次。 */
  check(): Promise<void>;
  /** 停止轮询。 */
  stop(): void;
}

/**
 * 轮询仓库，发现「别的进程改了文档」。
 *
 * MCP 服务和网页端各开各的项目实例——内存里不共享。要让 Agent 知道人类在网页上
 * 改了东西，只能回到**共同的存储**上看事务日志有没有新条目。这是本实现里唯一
 * 能跨进程发现变更的地方，因此也是 SSE 推送的兜底来源。
 *
 * 只看事务日志：没产生事务的改动（理论上不该有）不会被推送。
 */
export function startTenantEventPoller(options: TenantEventPollerOptions): TenantEventPoller {
  const intervalMs = options.intervalMs ?? 2000;
  const setTimer = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const watching = new Map<string, number>();

  const check = async (): Promise<void> => {
    for (const tenant of options.tenants) {
      try {
        const since = watching.get(tenant.id) ?? -1;
        const entries = await options.repository.listTransactions(tenant.projectId, since);
        if (!entries.length) continue;
        const newest = entries.reduce((max, entry) => Math.max(max, entry.revision), since);
        watching.set(tenant.id, newest);
        if (options.ledger.note(tenant.id, newest)) {
          options.hub.publish(tenant.id, documentUpdatedNotification(tenant.id, tenant.projectId, newest));
        }
      } catch {
        // 读仓库失败不该让轮询停下来——下一轮再试。
      }
    }
  };

  const handle = setTimer(() => { void check(); }, intervalMs);
  return {
    check,
    stop: () => clearTimer(handle),
  };
}
