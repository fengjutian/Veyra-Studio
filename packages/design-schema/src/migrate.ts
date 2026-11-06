import { validateDocument } from "./validate";
import type { DesignDocument, MigrationRecord } from "./types";

/**
 * 当前设计文档的格式版本。
 *
 * 每当文档的持久化形状发生不向后兼容的变化，就把这个数字加一，并在
 * {@link MIGRATIONS} 里补上 `旧版本 → 新版本` 的那一步。读取旧文档的入口
 * （仓库恢复、JSON 导入）必须先跑 {@link migrateDocument}，再交给校验器。
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface MigrationContext {
  /** 迁移发生的时间；测试可以注入固定值以保证可重复。 */
  now: string;
}

/**
 * 单步迁移：把 `version` 形状的文档变成 `version + 1` 形状。
 *
 * 迁移步骤必须是纯函数，不能依赖外部状态，也不能抛异常以外的失败信号——
 * 抛出的错误会被转换成迁移失败结果，原文档保持不变。
 */
export type MigrationStep = (document: Record<string, unknown>, context: MigrationContext) => Record<string, unknown>;

/**
 * 迁移步骤表：键是源版本，值是把该版本升到下一版的步骤。
 *
 * v1 → v2：文档格式版本升到 2，并把这次迁移写进文档自带的 `migrations` 历史。
 */
export const MIGRATIONS: Record<number, MigrationStep> = {
  1: (document, { now }) => {
    const history = Array.isArray(document.migrations)
      ? document.migrations.filter(entry => isMigrationRecord(entry))
      : [];
    return { ...document, schemaVersion: 2, migrations: [...history, { from: 1, to: 2, at: now }] };
  },
};

export interface MigrationOptions {
  /** 迁移时间戳；默认取当前时间。 */
  now?: string;
}

export interface MigrationSuccess {
  ok: true;
  document: DesignDocument;
  /** 迁移前的格式版本。 */
  fromVersion: number;
  /** 迁移后的格式版本，等于 {@link CURRENT_SCHEMA_VERSION}。 */
  toVersion: number;
  /** 本次实际执行的迁移步骤。 */
  applied: MigrationRecord[];
}

export interface MigrationFailure {
  ok: false;
  error: string;
  /** 能识别出源版本时给出；无法识别时为 undefined。 */
  fromVersion?: number;
  toVersion: number;
}

export type MigrationResult = MigrationSuccess | MigrationFailure;

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
 * 迁移失败时不会产生副作用，调用方拿到的原始数据仍然可以退回给用户。
 */export function migrateDocument(input: unknown, options: MigrationOptions = {}): MigrationResult {
  const toVersion = CURRENT_SCHEMA_VERSION;
  const fromVersion = detectSchemaVersion(input);
  if (fromVersion === undefined) {
    return { ok: false, error: "文档缺少可识别的 schemaVersion，无法确定格式版本", toVersion };
  }
  if (fromVersion > toVersion) {
    return { ok: false, error: `文档版本 ${fromVersion} 高于当前支持的版本 ${toVersion}，请先升级 Studio`, fromVersion, toVersion };
  }
  if (fromVersion === toVersion) {
    try {
      return { ok: true, document: validateDocument(input), fromVersion, toVersion, applied: [] };
    } catch (error) {
      return { ok: false, error: errorMessage(error), fromVersion, toVersion };
    }
  }

  const now = options.now ?? new Date().toISOString();
  let payload = structuredClone(input) as Record<string, unknown>;
  const applied: MigrationRecord[] = [];
  for (let version = fromVersion; version < toVersion; version++) {
    const step = MIGRATIONS[version];
    if (!step) {
      return { ok: false, error: `缺少 ${version} → ${version + 1} 的迁移步骤`, fromVersion, toVersion };
    }
    try {
      payload = step(payload, { now });
    } catch (error) {
      return { ok: false, error: `迁移 ${version} → ${version + 1} 失败：${errorMessage(error)}`, fromVersion, toVersion };
    }
    applied.push({ from: version, to: version + 1, at: now });
  }

  try {
    return { ok: true, document: validateDocument(payload), fromVersion, toVersion, applied };
  } catch (error) {
    return { ok: false, error: errorMessage(error), fromVersion, toVersion };
  }
}

/**
 * 校验文档是否是当前格式的合法设计文档。
 *
 * 这是给"已经是当前版本"的调用方用的快速通道：老文档请走
 * {@link migrateDocument}。
 */
function isMigrationRecord(entry: unknown): entry is MigrationRecord {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Partial<MigrationRecord>;
  return typeof record.from === "number" && typeof record.to === "number" && typeof record.at === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
