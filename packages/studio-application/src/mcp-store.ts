import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

/**
 * MCP 的共享状态存储。
 *
 * 授权服务器的客户端、授权码与令牌都存在**进程内存**里：起两个实例，各自认一半的
 * 客户端，令牌在另一个实例上验不过。SSE 的事件也一样——事件中心在本进程里，
 * 别的进程提交了变更，这边只能靠轮询事务日志发现，延迟 2 秒。
 *
 * 存储接口把「状态放哪」这件事从业务逻辑里拿出来：
 *
 * - {@link createMemoryMcpStore}：进程内存（单实例部署，行为与从前一致）；
 * - {@link createFileMcpStore}：目录里的 JSON 文件（同一台机器上的多个实例共享）。
 *
 * 两种实现都满足同一个契约：**一个实例写进去，另一个实例能读到、能收到通知**。
 *
 * 规格见 `docs/mcp-production.md`。
 */

/** 共享状态存储。 */
export interface McpStateStore {
  /** 读一个键；不存在（或已过期）返回 undefined。 */
  get<T>(key: string): Promise<T | undefined>;
  /** 写一个键；`ttlMs` 是存活时间（毫秒），不给就不过期。 */
  set<T>(key: string, value: T, options?: { ttlMs?: number }): Promise<void>;
  /** 删一个键。 */
  delete(key: string): Promise<void>;
  /** 列出某个前缀下的所有键值（已过期的跳过）。 */
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>;
  /** 订阅某个前缀下的写入；返回取消订阅的函数。 */
  subscribe(prefix: string, listener: (key: string, value: unknown) => void): () => void;
  /** 释放资源（文件监听、定时器）。 */
  close(): void;
}

/** 存进文件的一条记录。 */
interface StoredRecord {
  /** 原始键：文件名是转义过的，原键必须跟着值一起存。 */
  key: string;
  value: unknown;
  /** 过期时间（epoch 毫秒）；没有就是不过期。 */
  expiresAt?: number;
}

/** 内存实现：单实例部署用，行为与从前一致。 */
export function createMemoryMcpStore(): McpStateStore {
  const records = new Map<string, StoredRecord>();
  const listeners = new Map<string, Set<(key: string, value: unknown) => void>>();

  const alive = (record: StoredRecord | undefined): boolean => {
    if (!record) return false;
    if (record.expiresAt === undefined) return true;
    if (record.expiresAt > Date.now()) return true;
    return false;
  };

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const record = records.get(key);
      if (!alive(record)) {
        if (record) records.delete(key);
        return undefined;
      }
      return record!.value as T;
    },

    async set<T>(key: string, value: T, options?: { ttlMs?: number }): Promise<void> {
      const record: StoredRecord = {
        key,
        value,
        ...(options?.ttlMs !== undefined ? { expiresAt: Date.now() + options.ttlMs } : {}),
      };
      records.set(key, record);
      // 本地订阅者立刻收到——同进程的订阅不等文件往返。
      for (const listener of [...(listeners.get(key) ?? [])]) {
        try {
          listener(key, value);
        } catch {
          // 一个订阅者出错不影响其他人。
        }
      }
    },

    async delete(key: string): Promise<void> {
      records.delete(key);
    },

    async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
      const result: Array<{ key: string; value: T }> = [];
      for (const [key, record] of records) {
        if (!key.startsWith(prefix)) continue;
        if (!alive(record)) {
          records.delete(key);
          continue;
        }
        result.push({ key, value: record.value as T });
      }
      return result;
    },

    subscribe(prefix: string, listener: (key: string, value: unknown) => void): () => void {
      const set = listeners.get(prefix) ?? new Set();
      set.add(listener);
      listeners.set(prefix, set);
      return () => {
        const current = listeners.get(prefix);
        if (!current) return;
        current.delete(listener);
        if (!current.size) listeners.delete(prefix);
      };
    },

    close(): void {
      records.clear();
      listeners.clear();
    },
  };
}

