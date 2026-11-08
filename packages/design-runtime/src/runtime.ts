import { BOOLEAN_OPERATIONS, findOwningComponentId, fontKey, isFontMimeType, supportsBooleanOperand, isValidVectorPath, overridableFields, remapTextRuns, validateDocument, validateInteraction, validateTextRuns, wouldCreateComponentCycle, type BooleanNode, type BooleanOperation, type ComponentSetDefinition, type DesignDocument, type DesignNode, type DocumentFont, type FontStyle, type InstanceNode, type Interaction, type NodeId, type Paint } from "@ufira/design-schema";
import { applyConstraints } from "./constraints";
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
      if (command.payload.patch.slot !== undefined && typeof command.payload.patch.slot !== "boolean") throw new CommandError("Slot flag must be a boolean");
      if (command.payload.patch.mask !== undefined) {
        if (typeof command.payload.patch.mask !== "boolean") throw new CommandError("Mask flag must be a boolean");
        // 只有形状能当蒙版：文本/图片/容器的「轮廓」没有明确语义，放进来只会让裁剪结果不可解释。
        if (command.payload.patch.mask && node.type !== "vector" && node.type !== "rectangle" && node.type !== "ellipse") {
          throw new CommandError(`Node ${node.id} of type ${node.type} cannot be used as a mask`);
        }
      }
      const previousLayout = structuredClone(node.layout);
      Object.assign(node, structuredClone(command.payload.patch));
      // 父级尺寸变化时，子节点按约束重排——和父级 patch 落在同一条命令里，所以是一次撤销。
      if (command.payload.patch.layout) {
        for (const change of applyConstraints(document, node, previousLayout, node.layout)) {
          const child = document.nodes[change.id];
          if (child) child.layout = structuredClone(change.layout);
        }
      }
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
      const textChanged = patch.text !== undefined && patch.text !== node.text;
      const previousText = node.text;
      if (patch.runs !== undefined) {
        // 显式给的 runs 必须和（新的）文本自洽：越界、重叠、切断代理对都在这里拒绝。
        const error = validateTextRuns(patch.text ?? node.text, patch.runs);
        if (error) throw new CommandError(error);
      }
      Object.assign(node, structuredClone(patch));
      if (patch.runs === undefined && textChanged && node.runs?.length) {
        // 只改了文字没给新 runs：按「公共前后缀」把旧区间平移/夹紧到新文本上。
        const remapped = remapTextRuns(previousText, node.text, node.runs);
        if (remapped.length) node.runs = remapped;
        else delete node.runs;
      }
      if (node.runs && node.runs.length === 0) delete node.runs;
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
      const { fit, assetId } = command.payload.patch;
      if (fit !== undefined && fit !== "cover" && fit !== "contain" && fit !== "fill") throw new CommandError("Image fit must be cover, contain or fill");
      if (assetId !== undefined && !document.assets[assetId]) throw new CommandError(`Asset ${assetId} does not exist`);
      Object.assign(node, structuredClone(command.payload.patch));
      return;
    }
    case "vector.patch": {
      const node = requireNode(document, command.payload.id);
      if (node.type !== "vector") throw new CommandError(`Node ${node.id} is not a vector node`);
      const { geometry, layout } = command.payload.patch;
      if (!geometry || geometry.kind !== "path") throw new CommandError("Vector patch requires a path geometry");
      // 兜底校验：写进来的路径必须能被解析，否则画布会静默画空。
      if (!isValidVectorPath(geometry.d)) throw new CommandError(`Vector path for ${node.id} is invalid`);
      node.geometry = structuredClone(geometry);
      // 几何变了盒子的尺寸也必须跟着变，所以允许同一条命令里一起改。
      if (layout) node.layout = structuredClone(layout);
      return;
    }
    case "asset.delete": return deleteAsset(document, command.payload.id);
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
    case "component.setCreate": return createComponentSet(document, command.payload.set);
    case "component.setVariant": return assignComponentVariant(document, command.payload);
    case "component.createVariant": return createComponentVariant(document, command.payload);
    case "component.switchVariant": return switchComponentVariant(document, command.payload);
    case "font.register": return registerFont(document, command.payload.font);
    case "font.remove": return removeFont(document, command.payload);
    case "boolean.create": return createBoolean(document, command.payload);
    case "boolean.setOperation": return setBooleanOperation(document, command.payload);
    case "boolean.release": return releaseBoolean(document, command.payload);
    case "component.remove": return removeComponent(document, command.payload.id);
    case "component.instantiate": return instantiateComponent(document, command.payload.node, command.payload.index);
    case "component.detach": return detachComponent(document, command.payload.id);
    case "component.detachMany": return detachComponents(document, command.payload.ids);
    case "slot.fill": return fillSlot(document, command.payload);
    case "component.override": return overrideInstanceNode(document, command.payload);
    case "component.resetOverride": return resetInstanceOverride(document, command.payload);
    case "component.resetOverrides": return resetInstanceOverrides(document, command.payload);
    case "interaction.patch": return patchInteractions(document, command.payload.id, command.payload.interactions);
  }
}

