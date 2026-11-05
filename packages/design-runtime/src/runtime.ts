import { validateDocument, type DesignDocument, type DesignNode, type NodeId } from "@ufira/design-schema";
import type { ChangeSet, CommandEnvelope, CommandResult, DesignCommand, TransactionEntry } from "./commands";

export class RevisionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(`Revision conflict: command expects ${expected}, document is ${actual}`);
    this.name = "RevisionConflictError";
  }
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export interface ExecuteOptions {
  committedAt?: string;
}

export interface HistoryRequest extends ExecuteOptions {
  commandId: string;
  actor: CommandEnvelope["actor"];
}

export class DesignRuntime {
  private document: DesignDocument;
  private undoStack: ChangeSet[] = [];
  private redoStack: ChangeSet[] = [];
  private transactions: TransactionEntry[] = [];

  constructor(document: DesignDocument) {
    this.document = structuredClone(validateDocument(document));
  }

  snapshot(): DesignDocument {
    return structuredClone(this.document);
  }

  transactionLog(): TransactionEntry[] {
    return structuredClone(this.transactions);
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  execute(envelope: CommandEnvelope, options: ExecuteOptions = {}): CommandResult {
    if (envelope.documentId !== this.document.id) throw new CommandError(`Command targets document ${envelope.documentId}, expected ${this.document.id}`);
    if (envelope.baseRevision !== this.document.revision) throw new RevisionConflictError(envelope.baseRevision, this.document.revision);
    if (envelope.commands.length === 0) throw new CommandError("A transaction requires at least one command");

    const before = this.snapshot();
    const draft = this.snapshot();
    for (const command of envelope.commands) applyCommand(draft, command);
    draft.revision += 1;
    const committedAt = options.committedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(committedAt))) throw new CommandError(`Invalid commit timestamp ${committedAt}`);
    draft.meta.updatedAt = committedAt;
    validateDocument(draft);

    const changes = { before, after: structuredClone(draft) };
    this.document = draft;
    this.undoStack.push(changes);
    this.redoStack = [];

    const warnings = collectWarnings(draft);
    this.transactions.push({
      commandId: envelope.commandId,
      documentId: envelope.documentId,
      revision: draft.revision,
      committedAt,
      actor: structuredClone(envelope.actor),
      commands: structuredClone(envelope.commands),
      warnings,
    });

    return {
      revision: draft.revision,
      changes,
      inverse: { before: structuredClone(draft), after: before },
      warnings,
    };
  }

  undo(request: HistoryRequest): CommandResult {
    validateHistoryTimestamp(request.committedAt);
    const change = this.undoStack.pop();
    if (!change) throw new CommandError("Nothing to undo");
    this.redoStack.push(change);
    return this.commitHistoryRestore(change.before, request);
  }

  redo(request: HistoryRequest): CommandResult {
    validateHistoryTimestamp(request.committedAt);
    const change = this.redoStack.pop();
    if (!change) throw new CommandError("Nothing to redo");
    this.undoStack.push(change);
    return this.commitHistoryRestore(change.after, request);
  }

  private commitHistoryRestore(target: DesignDocument, request: HistoryRequest): CommandResult {
    const before = this.snapshot();
    const after = structuredClone(target);
    after.revision = before.revision + 1;
    const committedAt = request.committedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(committedAt))) throw new CommandError(`Invalid commit timestamp ${committedAt}`);
    after.meta.updatedAt = committedAt;
    validateDocument(after);
    this.document = after;
    const warnings = collectWarnings(after);
    const changes = { before, after: structuredClone(after) };
    this.transactions.push({ commandId: request.commandId, documentId: after.id, revision: after.revision, committedAt, actor: structuredClone(request.actor), commands: [{ type: "history.restore", payload: { document: structuredClone(target) } }], warnings });
    return { revision: after.revision, changes, inverse: { before: structuredClone(after), after: before }, warnings };
  }
}

