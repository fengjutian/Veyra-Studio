import { validateDocument, type DesignDocument } from "@ufira/design-schema";

export interface ImportDocumentOptions {
  id?: string;
  now?: string;
}

export function prepareImportedDocument(input: unknown, options: ImportDocumentOptions = {}): DesignDocument {
  const source = validateDocument(input);
  const imported = structuredClone(source);
  const now = options.now ?? new Date().toISOString();

  imported.id = options.id ?? `project:${crypto.randomUUID()}`;
  imported.revision = 0;
  imported.meta = {
    name: `${source.meta.name}（导入）`,
    createdAt: now,
    updatedAt: now,
  };

  return imported;
}