/**
 * 改节点的原型交互。
 *
 * 校验分两层：
 * 1. **语义自洽**（`validateInteraction`）：延迟是否合法、动画是否与动作匹配、
 *    `open-url` 是否有链接。这层拦的是「写进来就注定跑不起来」的交互。
 * 2. **引用存在性**：跳转目标必须指向文档里真实存在的节点。
 *    这层拦的是「交互存在但点了没反应」——比语法错误更难排查。
 */
function patchInteractions(document: DesignDocument, id: NodeId, interactions: Interaction[]): void {
  const node = requireNode(document, id);
  for (const interaction of interactions) {
    const problems = validateInteraction(interaction, node.type);
    if (problems.length) {
      throw new CommandError(`Invalid interaction on node ${id}: ${problems.join("; ")}`);
    }
    // 跳转目标必须存在。overlay 的目标同理。
    if (interaction.destination && !document.nodes[interaction.destination]) {
      throw new CommandError(`Interaction destination ${interaction.destination} does not exist`);
    }
    if (interaction.positionRelativeTo && !document.nodes[interaction.positionRelativeTo]) {
      throw new CommandError(`Interaction positionRelativeTo ${interaction.positionRelativeTo} does not exist`);
    }
  }
  node.interactions = structuredClone(interactions);
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

function deleteAsset(document: DesignDocument, id: string): void {
  if (!document.assets[id]) throw new CommandError(`Asset ${id} does not exist`);
  const used = Object.values(document.nodes).find(node => node.type === "image" && node.assetId === id);
  if (used) throw new CommandError(`Asset ${id} is still used by node ${used.id}`);
  const font = (document.fonts ?? []).find(entry => entry.assetId === id);
  if (font) throw new CommandError(`Asset ${id} is still used by font ${font.family}`);
  delete document.assets[id];
}

/**
 * 登记字体声明（上传文件对应的资源或系统字体）。
 *
 * 同一族名 + 字重 + 字形视为同一条记录：再次登记是**替换**而不是重复，
 * 这样重新上传同名同字重的字体文件时可以覆盖，不用先删再建。
 */
function registerFont(document: DesignDocument, font: DocumentFont): void {
  const family = font.family.trim();
  if (!family) throw new CommandError("Font family cannot be empty");
  const weight = font.weight ?? 400;
  if (!Number.isInteger(weight) || weight < 100 || weight > 900) throw new CommandError("Font weight must be an integer between 100 and 900");
  const style = font.style ?? "normal";
  if (style !== "normal" && style !== "italic") throw new CommandError("Font style must be normal or italic");
  if (font.assetId) {
    const asset = document.assets[font.assetId];
    if (!asset) throw new CommandError(`Font asset ${font.assetId} does not exist`);
    if (!isFontMimeType(asset.mimeType)) throw new CommandError(`Asset ${font.assetId} is ${asset.mimeType}, not a font`);
  }
  const entry: DocumentFont = { family, weight, style, ...(font.assetId ? { assetId: font.assetId } : {}) };
  const fonts = [...(document.fonts ?? [])];
  const index = fonts.findIndex(existing => fontKey(existing) === fontKey(entry));
  if (index >= 0) fonts[index] = entry;
  else fonts.push(entry);
  document.fonts = fonts;
}

/** 删除字体声明；还有文本节点在用这个族名时拒绝，避免它们悄悄掉进回退字体。 */
function removeFont(document: DesignDocument, payload: { family: string; weight?: number; style?: FontStyle }): void {
  const fonts = document.fonts ?? [];
  const key = fontKey({ family: payload.family, weight: payload.weight, style: payload.style });
  const index = fonts.findIndex(font => fontKey(font) === key);
  if (index < 0) throw new CommandError(`Font ${payload.family} is not declared`);
  const used = Object.values(document.nodes).find(node => node.type === "text" && node.fontFamily === payload.family);
  if (used) throw new CommandError(`Font ${payload.family} is still used by text node ${used.id}`);
  const next = fonts.filter((_, position) => position !== index);
  if (next.length) document.fonts = next;
  else delete document.fonts;
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
  const definition = document.components[id];
  if (!definition) throw new CommandError(`Component ${id} does not exist`);
  const instance = Object.values(document.nodes).find(node => node.type === "instance" && node.componentId === id);
  if (instance) throw new CommandError(`Component ${id} is still used by instance ${instance.id}`);
  const variantSetId = definition.variantSetId;
  delete document.components[id];
  if (variantSetId) pruneVariantSet(document, variantSetId);
}

/**
 * 变体集只剩一个成员时解散它。
 *
 * 「只有一个变体」没有切换语义，留着只会让 UI 显示一个永远只有一项的下拉框；
 * 因此把最后一个成员退回普通组件，并删掉集合。
 */
function pruneVariantSet(document: DesignDocument, setId: string): void {
  if (!document.componentSets?.[setId]) return;
  const members = Object.values(document.components).filter(component => component.variantSetId === setId);
  if (members.length >= 2) return;
  for (const member of members) {
    delete member.variantSetId;
    delete member.variant;
  }
  delete document.componentSets[setId];
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
  // 子树里如果已经引用了目标组件，提升之后就会变成环。
  if (wouldCreateComponentCycle(document, componentId, nodeId)) throw new CommandError(`Component ${componentId} would reference itself through ${nodeId}`);
  node.type = "component";
  document.components[componentId] = { id: componentId, name: name.trim(), rootNodeId: nodeId };
}

function createComponentSet(document: DesignDocument, set: ComponentSetDefinition): void {
  if (!set.id.trim()) throw new CommandError("Component set id cannot be empty");
  if (!set.name.trim()) throw new CommandError("Component set name cannot be empty");
  const properties = set.properties.map(property => property.trim());
  if (!properties.length) throw new CommandError("Component set needs at least one property");
  if (properties.some(property => !property)) throw new CommandError("Component set properties cannot be empty");
  if (new Set(properties).size !== properties.length) throw new CommandError("Component set properties must be unique");
  if (document.componentSets?.[set.id]) throw new CommandError(`Component set ${set.id} already exists`);
  document.componentSets = { ...(document.componentSets ?? {}), [set.id]: { id: set.id, name: set.name.trim(), properties } };
}

/** 变体值必须正好覆盖集合声明的全部属性，多一个少一个都不行。 */
function assertVariantValues(set: ComponentSetDefinition, variant: Record<string, string>, label: string): void {
  for (const key of Object.keys(variant)) {
    if (!set.properties.includes(key)) throw new CommandError(`${label} sets unknown variant property ${key}`);
  }
  for (const property of set.properties) {
    if (!variant[property]?.trim()) throw new CommandError(`${label} is missing variant property ${property}`);
  }
}

/** 同一集合里不允许两个成员拥有同一组取值——那样切换时无法区分。 */
function assertVariantUnique(document: DesignDocument, set: ComponentSetDefinition, variant: Record<string, string>, ignore?: string): void {
  const signature = set.properties.map(property => variant[property]).join("\u0000");
  for (const [id, component] of Object.entries(document.components)) {
    if (id === ignore || component.variantSetId !== set.id || !component.variant) continue;
    const other = set.properties.map(property => component.variant?.[property]).join("\u0000");
    if (other === signature) throw new CommandError(`Variant ${signature.replace(/\u0000/g, ", ")} already exists as ${id}`);
  }
}

function assignComponentVariant(document: DesignDocument, payload: { id: string; variantSetId: string; variant: Record<string, string> }): void {
  const component = document.components[payload.id];
  if (!component) throw new CommandError(`Component ${payload.id} does not exist`);
  const set = document.componentSets?.[payload.variantSetId];
  if (!set) throw new CommandError(`Component set ${payload.variantSetId} does not exist`);
  assertVariantValues(set, payload.variant, `Component ${payload.id}`);
  assertVariantUnique(document, set, payload.variant, payload.id);
  component.variantSetId = set.id;
  component.variant = { ...payload.variant };
}

/**
 * 复制出一个新变体。
 *
 * 新组件的根子树复制到与源根相同的容器里、紧跟源根之后；节点 id 用
 * `${新组件 id}--${源节点 id}`，和实例物化的命名规则一致，便于回查来源。
 */
function createComponentVariant(document: DesignDocument, payload: { sourceComponentId: string; componentId: string; name: string; values: Record<string, string> }): void {
  const source = document.components[payload.sourceComponentId];
  if (!source) throw new CommandError(`Component ${payload.sourceComponentId} does not exist`);
  if (!payload.componentId.trim()) throw new CommandError("Component id cannot be empty");
  if (!payload.name.trim()) throw new CommandError("Component name cannot be empty");
  if (document.components[payload.componentId]) throw new CommandError(`Component ${payload.componentId} already exists`);
  if (!source.variantSetId) throw new CommandError(`Component ${source.id} is not part of a variant set`);
  const set = document.componentSets?.[source.variantSetId];
  if (!set) throw new CommandError(`Component set ${source.variantSetId} does not exist`);
  assertVariantValues(set, payload.values, `Variant ${payload.componentId}`);
  assertVariantUnique(document, set, payload.values);

  const sourceRoot = requireNode(document, source.rootNodeId);
  if (sourceRoot.type !== "component") throw new CommandError(`Component ${source.id} root must be a component node`);
  const owner = requireContainer(document, sourceRoot.parentId);

  const clone = (sourceNodeId: NodeId, parentId: NodeId): NodeId => {
    const original = requireNode(document, sourceNodeId);
    const id = `${payload.componentId}--${sourceNodeId}`;
    if (document.nodes[id]) throw new CommandError(`Node ${id} already exists`);
    const copied = structuredClone(original) as DesignNode;
    copied.id = id;
    copied.parentId = parentId;
    copied.childIds = [];
    document.nodes[id] = copied;
    for (const childId of original.childIds) copied.childIds.push(clone(childId, id));
    return id;
  };

  const rootId = clone(source.rootNodeId, sourceRoot.parentId);
  const index = owner.childIds.indexOf(source.rootNodeId);
  insertAt(owner.childIds, rootId, index >= 0 ? index + 1 : undefined);
  document.components[payload.componentId] = {
    id: payload.componentId,
    name: payload.name.trim(),
    rootNodeId: rootId,
    variantSetId: set.id,
    variant: { ...payload.values },
  };
}

/**
 * 从组件根到某个节点的结构路径（每层是 `childIds` 下标）。
 *
 * 变体由复制产生，节点 id 必然不同，但同一角色在子树里的**位置**相同；
 * 覆盖按路径迁移才能跨变体保留。
 */
function structuralPath(document: DesignDocument, rootId: NodeId, nodeId: NodeId): number[] | undefined {
  const path: number[] = [];
  const visited = new Set<NodeId>();
  let current = nodeId;
  while (current !== rootId) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const node = document.nodes[current];
    if (!node) return undefined;
    const parent = document.nodes[node.parentId];
    if (!parent) return undefined;
    const index = parent.childIds.indexOf(current);
    if (index < 0) return undefined;
    path.unshift(index);
    current = node.parentId;
  }
  return path;
}