function applyCommand(document: DesignDocument, command: DesignCommand): void {
  switch (command.type) {
    case "history.restore": {
      if (command.payload.document.id !== document.id) throw new CommandError(`History restore targets document ${command.payload.document.id}, expected ${document.id}`);
      const revision = document.revision;
      Object.assign(document, structuredClone(command.payload.document), { revision });
      return;
    }
    case "document.rename": {
      const name = command.payload.name.trim();
      if (!name) throw new CommandError("Document name cannot be empty");
      document.meta.name = name;
      return;
    }
    case "node.create": return createNode(document, command.payload.node, command.payload.index);
    case "node.patch": {
      const node = requireNode(document, command.payload.id);
      Object.assign(node, structuredClone(command.payload.patch));
      return;
    }
    case "text.patch": {
      const node = requireNode(document, command.payload.id);
      if (node.type !== "text") throw new CommandError(`Node ${node.id} is not a text node`);
      const { patch } = command.payload;
      if (patch.fontFamily !== undefined && !patch.fontFamily.trim()) throw new CommandError("Font family cannot be empty");
      if (patch.fontSize !== undefined && (!Number.isFinite(patch.fontSize) || patch.fontSize <= 0)) throw new CommandError("Font size must be positive");
      if (patch.lineHeight !== undefined && (!Number.isFinite(patch.lineHeight) || patch.lineHeight <= 0)) throw new CommandError("Line height must be positive");
      Object.assign(node, structuredClone(patch));
      return;
    }
    case "node.delete": return deleteNode(document, command.payload.id);
    case "node.reparent": return reparentNode(document, command.payload.id, command.payload.parentId, command.payload.index);
    case "token.upsert": {
      if (!command.payload.name.trim()) throw new CommandError("Token name cannot be empty");
      document.tokens[command.payload.name] = structuredClone(command.payload.token);
      return;
    }
    case "token.delete": return deleteToken(document, command.payload.name);
    case "page.create": return createPage(document, command.payload.page, command.payload.index);
    case "page.rename": {
      const page = document.pages[command.payload.id];
      if (!page) throw new CommandError(`Page ${command.payload.id} does not exist`);
      if (!command.payload.name.trim()) throw new CommandError("Page name cannot be empty");
      page.name = command.payload.name;
      return;
    }
    case "page.delete": return deletePage(document, command.payload.id);
    case "component.define": return defineComponent(document, command.payload.component);
    case "component.remove": return removeComponent(document, command.payload.id);
    case "component.instantiate": return createNode(document, command.payload.node, command.payload.index);
  }
}

function createPage(document: DesignDocument, page: DesignDocument["pages"][string], index?: number): void {
  if (document.pages[page.id]) throw new CommandError(`Page ${page.id} already exists`);
  if (!page.name.trim()) throw new CommandError("Page name cannot be empty");
  if (page.childIds.length) throw new CommandError("New pages must be empty");
  document.pages[page.id] = structuredClone(page);
  insertAt(document.pageOrder, page.id, index);
}

function deletePage(document: DesignDocument, id: string): void {
  const page = document.pages[id];
  if (!page) throw new CommandError(`Page ${id} does not exist`);
  if (document.pageOrder.length === 1) throw new CommandError("A document must contain at least one page");
  if (page.childIds.length) throw new CommandError(`Page ${id} must be empty before deletion`);
  delete document.pages[id];
  document.pageOrder = document.pageOrder.filter(pageId => pageId !== id);
}

function deleteToken(document: DesignDocument, name: string): void {
  if (!document.tokens[name]) throw new CommandError(`Token ${name} does not exist`);
  const bound = Object.values(document.nodes).find(node => Object.values(node.bindings ?? {}).includes(name));
  if (bound) throw new CommandError(`Token ${name} is still bound by node ${bound.id}`);
  delete document.tokens[name];
}