/**
 * 文件实现：目录里的 JSON 文件。
 *
 * 同一台机器上的多个实例指向同一个目录，就共享了同一份状态。文件监听（`fs.watch`）
 * 负责「别的实例写了」的通知；另外有一个低频兜底轮询——Windows 上文件事件偶尔会丢，
 * 只靠事件推送会让状态停在旧值。
 *
 * 文件名是键的转义（`:` 之类换成 `_`），所以前缀订阅要按同样规则转义。
 */
export function createFileMcpStore(options: { directory: string; pollIntervalMs?: number }): McpStateStore {
  const directory = options.directory;
  mkdirSync(directory, { recursive: true });
  const listeners = new Map<string, Set<(key: string, value: unknown) => void>>();
  // 文件名是键的转义加一段哈希：转义会把不同字符映射成同一个名字（`a_b` 与 `a:b`），
  // 哈希把这种情况区分开。原始键存在文件内容里，读取时以它为准。
  const fileName = (key: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
    return `${safe}-${hash.toString(16).padStart(8, "0")}.json`;
  };

  const readRecord = (file: string): StoredRecord | undefined => {
    try {
      const raw = readFileSync(join(directory, file), "utf8");
      const parsed = JSON.parse(raw) as StoredRecord;
      if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now()) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  };

  const notify = (key: string, value: unknown): void => {
    for (const [prefix, set] of listeners) {
      if (!key.startsWith(prefix)) continue;
      for (const listener of [...set]) {
        try {
          listener(key, value);
        } catch {
          // 一个订阅者出错不影响其他人。
        }
      }
    }
  };

  // 文件事件：别的实例写了文件就通知。原始键在文件内容里。
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(directory, (_event, file) => {
      if (!file || !file.endsWith(".json")) return;
      const record = readRecord(file);
      if (!record) return;
      notify(record.key, record.value);
    });
  } catch {
    // 目录监听不可用（某些文件系统）：靠下面的兜底轮询。
  }

  // 兜底轮询：文件事件丢的时候，状态还能在几百毫秒内跟上。
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const seen = new Map<string, string>();
  const timer = setInterval(() => {
    let files: string[] = [];
    try {
      files = readdirSync(directory);
    } catch {
      return;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = readRecord(file);
      if (!record) continue;
      const fingerprint = JSON.stringify(record.value);
      if (seen.get(record.key) === fingerprint) continue;
      seen.set(record.key, fingerprint);
      notify(record.key, record.value);
    }
  }, pollIntervalMs);
  // 定时器不该拖住进程退出。
  timer.unref?.();

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return readRecord(fileName(key))?.value as T | undefined;
    },

    async set<T>(key: string, value: T, options?: { ttlMs?: number }): Promise<void> {
      const record: StoredRecord = {
        key,
        value,
        ...(options?.ttlMs !== undefined ? { expiresAt: Date.now() + options.ttlMs } : {}),
      };
      writeFileSync(join(directory, fileName(key)), JSON.stringify(record), "utf8");
      seen.set(key, JSON.stringify(value));
      notify(key, value);
    },

    async delete(key: string): Promise<void> {
      try {
        unlinkSync(join(directory, fileName(key)));
      } catch {
        // 文件本来就不在。
      }
      seen.delete(key);
    },

    async list<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
      let files: string[] = [];
      try {
        files = readdirSync(directory);
      } catch {
        return [];
      }
      const result: Array<{ key: string; value: T }> = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const record = readRecord(file);
        if (!record) continue;
        if (!record.key.startsWith(prefix)) continue;
        result.push({ key: record.key, value: record.value as T });
      }
      return result;
    },

    subscribe(prefix: string, listener: (key: string, value: unknown) => void): () => void {
      const set = listeners.get(prefix) ?? new Set();
      set.add(listener);
      listeners.set(prefix, set);
      return () => {
        const current = listeners.get(prefix);
        if (!current) return;
        current.delete(listener);
        if (!current.size) listeners.delete(prefix);
      };
    },

    close(): void {
      watcher?.close();
      clearInterval(timer);
      listeners.clear();
    },
  };
}