/** 按结构路径取节点；路径不存在（两个变体结构不同）时返回 undefined。 */
function nodeAtPath(document: DesignDocument, rootId: NodeId, path: number[]): NodeId | undefined {
  let current: NodeId | undefined = rootId;
  for (const index of path) {
    current = document.nodes[current]?.childIds[index];
    if (!current) return undefined;
  }
  return current;
}

/**
 * 把实例切换到同一变体集里的另一个成员。
 *
 * 旧物化子树整体删除、按新组件重新物化；覆盖按**结构路径**迁移到新变体上——
 * 同一角色（例如按钮里的文字）即使节点 id 不同也能保留用户改过的内容。
 * 新变体结构不同、路径对不上时，那条覆盖会被丢弃。
 */
function switchComponentVariant(document: DesignDocument, payload: { id: NodeId; componentId: string }): void {
  const node = requireNode(document, payload.id);
  if (node.type !== "instance") throw new CommandError(`Node ${payload.id} is not a component instance`);
  const next = document.components[payload.componentId];
  if (!next) throw new CommandError(`Component ${payload.componentId} does not exist`);
  if (node.componentId === payload.componentId) return;
  const current = document.components[node.componentId];
  if (!current?.variantSetId || current.variantSetId !== next.variantSetId) {
    throw new CommandError(`Components ${node.componentId} and ${payload.componentId} are not variants of the same set`);
  }

  const removeSubtree = (nodeId: NodeId): void => {
    const child = document.nodes[nodeId];
    if (!child) return;
    for (const childId of [...child.childIds]) removeSubtree(childId);
    delete document.nodes[nodeId];
  };
  for (const childId of [...node.childIds]) removeSubtree(childId);

  const root = requireNode(document, next.rootNodeId);
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
    for (const childId of source.childIds) copy.childIds.push(materialize(childId, copyId));
    return copyId;
  };

  const childIds = root.childIds.map(childId => materialize(childId, node.id));
  const currentRootId = current.rootNodeId;
  const keptOverrides: Record<string, unknown> = {};
  for (const [sourceId, value] of Object.entries(node.overrides ?? {})) {
    if (copies.has(sourceId)) {
      keptOverrides[sourceId] = value;
      continue;
    }
    // 变体是「复制」，节点 id 必然不同；但同一角色在子树里的结构路径相同，
    // 因此覆盖按路径迁移，而不是整批丢掉。
    const path = structuralPath(document, currentRootId, sourceId);
    if (!path) continue;
    const mapped = nodeAtPath(document, next.rootNodeId, path);
    if (mapped && copies.has(mapped)) keptOverrides[mapped] = value;
  }
  const instance = structuredClone(node) as InstanceNode;
  instance.componentId = next.id;
  instance.childIds = childIds;
  instance.overrides = keptOverrides;
  document.nodes[node.id] = instance;
  applyOverrides(instance, keptOverrides, copies, document);
}

