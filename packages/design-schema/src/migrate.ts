import { validateDocument } from "./validate";
import type { DesignDocument, MigrationRecord } from "./types";

/**
 * 当前设计文档的格式版本。
 *
 * 每当文档的持久化形状发生不向后兼容的变化，就把这个数字加一，并在
 * {@link MIGRATIONS} 里补上 `旧版本 → 新版本` 的那一步。读取旧文档的入口
 * （仓库恢复、JSON 导入）必须先跑 {@link migrateDocument}，再交给校验器。
 */
export const CURRENT_SCHEMA_VERSION = 4;

export interface MigrationContext {
  /** 迁移发生的时间；测试可以注入固定值以保证可重复。 */
  now: string;
}

/**
 * 单步迁移：把 `version` 形状的文档变成 `version + 1` 形状。
 *
 * 迁移步骤必须是纯函数，不能依赖外部状态；抛出的异常会被转换成
 * {@link MigrationError}，原文档保持不变。
 */
export type MigrationStep = (document: Record<string, unknown>, context: MigrationContext) => Record<string, unknown>;

/**
 * 迁移步骤表：键是源版本，值是把该版本升到下一版的步骤。
 *
 * v1 → v2：文档格式版本升到 2，并把这次迁移写进文档自带的 `migrations` 历史。
 * v2 → v3：填充从单值 `appearance.fill: string` 改成填充层 `appearance.fills: Paint[]`。
 * v3 → v4：布局模式新增 `grid`，并给 Grid 容器补上缺省的轨道配置。
 */
export const MIGRATIONS: Record<number, MigrationStep> = {
  1: (document, { now }) => {
    const history = Array.isArray(document.migrations)
      ? document.migrations.filter(entry => isMigrationRecord(entry))
      : [];
    return { ...document, schemaVersion: 2, migrations: [...history, { from: 1, to: 2, at: now }] };
  },
  2: (document, { now }) => {
    const nodes = isRecord(document.nodes) ? document.nodes : {};
    const migrated: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(nodes)) {
      migrated[id] = migrateNodeFills(value);
    }
    const history = Array.isArray(document.migrations)
      ? document.migrations.filter(entry => isMigrationRecord(entry))
      : [];
    return { ...document, schemaVersion: 3, nodes: migrated, migrations: [...history, { from: 2, to: 3, at: now }] };
  },
  3: (document, { now }) => {
    // Grid 容器必须带轨道配置，否则校验会拒绝。
    // 旧版本不可能产出 `mode: "grid"`（枚举里没有这个值），所以这一步实际上
    // 只处理「文档被人为改过」的极端情况：补上缺省轨道，让它仍然可打开。
    const nodes = isRecord(document.nodes) ? document.nodes : {};
    const migrated: Record<string, unknown> = {};
    for (const [id, value] of Object.entries(nodes)) {
      migrated[id] = migrateNodeGrid(value);
    }
    const history = Array.isArray(document.migrations)
      ? document.migrations.filter(entry => isMigrationRecord(entry))
      : [];
    return { ...document, schemaVersion: 4, nodes: migrated, migrations: [...history, { from: 3, to: 4, at: now }] };
  },
};

/**
 * 单个节点的 Grid 迁移：给 `mode: "grid"` 但缺 `grid` 配置的节点补上缺省轨道。
 *
 * 缺省给一条 `auto` 轨道——子节点按顺序填进去，至少不会因为「配置缺失」
 * 而让整份文档打不开。
 */
function migrateNodeGrid(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.layout)) return value;
  const layout = value.layout as Record<string, unknown>;
  if (layout.mode !== "grid" || isRecord(layout.grid)) return value;
  return {
    ...value,
    layout: {
      ...layout,
      grid: { columns: [{ type: "auto" }], rows: [{ type: "auto" }], columnGap: 0, rowGap: 0 },
    },
  };
}

