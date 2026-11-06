import { MigrationError, migrateDocument, type DesignDocument, type MigrationSuccess } from "@ufira/design-schema";

export interface ImportDocumentOptions {
  id?: string;
  now?: string;
}

export interface PreparedImport {
  document: DesignDocument;
  /** 导入的文件原本的格式版本；等于当前版本时为 undefined。 */
  migratedFrom?: number;
}

/** 导入的文件无法变成当前格式的文档。 */
export class ImportVersionError extends Error {
  constructor(message: string, public readonly fromVersion?: number) {
    super(message);
    this.name = "ImportVersionError";
  }
}

/**
 * 校验并升级要导入的项目文件。
 *
 * 导入是外部数据入口：先判断版本（能升的升，升不了的明确报错），再做 id、
 * revision 和元信息的重写，避免把别人的项目 id 直接写进当前项目。
 */
export function prepareImportedDocument(input: unknown, options: ImportDocumentOptions = {}): PreparedImport {
  const now = options.now ?? new Date().toISOString();
  let migrated: MigrationSuccess;
  try {
    migrated = migrateDocument(input, { now });
  } catch (error) {
    throw new ImportVersionError(error instanceof Error ? error.message : String(error), error instanceof MigrationError ? error.fromVersion : undefined);
  }

  const source = migrated.document;
  const imported = structuredClone(source);
  imported.id = options.id ?? `project:${crypto.randomUUID()}`;
  imported.revision = 0;
  imported.meta = {
    name: `${source.meta.name}（导入）`,
    createdAt: now,
    updatedAt: now,
  };

  return {
    document: imported,
    migratedFrom: migrated.fromVersion === migrated.toVersion ? undefined : migrated.fromVersion,
  };
}