/**
 * Creates an instance of a component with its subtree materialized.
 *
 * The instance owns real child nodes so the canvas, layout engine and exporters
 * can render it without special-casing component definitions. Instance ids are
 * derived from the source node ids so a repeated instantiation stays deterministic
 * for a given instance id.
 */
/**
 * 把实例脱离成普通 frame。
 *
 * 子节点本来就已经物化，脱离只是丢掉"实例"这层身份，因此不需要重建子树，
 * 也不会产生新的节点 id（画布选中、布局结果和撤销历史都保持稳定）。
 */
function detachComponent(document: DesignDocument, id: NodeId): void {
  detachOne(document, requireNode(document, id));
}

/** 批量脱离：先全部校验再改，任何一个不是实例都整批失败（事务本身也会回滚）。 */
function detachComponents(document: DesignDocument, ids: NodeId[]): void {
  if (!ids.length) throw new CommandError("component.detachMany requires at least one id");
  const unique = [...new Set(ids)];
  for (const node of unique.map(id => requireNode(document, id))) {
    if (node.type !== "instance") throw new CommandError(`Node ${node.id} is not a component instance`);
  }
  for (const id of unique) detachOne(document, requireNode(document, id));
}

function detachOne(document: DesignDocument, node: DesignNode): void {
  if (node.type !== "instance") throw new CommandError(`Node ${node.id} is not a component instance`);
  const detached = { ...structuredClone(node), type: "frame" as const };
  delete (detached as { componentId?: string }).componentId;
  delete (detached as { overrides?: Record<string, unknown> }).overrides;
  document.nodes[node.id] = detached;
}