/**
 * 单个节点的填充迁移：`fill: "#fff"` → `fills: [{ type: "solid", color: "#fff" }]`。
 *
 * 只做这一件事：没有 fill 的节点原样返回（不能凭空造一个 `fills: []`，那会把
 * 「无填充」和「空填充层」两种语义混掉）。
 */
function migrateNodeFills(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.appearance)) return value;
  const appearance = value.appearance as Record<string, unknown>;
  const fill = appearance.fill;
  if (typeof fill !== "string" || !fill) {
    const { fill: _ignored, ...rest } = appearance;
    return { ...value, appearance: rest };
  }
  const { fill: _ignored, ...rest } = appearance;
  return { ...value, appearance: { ...rest, fills: [{ type: "solid", color: fill }] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface MigrationOptions {
  /** 迁移时间戳；默认取当前时间。 */
  now?: string;
}

export interface MigrationSuccess {
  document: DesignDocument;
  /** 迁移前的格式版本。 */
  fromVersion: number;
  /** 迁移后的格式版本，等于 {@link CURRENT_SCHEMA_VERSION}。 */
  toVersion: number;
  /** 本次实际执行的迁移步骤。 */
  applied: MigrationRecord[];
}

/**
 * 迁移失败。
 *
 * 用异常而不是返回值来表示失败，是为了让调用方在严格模式和宽松模式下写法
 * 一致：{@link migrateDocument} 成功就返回文档，失败就抛这个错误，原始数据
 * 一点都不会被动过。
 */
export class MigrationError extends Error {
  constructor(message: string, public readonly fromVersion?: number) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * 读取文档声明的格式版本。
 *
 * 返回 undefined 表示这份数据没有可识别的版本号（早期原型产物，或者根本
 * 不是设计文档），调用方应当拒绝继续，而不是猜一个版本。
 */
export function detectSchemaVersion(input: unknown): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  return version;
}

/**
 * 把任意来源的文档升级到当前格式版本。
 *
 * 这是唯一允许把旧文档变成新文档的入口：仓库恢复、JSON 导入都必须先调用它。
 * 迁移失败时抛出 {@link MigrationError}，原始数据保持不变，调用方可以把它
 * 退回给用户或者继续用旧版本打开。
 */
export function migrateDocument(input: unknown, options: MigrationOptions = {}): MigrationSuccess {
  const toVersion = CURRENT_SCHEMA_VERSION;
  const fromVersion = detectSchemaVersion(input);
  if (fromVersion === undefined) {
    throw new MigrationError("文档缺少可识别的 schemaVersion，无法确定格式版本");
  }
  if (fromVersion > toVersion) {
    throw new MigrationError(`文档版本 ${fromVersion} 高于当前支持的版本 ${toVersion}，请先升级 Studio`, fromVersion);
  }
  if (fromVersion === toVersion) {
    try {
      return { document: validateDocument(input), fromVersion, toVersion, applied: [] };
    } catch (error) {
      throw new MigrationError(errorMessage(error), fromVersion);
    }
  }

  const now = options.now ?? new Date().toISOString();
  let payload = structuredClone(input) as Record<string, unknown>;
  const applied: MigrationRecord[] = [];
  for (let version = fromVersion; version < toVersion; version++) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new MigrationError(`缺少 ${version} → ${version + 1} 的迁移步骤`, fromVersion);
    }
    try {
      payload = step(payload, { now });
    } catch (error) {
      throw new MigrationError(`迁移 ${version} → ${version + 1} 失败：${errorMessage(error)}`, fromVersion);
    }
    applied.push({ from: version, to: version + 1, at: now });
  }

  try {
    return { document: validateDocument(payload), fromVersion, toVersion, applied };
  } catch (error) {
    throw new MigrationError(errorMessage(error), fromVersion);
  }
}

function isMigrationRecord(entry: unknown): entry is MigrationRecord {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Partial<MigrationRecord>;
  return typeof record.from === "number" && typeof record.to === "number" && typeof record.at === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
