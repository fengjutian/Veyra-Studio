import { MigrationError, migrateDocument, type DesignDocument, type MigrationSuccess } from "@ufira/design-schema";

export interface ImportDocumentOptions {
  /** 目标项目 id；copy 模式下不传则新生成一个。 */
  id?: string;
  now?: string;
  /**
   * copy：作为新项目导入，名称加「（导入）」后缀。
   * replace：覆盖已有项目，沿用目标 id 与原名。
   */
  mode?: ImportMode;
}

export type ImportMode = "copy" | "replace";

export interface PreparedImport {
  document: DesignDocument;
  /** 导入文件原本的格式版本；等于当前版本时为 undefined。 */
  migratedFrom?: number;
  mode: ImportMode;
  /** 导入文件原本的项目 id；copy 模式下 document 会拿到新 id。 */
  sourceId: string;
  /** 导入文件原本的项目名；copy 模式下 document 的名字会带「（导入）」后缀。 */
  sourceName: string;
}

/** 导入的文件无法变成当前格式的文档。 */
export class ImportVersionError extends Error {
  constructor(message: string, public readonly fromVersion?: number) {
    super(message);
    this.name = "ImportVersionError";
  }
}

/** 导入的文件和本地某个项目是同一个身份，存在覆盖风险。 */
export interface ImportConflict {
  /** 本地已存在的项目 id。 */
  projectId: string;
  /** 本地已存在的项目名。 */
  projectName: string;
}

/**
 * 判断导入的文件和本地某个项目是不是同一个身份。
 *
 * 冲突只按项目 id 判定：导出的 JSON 会带着原来的 id 回来，这时候它就是同一个
 * 项目的另一个版本，覆盖或另存需要用户决定。只撞名字不撞 id 的是另一个项目，
 * 不算冲突，直接当作新项目导入即可。
 */
export function detectImportConflict(source: { id: string; name: string }, existing: { id: string; name: string }[]): ImportConflict | undefined {
  const hit = existing.find(item => item.id === source.id);
  return hit ? { projectId: hit.id, projectName: hit.name } : undefined;
}

/**
 * 校验并升级要导入的项目文件。
 *
 * 导入是外部数据入口：先判断版本（能升的升，升不了的明确报错），再做 id、
 * revision 和元信息的重写，避免把别人的项目 id 直接写进当前项目。
 */
export function prepareImportedDocument(input: unknown, options: ImportDocumentOptions = {}): PreparedImport {
  const now = options.now ?? new Date().toISOString();
  const mode = options.mode ?? "copy";
  let migrated: MigrationSuccess;
  try {
    migrated = migrateDocument(input, { now });
  } catch (error) {
    throw new ImportVersionError(error instanceof Error ? error.message : String(error), error instanceof MigrationError ? error.fromVersion : undefined);
  }

  const source = migrated.document;
  const imported = structuredClone(source);
  imported.revision = 0;
  imported.meta = {
    name: mode === "replace" ? source.meta.name : `${source.meta.name}（导入）`,
    createdAt: now,
    updatedAt: now,
  };
  imported.id = mode === "replace"
    ? (options.id ?? source.id)
    : (options.id ?? `project:${crypto.randomUUID()}`);

  return {
    document: imported,
    migratedFrom: migrated.fromVersion === migrated.toVersion ? undefined : migrated.fromVersion,
    mode,
    sourceId: source.id,
    sourceName: source.meta.name,
  };
}