/**
 * 往实例的插槽里放内容。
 *
 * 插槽是组件根子树里 `slot: true` 的 frame；真正的节点在实例化时被物化，
 * 所以填充只需要在实例自己的子树里挂新节点，不影响组件定义和其它实例。
 */
function fillSlot(
  document: DesignDocument,
  payload: { instanceId: NodeId; slotNodeId: NodeId; template: { roots: NodeId[]; nodes: Record<NodeId, DesignNode> } },
): void {
  const instance = requireNode(document, payload.instanceId);
  if (instance.type !== "instance") throw new CommandError(`Node ${instance.id} is not a component instance`);
  const slot = requireNode(document, payload.slotNodeId);
  if (!slot.slot) throw new CommandError(`Node ${slot.id} is not a slot`);
  if (!isInside(document, slot.id, instance.id)) throw new CommandError(`Slot ${slot.id} does not belong to instance ${instance.id}`);

  // 重复填充时先清空旧内容，调用方不必自己删。
  for (const childId of [...slot.childIds]) deleteNode(document, childId);

  const create = (sourceId: NodeId, parentId: NodeId): NodeId => {
    const source = payload.template.nodes[sourceId];
    if (!source) throw new CommandError(`Slot template is missing node ${sourceId}`);
    const newId = `${instance.id}--slot--${slot.id}--${sourceId}`;
    if (document.nodes[newId]) throw new CommandError(`Slot content ${sourceId} is already materialized`);
    const copy = structuredClone(source);
    copy.id = newId;
    copy.parentId = parentId;
    copy.childIds = [];
    document.nodes[newId] = copy;
    for (const childId of source.childIds) copy.childIds.push(create(childId, newId));
    return newId;
  };

  for (const rootId of payload.template.roots) slot.childIds.push(create(rootId, slot.id));
}

