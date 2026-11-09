/**
 * 存储布局的版本与迁移。
 *
 * 文档格式有自己的迁移链（`design-schema/src/migrate.ts`）；这里管的是**存储布局**
 * ——manifest 字段、IndexedDB 表结构这类「数据放在哪、长什么样」的变化。
 * 两者是不同的东西：文档格式变了要升级每一份文档，布局变了只要把容器升上来。
 *
 * 设计沿用文档迁移的三条纪律：
 *
 * 1. **版本号只有一个来源**（`CURRENT_STORAGE_VERSION`），读路径必须经过它；
 * 2. **步骤表**（`STORAGE_MIGRATIONS`）按「旧 → 新」登记，不允许跳跃升级；
 * 3. **未来版本一律拒绝**：比当前应用新的布局可能含有本版本不认识的字段/表，
 *    猜着读只会写出半坏的存储。
 *
 * 迁移函数只改**内存状态**；真正的结构变更由后端自己完成——文件系统重写
 * `manifest.json`（并留原始备份），浏览器由 Dexie 的 `version(n).stores()` 建表，
 * 这里只负责版本判定、步骤编排与迁移历史。
 */

/** 存储后端。两个后端的布局各自演进，但共用同一套迁移机制。 */
export type StorageBackend = "filesystem" | "browser";

/** 一次已应用的布局迁移。与文档的 `migrations` 历史同构，便于在恢复报告里展示。 */
export interface StorageMigrationRecord {
  from: number;
  to: number;
  description: string;
  at: string;
}

/** 迁移的输入/输出状态。 */
export interface StorageLayoutState {
  /** 当前布局版本；1 表示最早的一版（没有版本号字段）。 */
  version: number;
  /** 最近一份快照的文档格式版本（能查到才填）。 */
  documentSchemaVersion?: number;
  /** 已应用的迁移历史。 */
  migrations: StorageMigrationRecord[];
}

/** 一步布局迁移。 */
export interface StorageMigrationStep {
  from: number;
  to: number;
  description: string;
  /**
   * 只改状态，不做 IO。
   *
   * 必须把 `version` 推进到 `to`——迁移引擎会校验这一点，
   * 写错的步骤不会悄悄留下「版本没动」的死循环。
   */
  migrate(state: StorageLayoutState): StorageLayoutState;
}

/** 各后端当前的布局版本。 */
export const CURRENT_STORAGE_VERSION: Record<StorageBackend, number> = {
  /** v2：manifest 增加 `storageVersion` 与 `documentSchemaVersion`。 */
  filesystem: 2,
  /** v2 新增 `snapshotHistory`，v3 新增 `baselines`（与 Dexie 的 schema 版本一一对应）。 */
  browser: 3,
};

/** 各后端的迁移步骤表。 */
export const STORAGE_MIGRATIONS: Record<StorageBackend, readonly StorageMigrationStep[]> = {
  filesystem: [
    {
      from: 1,
      to: 2,
      description: "manifest 增加 storageVersion 与 documentSchemaVersion",
      // 字段由调用方在写回时补齐；状态里只需推进版本与保留文档格式版本。
      migrate: state => ({ ...state, version: 2 }),
    },
  ],
  browser: [
    {
      from: 1,
      to: 2,
      description: "新增 snapshotHistory 表（历史快照）",
      migrate: state => ({ ...state, version: 2 }),
    },
    {
      from: 2,
      to: 3,
      description: "新增 baselines 表（重建基线）",
      migrate: state => ({ ...state, version: 3 }),
    },
  ],
};

/** 布局版本无法安全处理时抛出。 */
export class StorageMigrationError extends Error {
  constructor(
    public readonly backend: StorageBackend,
    public readonly version: number,
    message: string,
  ) {
    super(message);
    this.name = "StorageMigrationError";
  }
}

/**
 * 从原始值推断布局版本。
 *
 * 没有版本号（`undefined` / 非法值）= 最早的一版（1）——旧项目就是这种情况，
 * 不能因为「缺个字段」把数据判成损坏。
 */
export function detectStorageLayoutVersion(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) return raw;
  return 1;
}

/** 迁移结果。 */
export interface StorageMigrationResult {
  state: StorageLayoutState;
  /** 本次新应用（并已记入历史）的步骤。 */
  applied: StorageMigrationRecord[];
  /** 版本是否发生了变化。 */
  changed: boolean;
}

/**
 * 把布局状态升到当前版本。
 *
 * 逐级执行，缺步骤直接报错而不是跳过——跳跃升级会漏掉中间的结构变更。
 * `now` 可注入，测试不需要伪造时钟。
 */
export function migrateStorageLayout(
  backend: StorageBackend,
  state: StorageLayoutState,
  options: { now?: () => Date } = {},
): StorageMigrationResult {
  const current = CURRENT_STORAGE_VERSION[backend];
  const now = options.now ?? (() => new Date());

  if (!Number.isInteger(state.version) || state.version < 1) {
    throw new StorageMigrationError(backend, state.version, `Invalid ${backend} storage layout version: ${state.version}`);
  }
  if (state.version > current) {
    throw new StorageMigrationError(
      backend,
      state.version,
      `${backend} storage layout v${state.version} is newer than this app supports (v${current}); refusing to open it`,
    );
  }

  let next: StorageLayoutState = { ...state, migrations: [...state.migrations] };
  const applied: StorageMigrationRecord[] = [];

  while (next.version < current) {
    const step = STORAGE_MIGRATIONS[backend].find(item => item.from === next.version);
    if (!step) {
      throw new StorageMigrationError(backend, next.version, `No ${backend} storage migration step from v${next.version}`);
    }
    const migrated = step.migrate(next);
    if (migrated.version !== step.to) {
      throw new StorageMigrationError(
        backend,
        next.version,
        `${backend} storage migration v${step.from} → v${step.to} left the version at ${migrated.version}`,
      );
    }
    const record: StorageMigrationRecord = {
      from: step.from,
      to: step.to,
      description: step.description,
      at: now().toISOString(),
    };
    next = { ...migrated, migrations: [...migrated.migrations, record] };
    applied.push(record);
  }

  return { state: next, applied, changed: applied.length > 0 };
}

/** 迁移历史里最近的一步（恢复报告用）；没有历史时返回 `undefined`。 */
export function latestStorageMigration(migrations: readonly StorageMigrationRecord[]): StorageMigrationRecord | undefined {
  return migrations.length ? migrations[migrations.length - 1] : undefined;
}