function defineComponent(document: DesignDocument, component: DesignDocument["components"][string]): void {
  if (document.components[component.id]) throw new CommandError(`Component ${component.id} already exists`);
  const root = requireNode(document, component.rootNodeId);
  if (root.type !== "component") throw new CommandError(`Component root ${root.id} must have type component`);
  const duplicate = Object.values(document.components).find(existing => existing.rootNodeId === root.id);
  if (duplicate) throw new CommandError(`Node ${root.id} already defines component ${duplicate.id}`);
  document.components[component.id] = structuredClone(component);
}

function removeComponent(document: DesignDocument, id: string): void {
  if (!document.components[id]) throw new CommandError(`Component ${id} does not exist`);
  const instance = Object.values(document.nodes).find(node => node.type === "instance" && node.componentId === id);
  if (instance) throw new CommandError(`Component ${id} is still used by instance ${instance.id}`);
  delete document.components[id];
}

function createNode(document: DesignDocument, node: DesignNode, index?: number): void {
  if (document.nodes[node.id]) throw new CommandError(`Node ${node.id} already exists`);
  if (node.childIds.length) throw new CommandError("New nodes cannot reference children that have not been created in the same tree operation");
  const owner = requireContainer(document, node.parentId);
  document.nodes[node.id] = structuredClone(node);
  insertAt(owner.childIds, node.id, index);
}

function deleteNode(document: DesignDocument, id: NodeId): void {
  const node = requireNode(document, id);
  const owner = requireContainer(document, node.parentId);
  owner.childIds = owner.childIds.filter(childId => childId !== id);
  const remove = (nodeId: NodeId) => {
    const current = document.nodes[nodeId];
    if (!current) return;
    for (const childId of current.childIds) remove(childId);
    delete document.nodes[nodeId];
    for (const [componentId, component] of Object.entries(document.components)) {
      if (component.rootNodeId === nodeId) delete document.components[componentId];
    }
  };
  remove(id);
}

function reparentNode(document: DesignDocument, id: NodeId, parentId: string, index?: number): void {
  const node = requireNode(document, id);
  if (id === parentId || isDescendant(document, id, parentId)) throw new CommandError(`Cannot move ${id} into itself or its descendant ${parentId}`);
  const oldOwner = requireContainer(document, node.parentId);
  const newOwner = requireContainer(document, parentId);
  oldOwner.childIds = oldOwner.childIds.filter(childId => childId !== id);
  insertAt(newOwner.childIds, id, index);
  node.parentId = parentId;
}

function requireNode(document: DesignDocument, id: NodeId): DesignNode {
  const node = document.nodes[id];
  if (!node) throw new CommandError(`Node ${id} does not exist`);
  return node;
}

function requireContainer(document: DesignDocument, id: string): { childIds: NodeId[] } {
  const container = document.nodes[id] ?? document.pages[id];
  if (!container) throw new CommandError(`Parent ${id} does not exist`);
  if ("type" in container && !["frame", "component"].includes(container.type)) throw new CommandError(`Node ${id} cannot contain children`);
  return container;
}

function insertAt(items: NodeId[], id: NodeId, index?: number): void {
  if (index === undefined) items.push(id);
  else {
    if (!Number.isInteger(index) || index < 0 || index > items.length) throw new CommandError(`Invalid insertion index ${index}`);
    items.splice(index, 0, id);
  }
}

function isDescendant(document: DesignDocument, ancestorId: NodeId, candidateId: string): boolean {
  const ancestor = document.nodes[ancestorId];
  if (!ancestor) return false;
  return ancestor.childIds.some(childId => childId === candidateId || isDescendant(document, childId, candidateId));
}

function collectWarnings(document: DesignDocument): string[] {
  const warnings: string[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.appearance.fill?.startsWith("#") && !node.bindings?.fill) warnings.push(`Node ${node.id} uses a hardcoded fill without a token binding`);
  }
  return warnings;
}

function validateHistoryTimestamp(committedAt?: string): void {
  if (committedAt !== undefined && Number.isNaN(Date.parse(committedAt))) throw new CommandError(`Invalid commit timestamp ${committedAt}`);
}