/** 给实例里的物化副本写入覆盖值，并把它记进实例的 overrides。 */
function overrideInstanceNode(
  document: DesignDocument,
  payload: {
    instanceId: NodeId;
    sourceNodeId: NodeId;
    patch: { text?: string; name?: string; visible?: boolean; appearance?: { fills?: Paint[]; stroke?: string; opacity?: number; cornerRadius?: number } };
  },
): void {
  const instance = requireNode(document, payload.instanceId);
  if (instance.type !== "instance") throw new CommandError(`Node ${instance.id} is not a component instance`);
  const copyId = `${instance.id}--${payload.sourceNodeId}`;
  const copy = requireNode(document, copyId);
  if (!isInside(document, copyId, instance.id)) throw new CommandError(`Node ${copyId} does not belong to instance ${instance.id}`);

  const { text, name, visible, appearance } = payload.patch;
  const patchRecord = payload.patch as Record<string, unknown>;
  const patchKeys = Object.keys(patchRecord).filter(key => patchRecord[key] !== undefined);
  const allowed = overridableFields(copy);
  for (const key of patchKeys) {
    if (!(allowed as readonly string[]).includes(key)) throw new CommandError(`Node ${copy.id} cannot override ${key}`);
  }
  if (!patchKeys.length) throw new CommandError("Override patch cannot be empty");
  if (appearance?.opacity !== undefined && (!Number.isFinite(appearance.opacity) || appearance.opacity < 0 || appearance.opacity > 1)) {
    throw new CommandError("Override opacity must be between 0 and 1");
  }
  if (appearance?.cornerRadius !== undefined && (!Number.isFinite(appearance.cornerRadius) || appearance.cornerRadius < 0)) {
    throw new CommandError("Override corner radius must be a non-negative number");
  }
  if (text !== undefined) {
    if (copy.type !== "text") throw new CommandError(`Node ${copyId} is not a text node`);
    copy.text = text;
  }
  if (name !== undefined) copy.name = name;
  if (visible !== undefined) copy.visible = visible;
  if (appearance !== undefined) copy.appearance = { ...copy.appearance, ...appearance };

  const previous = instance.overrides[payload.sourceNodeId];
  const merged = typeof previous === "object" && previous !== null ? previous : {};
  instance.overrides = {
    ...instance.overrides,
    [payload.sourceNodeId]: {
      ...merged,
      ...(text !== undefined ? { text } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(visible !== undefined ? { visible } : {}),
      ...(appearance !== undefined ? { appearance } : {}),
    },
  };
}

/**
 * 清除覆盖：把实例副本恢复成组件定义里的样子，并删掉 overrides 记录。
 *
 * 组件定义节点本来就在同一份文档里，所以恢复可以直接从源节点抄字段，不需要
 * 重新实例化（重新实例化会换 id，选中和布局都会跳）。
 */
function resetInstanceOverride(document: DesignDocument, payload: { instanceId: NodeId; sourceNodeId: NodeId }): void {
  const instance = requireInstance(document, payload.instanceId);
  resetOneOverride(document, instance, payload.sourceNodeId);
}

/** 批量重置；不传 sourceNodeIds 时清空该实例的全部覆盖。 */
function resetInstanceOverrides(document: DesignDocument, payload: { instanceId: NodeId; sourceNodeIds?: NodeId[] }): void {
  const instance = requireInstance(document, payload.instanceId);
  const targets = payload.sourceNodeIds ?? Object.keys(instance.overrides);
  if (!targets.length) throw new CommandError(`Instance ${instance.id} has no overrides to reset`);
  for (const sourceNodeId of targets) resetOneOverride(document, instance, sourceNodeId);
}

function requireInstance(document: DesignDocument, id: NodeId): InstanceNode {
  const node = requireNode(document, id);
  if (node.type !== "instance") throw new CommandError(`Node ${node.id} is not a component instance`);
  return node;
}

function resetOneOverride(document: DesignDocument, instance: InstanceNode, sourceNodeId: NodeId): void {
  const definition = document.components[instance.componentId];
  if (!definition) throw new CommandError(`Component ${instance.componentId} does not exist`);
  const source = requireNode(document, sourceNodeId);
  if (!isInside(document, source.id, definition.rootNodeId)) {
    throw new CommandError(`Node ${source.id} is not part of component ${definition.id}`);
  }
  const copy = requireNode(document, `${instance.id}--${sourceNodeId}`);

  copy.name = source.name;
  copy.visible = source.visible;
  copy.appearance = structuredClone(source.appearance);
  if (copy.type === "text" && source.type === "text") copy.text = source.text;

  const overrides = { ...instance.overrides };
  delete overrides[sourceNodeId];
  instance.overrides = overrides;
}
/** `id` 是否是 `ancestorId` 的后代（沿 parentId 链向上找）。 */
function isInside(document: DesignDocument, id: NodeId, ancestorId: NodeId): boolean {
  let current: string | undefined = id;
  const visited = new Set<string>();
  while (current) {
    if (current === ancestorId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = document.nodes[current]?.parentId;
  }
  return false;
}
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
  // 布尔组至少要有两个操作数；删到只剩一个时几何会消失，先让用户解除布尔组。
  const parentNode = document.nodes[node.parentId];
  if (parentNode?.type === "boolean" && parentNode.childIds.length <= 2) {
    throw new CommandError(`Boolean ${parentNode.id} needs at least two operands; release the group first`);
  }
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
  // 把一个会绕回组件 C 的节点移进 C 的子树，会让 C 依赖自己（直接或间接）。
  const ownerComponent = findOwningComponentId(document, parentId);
  if (ownerComponent && wouldCreateComponentCycle(document, ownerComponent, id)) {
    throw new CommandError(`Cannot move ${id} into component ${ownerComponent}: it would create a component cycle`);
  }
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
  // 布尔组也持有子节点（操作数），因此允许当作容器；文本/图片/矢量仍然不行。\n  if ("type" in container && !["frame", "component", "instance", "boolean"].includes(container.type)) throw new CommandError(`Node ${id} cannot contain children`);
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
    const hardcodedAll = (node.appearance.fills ?? []).every(paint => paint.type === "solid" && paint.color.startsWith("#"));
      if ((node.appearance.fills?.length ?? 0) > 0 && hardcodedAll && !node.bindings?.fill) warnings.push(`Node ${node.id} uses a hardcoded fill without a token binding`);
  }
  return warnings;
}

