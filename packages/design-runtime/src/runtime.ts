import { validateDocument, type DesignDocument, type DesignNode, type InstanceNode, type NodeId } from "@ufira/design-schema";
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
      if (patch.fontWeight !== undefined && (!Number.isInteger(patch.fontWeight) || patch.fontWeight < 100 || patch.fontWeight > 900)) throw new CommandError("Font weight must be an integer between 100 and 900");
      if (patch.fontStyle !== undefined && patch.fontStyle !== "normal" && patch.fontStyle !== "italic") throw new CommandError("Font style must be normal or italic");
      if (patch.textAlign !== undefined && patch.textAlign !== "left" && patch.textAlign !== "center" && patch.textAlign !== "right") throw new CommandError("Text align must be left, center or right");
      if (patch.letterSpacing !== undefined && !Number.isFinite(patch.letterSpacing)) throw new CommandError("Letter spacing must be a finite number");
      Object.assign(node, structuredClone(patch));
      return;
    }
    case "node.delete": return deleteNode(document, command.payload.id);
    case "node.reparent": return reparentNode(document, command.payload.id, command.payload.parentId, command.payload.index);
    case "asset.upsert": {
      const { asset } = command.payload;
      if (!asset.id.trim()) throw new CommandError("Asset id cannot be empty");
      if (!asset.hash.trim()) throw new CommandError("Asset hash cannot be empty");
      if (!asset.mimeType.trim()) throw new CommandError("Asset mime type cannot be empty");
      if (!Number.isInteger(asset.byteLength) || asset.byteLength < 0) throw new CommandError("Asset byte length must be a non-negative integer");
      // 资源以内容哈希标识：同一个 id 换了一份不同内容，说明调用方把两张图混成了一个身份。
      const existing = document.assets[asset.id];
      if (existing && existing.hash !== asset.hash) throw new CommandError(`Asset ${asset.id} already exists with a different hash`);
      document.assets[asset.id] = structuredClone(asset);
      return;
    }
    case "image.patch": {
      const node = requireNode(document, command.payload.id);
      if (node.type !== "image") throw new CommandError(`Node ${node.id} is not an image node`);
      const { fit } = command.payload.patch;
      if (fit !== undefined && fit !== "cover" && fit !== "contain" && fit !== "fill") throw new CommandError("Image fit must be cover, contain or fill");
      Object.assign(node, structuredClone(command.payload.patch));
      return;
    }
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
    case "component.create": return createComponent(document, command.payload.id, command.payload.nodeId, command.payload.name);
    case "component.remove": return removeComponent(document, command.payload.id);
    case "component.instantiate": return instantiateComponent(document, command.payload.node, command.payload.index);
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

/**
 * Promotes an existing node into a component root and registers the definition.
 *
 * The node keeps its identity so references from the canvas stay valid; only its
 * type and the component registry change.
 */
function createComponent(document: DesignDocument, componentId: string, nodeId: NodeId, name: string): void {
  if (!componentId.trim()) throw new CommandError("Component id cannot be empty");
  if (!name.trim()) throw new CommandError("Component name cannot be empty");
  if (document.components[componentId]) throw new CommandError(`Component ${componentId} already exists`);
  const node = requireNode(document, nodeId);
  if (node.type === "component") throw new CommandError(`Node ${nodeId} is already a component root`);
  if (node.type === "instance") throw new CommandError(`Node ${nodeId} is an instance and cannot become a component root`);
  const duplicate = Object.values(document.components).find(existing => existing.rootNodeId === nodeId);
  if (duplicate) throw new CommandError(`Node ${nodeId} already defines component ${duplicate.id}`);
  node.type = "component";
  document.components[componentId] = { id: componentId, name: name.trim(), rootNodeId: nodeId };
}

/**
 * Creates an instance of a component with its subtree materialized.
 *
 * The instance owns real child nodes so the canvas, layout engine and exporters
 * can render it without special-casing component definitions. Instance ids are
 * derived from the source node ids so a repeated instantiation stays deterministic
 * for a given instance id.
 */
function instantiateComponent(document: DesignDocument, node: InstanceNode, index?: number): void {
  const definition = document.components[node.componentId];
  if (!definition) throw new CommandError(`Component ${node.componentId} does not exist`);
  const root = requireNode(document, definition.rootNodeId);
  const owner = requireContainer(document, node.parentId);

  const copies = new Map<NodeId, NodeId>();
  const materialize = (sourceId: NodeId, parentId: NodeId): NodeId => {
    const source = requireNode(document, sourceId);
    const copyId = `${node.id}--${sourceId}`;
    if (document.nodes[copyId]) throw new CommandError(`Instance ${node.id} already materializes ${sourceId}`);
    copies.set(sourceId, copyId);
    const copy = structuredClone(source) as DesignNode;
    copy.id = copyId;
    copy.parentId = parentId;
    copy.childIds = [];
    document.nodes[copyId] = copy;
    for (const childId of source.childIds) {
      const childCopyId = materialize(childId, copyId);
      copy.childIds.push(childCopyId);
    }
    return copyId;
  };

  const materializedChildIds = root.childIds.map(childId => materialize(childId, node.id));
  const instance = structuredClone(node) as InstanceNode;
  instance.childIds = materializedChildIds;

  applyOverrides(instance, node.overrides, copies, document);

  document.nodes[node.id] = instance;
  insertAt(owner.childIds, node.id, index);
}

/**
 * Applies instance overrides onto the materialized copies.
 *
 * Overrides are keyed by the source node id inside the component and may set
 * text content or visual properties on the matching copy.
 */
function applyOverrides(instance: InstanceNode, overrides: Record<string, unknown>, copies: Map<NodeId, NodeId>, document: DesignDocument): void {
  for (const [sourceId, value] of Object.entries(overrides ?? {})) {
    const copyId = copies.get(sourceId);
    if (!copyId) throw new CommandError(`Override target ${sourceId} is not part of component ${instance.componentId}`);
    const copy = document.nodes[copyId];
    if (!copy) throw new CommandError(`Override target ${copyId} does not exist`);
    if (typeof value !== "object" || value === null) throw new CommandError(`Override for ${sourceId} must be an object`);
    const patch = value as Record<string, unknown>;
    if (copy.type === "text" && typeof patch.text === "string") copy.text = patch.text;
    if (typeof patch.name === "string") copy.name = patch.name;
    if (patch.appearance && typeof patch.appearance === "object") copy.appearance = { ...copy.appearance, ...(patch.appearance as object) };
    if (patch.layout && typeof patch.layout === "object") copy.layout = { ...copy.layout, ...(patch.layout as object) };
    if (patch.bindings && typeof patch.bindings === "object") copy.bindings = { ...copy.bindings, ...(patch.bindings as object) };
  }
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
  if ("type" in container && !["frame", "component", "instance"].includes(container.type)) throw new CommandError(`Node ${id} cannot contain children`);
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
