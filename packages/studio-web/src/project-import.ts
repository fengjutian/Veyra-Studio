import { MigrationError, migrateDocument, type DesignDocument, type MigrationSuccess } from "@ufira/design-schema";

export interface ImportDocumentOptions {
  /** 目标项目 id；copy 模式下不传则新生成一个。 */
  id?: string;
  /** 目标项目名；不传时按模式推导（copy 加「（导入）」后缀）。 */
  name?: string;
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
  /**
   * id：导入文件和本地项目是同一个项目（会覆盖）。
   * name：只是重名，内容属于另一个项目（不会覆盖，只需要换个名字）。
   */
  kind: "id" | "name";
  /** 本地已存在的项目 id。 */
  projectId: string;
  /** 本地已存在的项目名。 */
  projectName: string;
  /** 重名时建议使用的名字；id 冲突时为空。 */
  suggestedName?: string;
}

/**
 * 判断导入的文件和本地某个项目是不是同一个身份。
 *
 * 分两种情况：
 * - 同一个项目 id：导出的 JSON 会带着原来的 id 回来，这就是同一个项目的另一个
 *   版本，覆盖或另存必须由用户决定；
 * - 只是重名：属于另一个项目，导入本身是安全的，但直接沿用同名会让项目列表里
 *   出现两个一样的名字，所以给一个「名称（2）」这样的建议名让用户确认。
 *
 * `source.name` 传**导入后会落到的名字**（copy 模式带「（导入）」后缀），
 * 否则会漏掉「上次导入的副本也叫这个名字」这种重名。
 */
export function detectImportConflict(source: { id: string; name: string }, existing: { id: string; name: string }[]): ImportConflict | undefined {
  const sameId = existing.find(item => item.id === source.id);
  if (sameId) return { kind: "id", projectId: sameId.id, projectName: sameId.name };
  const sameName = existing.find(item => item.name.trim() === source.name.trim());
  if (sameName) {
    return {
      kind: "name",
      projectId: sameName.id,
      projectName: sameName.name,
      suggestedName: uniqueProjectName(source.name, existing.map(item => item.name)),
    };
  }
  return undefined;
}

/** 在被占用的名字后面加「（2）」「（3）」……直到不重复。 */
export function uniqueProjectName(name: string, taken: string[]): string {
  const base = name.trim() || "未命名设计";
  const used = new Set(taken.map(item => item.trim()));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}（${index}）`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}（${globalThis.crypto.randomUUID().slice(0, 4)}）`;
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
    name: options.name?.trim() || (mode === "replace" ? source.meta.name : `${source.meta.name}（导入）`),
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