function validateHistoryTimestamp(committedAt?: string): void {
  if (committedAt !== undefined && Number.isNaN(Date.parse(committedAt))) throw new CommandError(`Invalid commit timestamp ${committedAt}`);
}

/**
 * 把若干同级形状合成布尔组。
 *
 * 只保存运算树：布尔节点持有操作数子节点，几何在渲染/导出时由
 * `computeBooleanPath()` 计算。因此改操作数、改运算类型都会立刻反映到结果上。
 * 操作数保持 z 序（`childIds` 顺序），第一个是基准层；布尔节点插在最高层操作数的位置。
 */
function createBoolean(document: DesignDocument, payload: { id: string; name?: string; operation: BooleanOperation; nodeIds: NodeId[] }): void {
  if (!payload.id.trim()) throw new CommandError("Boolean node id cannot be empty");
  if (document.nodes[payload.id]) throw new CommandError(`Node ${payload.id} already exists`);
  if (!BOOLEAN_OPERATIONS.includes(payload.operation)) throw new CommandError(`Unknown boolean operation ${payload.operation}`);
  const operands = payload.nodeIds.map(id => requireNode(document, id));
  if (operands.length < 2) throw new CommandError("Boolean group needs at least two operands");
  if (new Set(operands.map(node => node.id)).size !== operands.length) throw new CommandError("Boolean operands must be unique");
  if (!operands.every(supportsBooleanOperand)) throw new CommandError("Only shapes can be boolean operands");
  if (operands.some(node => node.locked)) throw new CommandError("Locked nodes cannot be boolean operands");
  if (operands.some(node => node.layout.rotation)) throw new CommandError("Rotated nodes cannot be boolean operands yet");
  const parentId = operands[0]!.parentId;
  if (operands.some(node => node.parentId !== parentId)) throw new CommandError("Boolean operands must share the same parent");
  const parent = requireContainer(document, parentId);

  const minX = Math.min(...operands.map(node => node.layout.x));
  const minY = Math.min(...operands.map(node => node.layout.y));
  const maxX = Math.max(...operands.map(node => node.layout.x + node.layout.width));
  const maxY = Math.max(...operands.map(node => node.layout.y + node.layout.height));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  const ordered = [...operands].sort((a, b) => parent.childIds.indexOf(a.id) - parent.childIds.indexOf(b.id));
  const topIndex = Math.max(...ordered.map(node => parent.childIds.indexOf(node.id)));
  const operandIds = new Set(payload.nodeIds);
  const remaining = parent.childIds.filter(childId => !operandIds.has(childId));
  const insertIndex = parent.childIds.slice(0, topIndex).filter(childId => !operandIds.has(childId)).length;
  remaining.splice(insertIndex, 0, payload.id);
  parent.childIds = remaining;

  const booleanNode: BooleanNode = {
    id: payload.id,
    type: "boolean",
    name: payload.name?.trim() || "布尔组",
    parentId,
    childIds: ordered.map(node => node.id),
    visible: true,
    locked: false,
    layout: { mode: "absolute", x: minX, y: minY, width, height, widthMode: "fixed", heightMode: "fixed" },
    appearance: { opacity: 1 },
    operation: payload.operation,
  };
  document.nodes[payload.id] = booleanNode;
  for (const operand of ordered) {
    operand.parentId = payload.id;
    operand.layout = { ...operand.layout, x: operand.layout.x - minX, y: operand.layout.y - minY };
  }
}

function setBooleanOperation(document: DesignDocument, payload: { id: NodeId; operation: BooleanOperation }): void {
  const node = requireNode(document, payload.id);
  if (node.type !== "boolean") throw new CommandError(`Node ${payload.id} is not a boolean group`);
  if (!BOOLEAN_OPERATIONS.includes(payload.operation)) throw new CommandError(`Unknown boolean operation ${payload.operation}`);
  node.operation = payload.operation;
}

/** 解除布尔组：操作数回到原父级并恢复绝对坐标，布尔节点删除、操作数 id 不变。 */
function releaseBoolean(document: DesignDocument, payload: { id: NodeId }): void {
  const node = requireNode(document, payload.id);
  if (node.type !== "boolean") throw new CommandError(`Node ${payload.id} is not a boolean group`);
  const owner = requireContainer(document, node.parentId);
  const index = owner.childIds.indexOf(node.id);
  const children = node.childIds.map(id => requireNode(document, id));
  for (const child of children) {
    child.parentId = node.parentId;
    child.layout = { ...child.layout, x: child.layout.x + node.layout.x, y: child.layout.y + node.layout.y };
  }
  const next = [...owner.childIds];
  next.splice(index < 0 ? next.length : index, 1, ...children.map(child => child.id));
  owner.childIds = next;
  delete document.nodes[node.id];
}