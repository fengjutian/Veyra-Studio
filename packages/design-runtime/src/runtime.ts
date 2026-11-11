import { BOOLEAN_OPERATIONS, MAX_LIST_INDENT, findOwningComponentId, fontKey, isFontMimeType, remapParagraphStyles, remapTextRuns, rotatedBoxBounds, setParagraphStyle, supportsBooleanOperand, isValidVectorPath, overridableFields, validateDocument, validateInteraction, validateTextRuns, wouldCreateComponentCycle, componentProperties, effectiveComponentProperties, isInsideSubtree, propertyTargets, resolvePropertyValue, validatePropertyValue, withPropertyBinding, BINDING_REQUIREMENTS, COMPONENT_PROPERTY_FIELDS, type BooleanNode, type BooleanOperation, type ComponentDefinition, type ComponentProperty, type ComponentPropertyField, type ComponentPropertyValue, type ComponentSetDefinition, type ConstraintAxis, type Constraints, type DesignDocument, type DesignNode, type DocumentFont, type FontStyle, type InstanceNode, type Interaction, type NodeId, type Paint, type TokenGroupMeta } from "@ufira/design-schema";
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

/** 合法的约束轴值。命令是从 JSON 进来的，编译期保证不了，只能在这里再判一次。 */
const CONSTRAINT_AXES: readonly ConstraintAxis[] = ["start", "end", "center", "stretch", "scale"];

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
    // 校验的**结果**要留下来，不能只当断言用。
    //
    // `validateDocument` 会按 schema 剥掉未声明的字段（zod 默认 strip）。把没校验的
    // draft 存回去的话，模型多写的字段就留在文档里了；而下一次 `preview` 会用
    // 「校验过的文档」（新 runtime 的构造函数会校验）和「没校验的文档」做前后对比——
    // 于是每个带多余字段的节点都变成「被改过了」，单页范围审查会把一份完全正常的计划
    // 判成越界并直接拦下。实测：一份 23 条命令、只新建本页节点的计划被报成
    // 「会修改 28 个页外节点」，那 28 个全是上一页的节点，模型根本没碰过它们。
    const validated = validateDocument(draft);

    const changes = { before, after: structuredClone(validated) };
    this.document = validated;
    this.undoStack.push(changes);
    this.redoStack = [];

    const warnings = collectWarnings(validated);
    this.transactions.push({
      commandId: envelope.commandId,
      documentId: envelope.documentId,
      revision: validated.revision,
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
    // 同上：留下校验后的文档，别留没校验的。
    const validated = validateDocument(after);
    this.document = validated;
    const warnings = collectWarnings(validated);
    const changes = { before, after: structuredClone(validated) };
    this.transactions.push({ commandId: request.commandId, documentId: validated.id, revision: validated.revision, committedAt, actor: structuredClone(request.actor), commands: [{ type: "history.restore", payload: { document: structuredClone(target) } }], warnings });
    return { revision: validated.revision, changes, inverse: { before: structuredClone(validated), after: before }, warnings };
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
      rejectUnknownFields(command.payload.patch as unknown as Record<string, unknown>, NODE_PATCH_FIELDS, "node.patch");
      prepareAppearance(command.payload.patch.appearance, "node.patch 的 appearance");
      if (command.payload.patch.slot !== undefined && typeof command.payload.patch.slot !== "boolean") throw new CommandError("Slot flag must be a boolean");
      if (command.payload.patch.overflow !== undefined) {
        const overflow = command.payload.patch.overflow;
        if (overflow !== "visible" && overflow !== "hidden" && overflow !== "scroll") {
          throw new CommandError(`Overflow mode must be visible, hidden or scroll, got ${String(overflow)}`);
        }
        // 溢出模式只对容器有意义：形状没有「内容超出盒子」这回事。
        if (node.type !== "frame" && node.type !== "component" && node.type !== "instance") {
          throw new CommandError(`Node ${node.id} of type ${node.type} cannot have an overflow mode`);
        }
      }
      if (command.payload.patch.position !== undefined) {
        const position = command.payload.patch.position;
        if (position !== "fixed" && position !== "sticky") {
          throw new CommandError(`Node position must be fixed or sticky, got ${String(position)}`);
        }
      }
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
      // 操作数变了，布尔组跟着 hug；手动改布尔组自己的尺寸不在这一步覆盖（下次改操作数才重算）。
      refreshBooleanAncestors(document, node.parentId);
      return;
    }
    case "text.patch": {
      const node = requireNode(document, command.payload.id);
      if (node.type !== "text") throw new CommandError(`Node ${node.id} is not a text node`);
      const { patch } = command.payload;
      rejectUnknownFields(patch as unknown as Record<string, unknown>, TEXT_PATCH_FIELDS, "text.patch");
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
      if (textChanged && node.paragraphStyles?.length) {
        // 段落样式同样要跟着文本走：区间必须对齐新文本的段落边界，否则文档直接不合法。
        // 这条与 runs 是**两条独立的轴**：调用方给了显式的 runs，不代表段落样式
        // 就不用跟着走（画布内联编辑提交时会同时给 text 与 runs）。
        const remapped = remapParagraphStyles(previousText, node.text, node.paragraphStyles);
        if (remapped.length) node.paragraphStyles = remapped;
        else delete node.paragraphStyles;
      }
      if (node.runs && node.runs.length === 0) delete node.runs;
      if (node.paragraphStyles && node.paragraphStyles.length === 0) delete node.paragraphStyles;
      return;
    }
    case "text.paragraph.set": {
      const node = requireNode(document, command.payload.id);
      if (node.type !== "text") throw new CommandError(`Node ${node.id} is not a text node`);
      const { from, to, style } = command.payload;
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new CommandError("Paragraph style range must use integer offsets");
      if (from < 0 || to > node.text.length) throw new CommandError("Paragraph style range must fall inside the text");
      if (style.listType !== undefined && style.listType !== "bullet" && style.listType !== "ordered" && style.listType !== "none") {
        throw new CommandError("Paragraph listType must be bullet, ordered or none");
      }
      if (style.indent !== undefined && (!Number.isInteger(style.indent) || style.indent < 0 || style.indent > MAX_LIST_INDENT)) {
        throw new CommandError(`Paragraph indent must be an integer between 0 and ${MAX_LIST_INDENT}`);
      }
      if (style.indentDelta !== undefined && (!Number.isInteger(style.indentDelta) || style.indentDelta < -MAX_LIST_INDENT || style.indentDelta > MAX_LIST_INDENT)) {
        throw new CommandError(`Paragraph indent delta must be an integer between -${MAX_LIST_INDENT} and ${MAX_LIST_INDENT}`);
      }
      if (style.paragraphIndent !== undefined && (!Number.isFinite(style.paragraphIndent) || style.paragraphIndent < 0)) {
        throw new CommandError("Paragraph indent must be a non-negative number");
      }
      if (style.listSpacing !== undefined && (!Number.isFinite(style.listSpacing) || style.listSpacing < 0)) {
        throw new CommandError("Paragraph list spacing must be a non-negative number");
      }
      if (style.hanging !== undefined && typeof style.hanging !== "boolean") {
        throw new CommandError("Paragraph hanging must be a boolean");
      }
      if (
        style.listType === undefined
        && style.indent === undefined
        && style.indentDelta === undefined
        && style.paragraphIndent === undefined
        && style.hanging === undefined
        && style.listSpacing === undefined
      ) {
        throw new CommandError("Paragraph style must set listType, indent, indentDelta, paragraphIndent, hanging or listSpacing");
      }
      const next = setParagraphStyle(node.text, node.paragraphStyles, from, to, style);
      if (next.length) node.paragraphStyles = next;
      else delete node.paragraphStyles;
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
      // 外部素材的缓存键：provider + 素材 id。缺一段就等于放弃了缓存语义
      // （同一个 id 在不同服务里是不同东西），所以这里直接拒掉。
      if (asset.external) {
        if (!asset.external.provider.trim()) throw new CommandError("External asset provider cannot be empty");
        if (!asset.external.providerAssetId.trim()) throw new CommandError("External asset provider id cannot be empty");
        if (Number.isNaN(Date.parse(asset.external.fetchedAt))) throw new CommandError("External asset fetchedAt must be an ISO timestamp");
        if (asset.external.expiresAt && Number.isNaN(Date.parse(asset.external.expiresAt))) throw new CommandError("External asset expiresAt must be an ISO timestamp");
      }
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
    case "theme.upsert": {
      const { theme } = command.payload;
      if (!theme.id.trim()) throw new CommandError("Theme id cannot be empty");
      if (!theme.name.trim()) throw new CommandError("Theme name cannot be empty");
      // 主题只能覆盖已有 token：拼错名字时早报，而不是存下一份永远不生效的覆盖。
      for (const name of Object.keys(theme.tokens)) {
        if (!document.tokens[name]) throw new CommandError(`Theme ${theme.id} overrides missing token ${name}`);
      }
      // 属性覆盖的值也要站得住：负圆角、透明度越界会让渲染出怪东西。
      for (const [name, override] of Object.entries(theme.properties ?? {})) {
        if (!name.trim()) throw new CommandError(`Theme ${theme.id} has a property override with an empty node name`);
        const nonNegative: Array<keyof typeof override> = ["cornerRadius", "gap", "padding"];
        for (const field of nonNegative) {
          const value = override[field];
          if (value === undefined) continue;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new CommandError(`Theme ${theme.id} property override ${name}.${field} must be a non-negative number`);
          }
        }
        if (override.fontSize !== undefined && (!Number.isFinite(override.fontSize) || override.fontSize <= 0)) {
          throw new CommandError(`Theme ${theme.id} property override ${name}.fontSize must be a positive number`);
        }
        if (override.opacity !== undefined && (!Number.isFinite(override.opacity) || override.opacity < 0 || override.opacity > 1)) {
          throw new CommandError(`Theme ${theme.id} property override ${name}.opacity must be between 0 and 1`);
        }
      }
      const themes = document.themes ?? [];
      const next = structuredClone(theme);
      const index = themes.findIndex(item => item.id === theme.id);
      document.themes = index >= 0
        ? themes.map((item, position) => (position === index ? next : item))
        : [...themes, next];
      return;
    }
    case "theme.delete": {
      const themes = document.themes ?? [];
      if (!themes.some(item => item.id === command.payload.id)) {
        throw new CommandError(`Theme ${command.payload.id} does not exist`);
      }
      document.themes = themes.filter(item => item.id !== command.payload.id);
      return;
    }
    case "tokenGroup.upsert": {
      const { group } = command.payload;
      // 空 id 是合法分组（未分组），所以这里不拦空串——只拦类型不对的值。
      const next: TokenGroupMeta = { id: group.id };
      const label = group.label?.trim();
      if (label) next.label = label;
      const description = group.description?.trim();
      if (description) next.description = description;
      if (group.order !== undefined) {
        if (!Number.isFinite(group.order)) throw new CommandError("Token group order must be a finite number");
        next.order = group.order;
      }
      const metas = document.tokenGroups ?? [];
      const index = metas.findIndex(item => item.id === group.id);
      // 同一分组只保留一份元数据：重复 upsert 是覆盖，不是追加。
      document.tokenGroups = index >= 0
        ? metas.map((item, position) => (position === index ? next : item))
        : [...metas, next];
      return;
    }
    case "tokenGroup.delete": {
      const metas = document.tokenGroups ?? [];
      if (!metas.some(item => item.id === command.payload.id)) {
        throw new CommandError(`Token group ${command.payload.id} does not exist`);
      }
      document.tokenGroups = metas.filter(item => item.id !== command.payload.id);
      return;
    }
    case "page.create": return createPage(document, command.payload.page, command.payload.index);
    case "page.rename": {
      const page = document.pages[command.payload.id];
      if (!page) throw new CommandError(`Page ${command.payload.id} does not exist`);
      if (!command.payload.name.trim()) throw new CommandError("Page name cannot be empty");
      page.name = command.payload.name;
      return;
    }
    case "page.resize": {
      const page = document.pages[command.payload.id];
      if (!page) throw new CommandError(`Page ${command.payload.id} does not exist`);
      const { width, height } = command.payload;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 8192 || height > 8192) {
        throw new CommandError("Page size must use whole pixels between 64 and 8192");
      }
      page.width = width;
      page.height = height;
      return;
    }
    case "page.delete": return deletePage(document, command.payload.id);
    case "page.setTheme": {
      const page = document.pages[command.payload.id];
      if (!page) throw new CommandError(`Page ${command.payload.id} does not exist`);
      const themeId = command.payload.themeId?.trim();
      if (!themeId) {
        // 清掉页面主题，这一页回到基础值 / 视图层选的主题。
        delete page.themeId;
        return;
      }
      // 主题必须存在：页面指向不存在的主题，这一页会安静地按基础值渲染——
      // 用户以为这一页是暗色，其实不是。
      if (!(document.themes ?? []).some(theme => theme.id === themeId)) {
        throw new CommandError(`Theme ${themeId} does not exist`);
      }
      page.themeId = themeId;
      return;
    }
    case "component.define": return defineComponent(document, command.payload.component);
    case "component.create": return createComponent(document, command.payload.id, command.payload.nodeId, command.payload.name);
    case "component.setCreate": return createComponentSet(document, command.payload.set);
    case "component.setVariant": return assignComponentVariant(document, command.payload);
    case "component.setProperty.set": return setComponentSetProperty(document, command.payload);
    case "component.setProperty.remove": return removeComponentSetProperty(document, command.payload);
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
    case "component.property.set": return setComponentProperty(document, command.payload);
    case "component.property.remove": return removeComponentProperty(document, command.payload);
    case "component.property.bind": return bindComponentProperty(document, command.payload);
    case "component.property.unbind": return unbindComponentProperty(document, command.payload);
    case "instance.property.set": return setInstanceProperty(document, command.payload);
    case "instance.property.reset": return resetInstanceProperty(document, command.payload);
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
  // 共享的组件属性声明：类型与默认值必须配对。
  const shared = [...(set.componentProperties ?? [])];
  const sharedIds = new Set<string>();
  for (const property of shared) {
    if (!property.id.trim()) throw new CommandError("Property id cannot be empty");
    if (!property.name.trim()) throw new CommandError("Property name cannot be empty");
    if (sharedIds.has(property.id)) throw new CommandError(`Component set ${set.id} has duplicate property ${property.id}`);
    sharedIds.add(property.id);
    const problem = validatePropertyValue(property, property.defaultValue, { document });
    if (problem) throw new CommandError(`Property ${property.id} ${problem}`);
  }
  document.componentSets = {
    ...(document.componentSets ?? {}),
    [set.id]: { id: set.id, name: set.name.trim(), properties, ...(shared.length ? { componentProperties: shared } : {}) },
  };
}

/**
 * 组件自己的属性声明是不是**从共享声明继承来的拷贝**。
 *
 * 拷贝与共享声明在名字、类型、默认值上完全一致 —— 它没有表达任何特化意图，
 * 共享声明改了它就该跟着改。
 *
 * 任何一项不同（改了名字、改了默认值、换了类型）都算**显式特化**，必须保留。
 * 共享声明不存在时谈不上继承，一律按特化处理。
 */
function isInheritedCopy(own: ComponentProperty, shared: ComponentProperty | undefined): boolean {
  if (!shared) return false;
  return own.type === shared.type && own.name === shared.name && own.defaultValue === shared.defaultValue;
}

/**
 * 从组件的属性声明里删掉一条；删空时把整个字段去掉（不留空数组）。
 *
 * 少了这个字段，组件就变成「不自己声明这条属性」，直接继承变体集的共享声明。
 */
function dropComponentPropertyDeclaration(component: ComponentDefinition, propertyId: string): void {
  const next = (component.properties ?? []).filter(property => property.id !== propertyId);
  if (next.length) component.properties = next;
  else delete component.properties;
}

/**
 * 给变体集声明一个**共享**的组件属性。
 *
 * 共享声明的语义：集内所有变体都拿到这一组属性，不必各自重复声明。
 * 成员组件不得用同一个 id 声明成别的类型——那会破坏共享契约。
 */
function setComponentSetProperty(document: DesignDocument, payload: { setId: string; property: ComponentProperty }): void {
  const set = document.componentSets?.[payload.setId];
  if (!set) throw new CommandError(`Component set ${payload.setId} does not exist`);
  const property = payload.property;
  if (!property.id.trim()) throw new CommandError("Property id cannot be empty");
  if (!property.name.trim()) throw new CommandError("Property name cannot be empty");
  const problem = validatePropertyValue(property, property.defaultValue, { document });
  if (problem) throw new CommandError(`Property ${property.id} ${problem}`);
  for (const component of Object.values(document.components)) {
    if (component.variantSetId !== set.id) continue;
    const own = (component.properties ?? []).find(candidate => candidate.id === property.id);
    if (own && own.type !== property.type) {
      throw new CommandError(`Component ${component.id} declares property ${property.id} as ${own.type}, which conflicts with the shared ${property.type}`);
    }
  }
  const shared = [...(set.componentProperties ?? [])];
  const index = shared.findIndex(candidate => candidate.id === property.id);
  // 改之前的共享声明：用来分辨成员组件那条声明是「继承来的拷贝」还是「显式特化」。
  const previous = index >= 0 ? shared[index] : undefined;
  if (index >= 0) shared[index] = property;
  else shared.push(property);
  set.componentProperties = shared;
  // 集合默认值变了，成员组件里那条**继承来的拷贝**必须跟着变：
  // 否则变体面板显示的还是旧默认值（own 优先于 shared）。
  // 做法是把拷贝删掉——变体直接继承新的共享声明，以后集合再改也会自动跟上。
  // 显式特化（改了名字/类型/默认值）的拷贝保留不动。
  const inheritedFrom = previous ?? property;
  for (const component of Object.values(document.components)) {
    if (component.variantSetId !== set.id) continue;
    const own = (component.properties ?? []).find(candidate => candidate.id === property.id);
    if (own && isInheritedCopy(own, inheritedFrom)) {
      dropComponentPropertyDeclaration(component, property.id);
    }
    applyComponentProperties(document, component.id);
  }
}

/**
 * 删除变体集共享的组件属性。
 *
 * 成员组件自己没有声明同名属性时，那条属性对它们就不存在了：
 * 绑定与实例值要一起清掉，副本恢复成组件定义的原始样子。
 */
function removeComponentSetProperty(document: DesignDocument, payload: { setId: string; propertyId: string }): void {
  const set = document.componentSets?.[payload.setId];
  if (!set) throw new CommandError(`Component set ${payload.setId} does not exist`);
  const shared = set.componentProperties ?? [];
  const removed = shared.find(property => property.id === payload.propertyId);
  if (!removed) {
    throw new CommandError(`Property ${payload.propertyId} is not shared by component set ${set.id}`);
  }
  set.componentProperties = shared.filter(property => property.id !== payload.propertyId);
  for (const component of Object.values(document.components)) {
    if (component.variantSetId !== set.id) continue;
    const own = (component.properties ?? []).find(property => property.id === payload.propertyId);
    if (own) {
      // 显式特化保留：它已经是这个组件自己的属性，与共享声明无关。
      if (!isInheritedCopy(own, removed)) continue;
      // 与被删掉的共享声明一模一样的拷贝是继承来的：共享声明没了，它也不该留下。
      dropComponentPropertyDeclaration(component, payload.propertyId);
    }
    detachProperty(document, component.id, payload.propertyId);
    applyComponentProperties(document, component.id);
  }
}

/**
 * 把一个属性从组件的有效声明里摘掉：清掉绑定与实例值，并恢复副本。
 *
 * 组件**自己**的声明不动——只有共享声明被删掉时才用得上。
 */
function detachProperty(document: DesignDocument, componentId: string, propertyId: string): void {
  const affected: NodeId[] = [];
  for (const node of Object.values(document.nodes)) {
    const bindings = node.componentPropertyBindings;
    if (!bindings) continue;
    const bound = COMPONENT_PROPERTY_FIELDS.filter(field => bindings[field] === propertyId);
    if (!bound.length) continue;
    const next = { ...bindings };
    for (const field of bound) delete next[field];
    if (Object.values(next).some(value => value !== undefined)) node.componentPropertyBindings = next;
    else delete node.componentPropertyBindings;
    affected.push(node.id);
  }
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "instance" || node.componentId !== componentId) continue;
    if (node.propValues?.[propertyId] !== undefined) {
      const next = { ...node.propValues };
      delete next[propertyId];
      node.propValues = next;
    }
    for (const sourceNodeId of affected) restoreCopyFromSource(document, node.id, sourceNodeId);
  }
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
    if (other === signature) throw new CommandError(`Variant ${signature.split("\u0000").join(", ")} already exists as ${id}`);
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
  // 属性声明复制到新变体（属性 id 保持一致），节点上的绑定随节点一起被复制，
  // 于是切换变体时实例的属性值能按 id 继续对上。
  //
  // 但**从共享声明继承来的拷贝不复制**：那份拷贝只会让变体显示共享声明的旧默认值
  // （own 优先于 shared），集合默认值一变就对不上。删掉它，变体直接继承共享声明。
  // 组件自己声明的属性（不在共享声明里，或与共享声明不同——显式特化）照常复制。
  const sharedById = new Map((set.componentProperties ?? []).map(property => [property.id, property]));
  const ownProperties = (source.properties ?? []).filter(property => !isInheritedCopy(property, sharedById.get(property.id)));
  document.components[payload.componentId] = {
    id: payload.componentId,
    name: payload.name.trim(),
    rootNodeId: rootId,
    variantSetId: set.id,
    variant: { ...payload.values },
    ...(ownProperties.length ? { properties: structuredClone(ownProperties) } : {}),
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
    // 绑定属于组件定义，不属于副本。
    delete copy.componentPropertyBindings;
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
  // 属性值按属性 id 保留；新变体没有的属性 id 会被丢弃（它在那里不存在）。
  // 有效声明含变体集共享声明——共享的属性在切换后依然存在。
  const nextPropertyIds = new Set(effectiveComponentProperties(document, next.id).map(property => property.id));
  if (instance.propValues) {
    const kept: Record<string, ComponentPropertyValue> = {};
    for (const [propertyId, value] of Object.entries(instance.propValues)) {
      if (nextPropertyIds.has(propertyId)) kept[propertyId] = value;
    }
    instance.propValues = kept;
  }
  document.nodes[node.id] = instance;
  applyOverrides(instance, keptOverrides, copies, document);
  applyInstanceProperties(document, instance);
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
  // 属性值也是「与组件的关系」，脱离后不再有意义。
  delete (detached as { propValues?: Record<string, string | boolean> }).propValues;
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

/**
 * 把实例的属性值应用到它的物化副本上。
 *
 * 属性值**在 override 之后**应用 —— 属性是更高层的契约，优先于字段级覆盖。
 * 写入的是纯文本：被绑定的文本副本上的段内样式会被清掉（区间必然失效）。
 *
 * 副本 id 用 `${instanceId}--${sourceId}`：物化时每一层的源 id 都是原样保留的，
 * 所以这个拼接对任意深度都成立。
 */
function applyInstanceProperties(document: DesignDocument, instance: InstanceNode): void {
  const definition = document.components[instance.componentId];
  if (!definition) return;
  for (const target of propertyTargets(document, instance.componentId)) {
    const copy = document.nodes[`${instance.id}--${target.sourceNodeId}`];
    if (!copy) continue;
    const value = resolvePropertyValue(document, instance, target.property);
    applyPropertyToCopy(document, copy, target.field, value);
  }
}

/**
 * 把一个属性值写到副本的对应字段上。
 *
 * 字段与属性类型的对应由 `BINDING_REQUIREMENTS` 决定：
 * `text` ↔ text、`visible` ↔ boolean、`fill` ↔ color、
 * `fontSize` ↔ number、`instance` ↔ instance-swap。
 */
function applyPropertyToCopy(document: DesignDocument, copy: DesignNode, field: ComponentPropertyField, value: ComponentPropertyValue): void {
  switch (field) {
    case "text": {
      if (copy.type !== "text") return;
      const previous = copy.text;
      const next = String(value);
      copy.text = next;
      // 段内样式按「最长公共前缀 + 后缀」对齐到新文本，而不是一律清空：
      // - 完全不同的文本 → 旧区间失效，样式自然消失（不报错）；
      // - 子串替换 → 前后缀对应区间的样式保留下来。
      const runs = remapTextRuns(previous, next, copy.runs);
      if (runs.length) copy.runs = runs;
      else delete copy.runs;
      // 段落样式同理：按段落边界重新吸附，列表项不会因为改了文字就丢掉缩进。
      const paragraphStyles = remapParagraphStyles(previous, next, copy.paragraphStyles);
      if (paragraphStyles.length) copy.paragraphStyles = paragraphStyles;
      else delete copy.paragraphStyles;
      return;
    }
    case "visible": {
      copy.visible = Boolean(value);
      return;
    }
    case "fill": {
      copy.appearance = { ...copy.appearance, fills: [{ type: "solid", color: String(value) }] };
      return;
    }
    case "fontSize": {
      if (copy.type !== "text") return;
      copy.fontSize = Number(value);
      return;
    }
    case "instance": {
      if (copy.type !== "instance") return;
      const componentId = String(value);
      // 空串表示「未设置」：保持组件定义里的原始实例，不做交换。
      if (!componentId || copy.componentId === componentId) return;
      swapInstanceComponent(document, copy, componentId);
      return;
    }
  }
}

/**
 * 把组件内部的一个实例副本换成另一个组件。
 *
 * 实例交换是「换掉整个子树」：旧子树删掉，新组件的根子树重新物化到副本下。
 * 副本 id 规则与物化一致（`${parentCopyId}--${sourceId}`），所以交换之后
 * 外层实例的 id 结构不变。
 */
function swapInstanceComponent(document: DesignDocument, copy: InstanceNode, componentId: string): void {
  const definition = document.components[componentId];
  if (!definition) throw new CommandError(`Component ${componentId} does not exist`);
  const root = requireNode(document, definition.rootNodeId);
  for (const childId of [...copy.childIds]) removeSubtree(document, childId);
  copy.childIds = [];
  copy.componentId = componentId;
  // 旧组件的覆盖对不上新组件的源节点，直接清掉。
  copy.overrides = {};
  for (const childId of root.childIds) {
    copy.childIds.push(materializeNode(document, childId, copy.id));
  }
}

/**
 * 把组件定义里的一个节点复制成物化副本，挂到 `parentId` 下。
 *
 * 副本 id 是 `${parentId}--${sourceId}`：`parentId` 本身已经是副本 id，
 * 所以这个拼接对任意深度都成立（实例物化与实例交换共用同一套规则）。
 *
 * 绑定是组件定义的属性，不是副本的：副本上的绑定会被剥掉，
 * 否则副本会指向一个它并不属于的组件的属性。
 */
function materializeNode(document: DesignDocument, sourceId: NodeId, parentId: NodeId, copies?: Map<NodeId, NodeId>): NodeId {
  const source = requireNode(document, sourceId);
  const copyId = `${parentId}--${sourceId}`;
  if (document.nodes[copyId]) throw new CommandError(`Node ${copyId} is already materialized`);
  copies?.set(sourceId, copyId);
  const copy = structuredClone(source) as DesignNode;
  copy.id = copyId;
  copy.parentId = parentId;
  copy.childIds = [];
  delete copy.componentPropertyBindings;
  document.nodes[copyId] = copy;
  for (const childId of source.childIds) {
    copy.childIds.push(materializeNode(document, childId, copyId, copies));
  }
  return copyId;
}

/** 删掉一棵子树（不碰父节点的 childIds——交换时父节点自己会被重写）。 */
function removeSubtree(document: DesignDocument, nodeId: NodeId): void {
  const node = document.nodes[nodeId];
  if (!node) return;
  for (const childId of [...node.childIds]) removeSubtree(document, childId);
  delete document.nodes[nodeId];
}

/** 把组件的属性值重新应用到它的所有实例上。 */
function applyComponentProperties(document: DesignDocument, componentId: string): void {
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "instance" || node.componentId !== componentId) continue;
    applyInstanceProperties(document, node);
  }
}

/** 把实例副本的字段恢复成组件定义里的原始样子。 */
function restoreCopyFromSource(document: DesignDocument, instanceId: NodeId, sourceNodeId: NodeId): void {
  const source = document.nodes[sourceNodeId];
  const copy = document.nodes[`${instanceId}--${sourceNodeId}`];
  if (!source || !copy) return;
  copy.visible = source.visible;
  // 填充色与字号也可能被属性接管：解绑后要回到组件定义的原始样子。
  copy.appearance = structuredClone(source.appearance);
  if (copy.type === "text" && source.type === "text") {
    copy.text = source.text;
    copy.fontSize = source.fontSize;
    if (source.runs) copy.runs = structuredClone(source.runs);
    else delete copy.runs;
    if (source.paragraphStyles) copy.paragraphStyles = structuredClone(source.paragraphStyles);
    else delete copy.paragraphStyles;
  }
}

/**
 * 声明或更新一个组件属性。
 *
 * 同一个 id 再次提交就是更新。改默认值会立刻作用到该组件的所有实例——
 * 没显式改过值的实例跟着变，改过的实例保持自己的值。
 */
function setComponentProperty(document: DesignDocument, payload: { componentId: string; property: ComponentProperty }): void {
  const component = document.components[payload.componentId];
  if (!component) throw new CommandError(`Component ${payload.componentId} does not exist`);
  const property = payload.property;
  if (!property.id.trim()) throw new CommandError("Property id cannot be empty");
  if (!property.name.trim()) throw new CommandError("Property name cannot be empty");
  // 类型与默认值必须配对。类型系统已经保证编译期一致，但命令可以从 JSON 进来，
  // 所以这里按「未收窄的值」再判一次。
  const defaultProblem = validatePropertyValue(property, property.defaultValue, { document });
  if (defaultProblem) throw new CommandError(`Property ${property.id} ${defaultProblem}`);

  const properties = [...(component.properties ?? [])];
  const index = properties.findIndex(existing => existing.id === property.id);
  const previous = index >= 0 ? properties[index] : undefined;
  // 变体集共享声明的属性不得改类型：那是破坏共享契约。
  const shared = document.componentSets?.[component.variantSetId ?? ""]?.componentProperties ?? [];
  const sharedProperty = shared.find(candidate => candidate.id === property.id);
  if (sharedProperty && sharedProperty.type !== property.type) {
    throw new CommandError(`Property ${property.id} is shared by the variant set and cannot change its type`);
  }
  // 改类型会让已有绑定和实例值失效：绑定字段与类型不匹配的直接拒绝，
  // 实例值则清掉（它们是旧类型的值，留着只会让文档非法）。
  if (previous && previous.type !== property.type) {
    for (const target of propertyTargets(document, component.id)) {
      if (target.property.id !== property.id) continue;
      const requirement = BINDING_REQUIREMENTS[target.field];
      if (requirement.propertyType !== property.type) {
        throw new CommandError(`Property ${property.id} is bound to ${target.field} and cannot change to ${property.type}`);
      }
    }
    for (const node of Object.values(document.nodes)) {
      if (node.type !== "instance" || node.componentId !== component.id) continue;
      if (!node.propValues) continue;
      const next = { ...node.propValues };
      delete next[property.id];
      node.propValues = next;
    }
  }
  if (index >= 0) properties[index] = property;
  else properties.push(property);
  component.properties = properties;

  applyComponentProperties(document, component.id);
}

/**
 * 删除一个组件属性。
 *
 * 同时清掉：组件子树里指向它的绑定、各实例上的显式值；
 * 被绑定的字段恢复成组件定义里的原始样子。
 */
function removeComponentProperty(document: DesignDocument, payload: { componentId: string; propertyId: string }): void {
  const component = document.components[payload.componentId];
  if (!component) throw new CommandError(`Component ${payload.componentId} does not exist`);
  const properties = component.properties ?? [];
  if (!properties.some(property => property.id === payload.propertyId)) {
    throw new CommandError(`Property ${payload.propertyId} does not exist on component ${component.id}`);
  }
  component.properties = properties.filter(property => property.id !== payload.propertyId);

  // 清理绑定与实例值，被绑定的字段恢复成组件定义里的原始样子。
  detachProperty(document, component.id, payload.propertyId);
  applyComponentProperties(document, component.id);
}

/**
 * 把组件属性绑定到组件内部某个节点的字段。
 *
 * 节点必须在组件根子树**内部**（组件根本身只是容器）；字段与属性类型、
 * 节点类型必须对得上。同一字段重复绑定是覆盖。
 */
function bindComponentProperty(
  document: DesignDocument,
  payload: { componentId: string; propertyId: string; nodeId: NodeId; field: ComponentPropertyField },
): void {
  const component = document.components[payload.componentId];
  if (!component) throw new CommandError(`Component ${payload.componentId} does not exist`);
  // 有效声明 = 变体集共享声明 + 组件自己的声明。
  const property = effectiveComponentProperties(document, component.id).find(candidate => candidate.id === payload.propertyId);
  if (!property) throw new CommandError(`Property ${payload.propertyId} does not exist on component ${component.id}`);
  const node = requireNode(document, payload.nodeId);
  if (!isInsideSubtree(document, node.id, component.rootNodeId)) {
    throw new CommandError(`Node ${node.id} is not inside component ${component.id}`);
  }
  // 字段 → 属性类型、节点类型的要求由同一张表给出（`BINDING_REQUIREMENTS`）。
  const requirement = BINDING_REQUIREMENTS[payload.field];
  if (property.type !== requirement.propertyType) {
    throw new CommandError(`Property ${property.id} is a ${property.type} property and cannot bind ${payload.field}`);
  }
  if (requirement.nodeType && node.type !== requirement.nodeType) {
    throw new CommandError(`Node ${node.id} is not a ${requirement.nodeType} node and cannot bind ${payload.field}`);
  }

  node.componentPropertyBindings = withPropertyBinding(node.componentPropertyBindings, payload.field, property.id);
  applyComponentProperties(document, component.id);
}

/** 解除绑定；被绑定的字段恢复成组件定义里的原始样子。 */
function unbindComponentProperty(
  document: DesignDocument,
  payload: { componentId: string; propertyId: string; nodeId: NodeId; field: ComponentPropertyField },
): void {
  const component = document.components[payload.componentId];
  if (!component) throw new CommandError(`Component ${payload.componentId} does not exist`);
  const node = requireNode(document, payload.nodeId);
  const bindings = node.componentPropertyBindings;
  if (!bindings) throw new CommandError(`Node ${node.id} has no component property bindings`);
  const current = bindings[payload.field];
  if (current !== payload.propertyId) {
    throw new CommandError(`Node ${node.id} is not bound to property ${payload.propertyId} on field ${payload.field}`);
  }
  const next = { ...bindings };
  delete next[payload.field];
  if (Object.values(next).some(value => value !== undefined)) node.componentPropertyBindings = next;
  else delete node.componentPropertyBindings;

  for (const instance of Object.values(document.nodes)) {
    if (instance.type !== "instance" || instance.componentId !== component.id) continue;
    restoreCopyFromSource(document, instance.id, node.id);
    applyInstanceProperties(document, instance);
  }
}

/** 设置实例的属性值；立刻作用到物化副本。 */
function setInstanceProperty(document: DesignDocument, payload: { instanceId: NodeId; propertyId: string; value: ComponentPropertyValue }): void {
  const instance = requireInstance(document, payload.instanceId);
  const component = document.components[instance.componentId];
  if (!component) throw new CommandError(`Component ${instance.componentId} does not exist`);
  // 有效声明 = 变体集共享声明 + 组件自己的声明。
  const property = effectiveComponentProperties(document, instance.componentId).find(candidate => candidate.id === payload.propertyId);
  if (!property) throw new CommandError(`Property ${payload.propertyId} is not declared by component ${instance.componentId}`);
  const problem = validatePropertyValue(property, payload.value, { document });
  if (problem) throw new CommandError(`Property ${property.id} ${problem}`);
  instance.propValues = { ...(instance.propValues ?? {}), [property.id]: payload.value };
  applyInstanceProperties(document, instance);
}

/** 删掉实例的显式值，回到组件声明的默认值。 */
function resetInstanceProperty(document: DesignDocument, payload: { instanceId: NodeId; propertyId: string }): void {
  const instance = requireInstance(document, payload.instanceId);
  const component = document.components[instance.componentId];
  if (!component) throw new CommandError(`Component ${instance.componentId} does not exist`);
  if (!instance.propValues || instance.propValues[payload.propertyId] === undefined) {
    throw new CommandError(`Instance ${instance.id} has no explicit value for property ${payload.propertyId}`);
  }
  const next = { ...instance.propValues };
  delete next[payload.propertyId];
  instance.propValues = next;
  applyInstanceProperties(document, instance);
}

/** 给实例里的物化副本写入覆盖值，并把它记进实例的 overrides。 */
function overrideInstanceNode(
  document: DesignDocument,
  payload: {
    instanceId: NodeId;
    sourceNodeId: NodeId;
    patch: { text?: string; name?: string; visible?: boolean; appearance?: { fills?: Paint[]; stroke?: string; opacity?: number; cornerRadius?: number }; constraints?: Partial<Constraints> };
  },
): void {
  const instance = requireNode(document, payload.instanceId);
  if (instance.type !== "instance") throw new CommandError(`Node ${instance.id} is not a component instance`);
  const copyId = `${instance.id}--${payload.sourceNodeId}`;
  const copy = requireNode(document, copyId);
  if (!isInside(document, copyId, instance.id)) throw new CommandError(`Node ${copyId} does not belong to instance ${instance.id}`);

  const { text, name, visible, appearance, constraints } = payload.patch;
  const patchRecord = payload.patch as Record<string, unknown>;
  const patchKeys = Object.keys(patchRecord).filter(key => patchRecord[key] !== undefined);
  const allowed = overridableFields(copy);
  for (const key of patchKeys) {
    if (!(allowed as readonly string[]).includes(key)) throw new CommandError(`Node ${copy.id} cannot override ${key}`);
  }
  // 被组件属性驱动的字段不能被 override 覆盖：属性值在物化时最后应用，
  // 覆盖写了也会被盖掉——这里直接拒绝，不让人以为改成功了。
  const source = document.nodes[payload.sourceNodeId];
  const bindings = source?.componentPropertyBindings;
  if (bindings?.text && text !== undefined) {
    throw new CommandError(`Node ${copy.id} text is controlled by component property ${bindings.text}`);
  }
  if (bindings?.visible && visible !== undefined) {
    throw new CommandError(`Node ${copy.id} visibility is controlled by component property ${bindings.visible}`);
  }
  if (!patchKeys.length) throw new CommandError("Override patch cannot be empty");
  if (appearance?.opacity !== undefined && (!Number.isFinite(appearance.opacity) || appearance.opacity < 0 || appearance.opacity > 1)) {
    throw new CommandError("Override opacity must be between 0 and 1");
  }
  if (appearance?.cornerRadius !== undefined && (!Number.isFinite(appearance.cornerRadius) || appearance.cornerRadius < 0)) {
    throw new CommandError("Override corner radius must be a non-negative number");
  }
  if (constraints !== undefined) {
    for (const axis of ["horizontal", "vertical"] as const) {
      const value = constraints[axis];
      if (value === undefined) continue;
      if (!CONSTRAINT_AXES.includes(value)) {
        throw new CommandError(`Override ${axis} constraint must be one of ${CONSTRAINT_AXES.join(", ")}`);
      }
    }
  }
  if (text !== undefined) {
    if (copy.type !== "text") throw new CommandError(`Node ${copyId} is not a text node`);
    // 覆盖文本会改变段落边界：段落样式区间必须跟着重排，否则文档立刻不合法。
    const previousText = copy.text;
    copy.text = text;
    if (previousText !== text && copy.paragraphStyles?.length) {
      const remapped = remapParagraphStyles(previousText, text, copy.paragraphStyles);
      if (remapped.length) copy.paragraphStyles = remapped;
      else delete copy.paragraphStyles;
    }
  }
  if (name !== undefined) copy.name = name;
  if (visible !== undefined) copy.visible = visible;
  if (appearance !== undefined) copy.appearance = { ...copy.appearance, ...appearance };
  // 约束是「父级尺寸变了怎么办」：只改这个实例里的副本，组件定义不动。
  // 覆盖可以只给一个轴，另一个轴沿用副本原来的值。
  if (constraints !== undefined) {
    copy.constraints = {
      horizontal: constraints.horizontal ?? copy.constraints?.horizontal ?? "start",
      vertical: constraints.vertical ?? copy.constraints?.vertical ?? "start",
    };
  }

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
      ...(constraints !== undefined ? { constraints } : {}),
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
  // 约束也回到组件定义里的样子：重置覆盖 = 这个节点完全听组件定义的话。
  if (source.constraints) copy.constraints = structuredClone(source.constraints);
  else delete copy.constraints;
  if (copy.type === "text" && source.type === "text") {
    copy.text = source.text;
    if (source.paragraphStyles) copy.paragraphStyles = structuredClone(source.paragraphStyles);
    else delete copy.paragraphStyles;
  }

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
  const materializedChildIds = root.childIds.map(childId => materializeNode(document, childId, node.id, copies));
  const instance = structuredClone(node) as InstanceNode;
  instance.childIds = materializedChildIds;

  applyOverrides(instance, node.overrides, copies, document);
  applyInstanceProperties(document, instance);

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
    if (copy.type === "text" && typeof patch.text === "string") {
      const previousText = copy.text;
      copy.text = patch.text;
      if (previousText !== patch.text && copy.paragraphStyles?.length) {
        const remapped = remapParagraphStyles(previousText, patch.text, copy.paragraphStyles);
        if (remapped.length) copy.paragraphStyles = remapped;
        else delete copy.paragraphStyles;
      }
    }
    if (typeof patch.name === "string") copy.name = patch.name;
    if (patch.appearance && typeof patch.appearance === "object") copy.appearance = { ...copy.appearance, ...(patch.appearance as object) };
    if (patch.layout && typeof patch.layout === "object") copy.layout = { ...copy.layout, ...(patch.layout as object) };
    if (patch.bindings && typeof patch.bindings === "object") copy.bindings = { ...copy.bindings, ...(patch.bindings as object) };
    // 约束覆盖：物化时就得落到副本上，否则实例化之后约束是组件定义里的那份。
    // 覆盖可以只给一个轴，另一个轴沿用副本原来的值（都没有时用缺省的 start）。
    if (patch.constraints && typeof patch.constraints === "object") {
      const next = patch.constraints as Partial<Constraints>;
      copy.constraints = {
        horizontal: next.horizontal ?? copy.constraints?.horizontal ?? "start",
        vertical: next.vertical ?? copy.constraints?.vertical ?? "start",
      };
    }
  }
}

function createNode(document: DesignDocument, node: DesignNode, index?: number): void {
  if (document.nodes[node.id]) throw new CommandError(`Node ${node.id} already exists`);
  if (node.childIds.length) throw new CommandError("New nodes cannot reference children that have not been created in the same tree operation");
  prepareAppearance(node.appearance, `节点 ${node.id} 的 appearance`);
  const owner = requireContainer(document, node.parentId);
  document.nodes[node.id] = structuredClone(node);
  insertAt(owner.childIds, node.id, index);
  refreshBooleanAncestors(document, node.parentId);
}

/** node.patch 允许出现的字段（与命令类型定义一致）。 */
const NODE_PATCH_FIELDS = ["name", "visible", "locked", "layout", "appearance", "bindings", "slot", "mask", "maskFeather", "constraints", "overflow", "position"] as const;

/** text.patch 允许出现的字段。 */
const TEXT_PATCH_FIELDS = ["text", "fontFamily", "fontSize", "lineHeight", "fontWeight", "fontStyle", "textAlign", "letterSpacing", "runs"] as const;

/** appearance 允许出现的字段。 */
const APPEARANCE_FIELDS = ["opacity", "fills", "stroke", "strokeWidth", "cornerRadius", "cornerRadii", "shadow", "blur", "blendMode", "backgroundBlur"] as const;

/**
 * 拒绝未知字段。
 *
 * 命令的来源是不可信的 JSON：模型给的计划、导入的文档。用 `Object.assign` 落地的话，
 * 字段名写错也会「成功」——命令成功、文档没变。这种静默失败最难查：编排循环会把
 * 它当成一次有效改动，反复提交同样无效的东西，直到被判成震荡。
 *
 * 宁可报错：调用方（界面、以及拿到错误信息的模型）能看见问题出在哪。
 */
function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new CommandError(`${label} 里有未知字段 "${key}"；可用字段：${allowed.join(", ")}`);
    }
  }
}

/**
 * 外观对象的旧字段归一化 + 未知字段拒绝。
 *
 * 旧格式用 `appearance.fill`（单值字符串），现在用 `appearance.fills`（数组）。
 * 有一批节点是在改格式那阵子造出来的，磁盘上仍是旧写法——它们在画布上**没有颜色**。
 * 这里顺手修好（不报错：报错会让这些文档打不开），其余未知字段则拒绝。
 */
function prepareAppearance(appearance: unknown, label: string): void {
  if (!appearance || typeof appearance !== "object") return;
  const record = appearance as Record<string, unknown>;
  const legacy = record.fill;
  if (typeof legacy === "string" && legacy.trim() && !record.fills) {
    record.fills = [{ type: "solid", color: legacy }];
  }
  delete record.fill;
  rejectUnknownFields(record, APPEARANCE_FIELDS, label);
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
  refreshBooleanAncestors(document, node.parentId);
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
  const oldParentId = node.parentId;
  oldOwner.childIds = oldOwner.childIds.filter(childId => childId !== id);
  insertAt(newOwner.childIds, id, index);
  node.parentId = parentId;
  refreshBooleanAncestors(document, oldParentId);
  refreshBooleanAncestors(document, parentId);
}

function requireNode(document: DesignDocument, id: NodeId): DesignNode {
  const node = document.nodes[id];
  if (!node) throw new CommandError(`Node ${id} does not exist${suggestNodeHint(document, id)}`);
  return node;
}

/**
 * 节点 id 不存在时，附上文档里最接近的几个候选 id（文本节点连文本内容一起给）。
 *
 * ## 为什么需要这段提示
 *
 * 模型是**按命名规律猜 id** 的：它想改「用户 ID」那个标签，真实 id 是
 * `text:user-detail-basic-user-id`，它自己编出 `text:user-detail-basic-user-id-label`
 * ——多一个后缀，节点不存在。光是「does not exist」它没法收敛，只能再猜一次，
 * 实测连猜三次都错（同一页改了三次还在错同一个 id），整页计划因此作废。
 *
 * 把候选直接摆出来，模型一次就能改对；文本内容一起给，是因为模型本来就是靠
 * 「这个标签写的是用户 ID」来认节点的，光给 id 它还是对不上号。
 */
function suggestNodeHint(document: DesignDocument, missingId: string): string {
  const wanted = tokenizeNodeId(missingId);
  if (!wanted.length) return "";
  const scored: Array<{ id: NodeId; score: number }> = [];
  for (const id of Object.keys(document.nodes)) {
    const score = countSharedTokens(tokenizeNodeId(id), wanted);
    if (score > 0) scored.push({ id, score });
  }
  if (!scored.length) return "";
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const parts = scored.slice(0, 3).map(item => {
    const node = document.nodes[item.id];
    if (!node) return item.id;
    const label = node.type === "text" ? `（文本"${truncateForHint(node.text, 24)}"）` : `（${node.type}）`;
    return `${item.id}${label}`;
  });
  return `。相近的节点：${parts.join("、")}`;
}

function tokenizeNodeId(id: string): string[] {
  return id.split(/[:\-_.\s]+/).filter(Boolean);
}

function countSharedTokens(candidate: string[], wanted: string[]): number {
  const wantedSet = new Set(wanted);
  let score = 0;
  for (const token of candidate) if (wantedSet.has(token)) score += 1;
  return score;
}

function truncateForHint(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function requireContainer(document: DesignDocument, id: string): { childIds: NodeId[] } {
  const container = document.nodes[id] ?? document.pages[id];
  // 父节点不存在有两种常见成因：模型把 id 拼错了，或者它引用了一个**还没创建**的父节点
  // （node.create 的 parentId 指向的容器必须先落地）。两种都摆出候选，让模型自己看出该用哪个。
  if (!container) {
    throw new CommandError(
      `Parent ${id} does not exist${suggestNodeHint(document, id)}` +
        "。引用已有节点时用摘要里原样的 id；新建容器时，父节点的那条 node.create 必须排在子节点前面。",
    );
  }
  // 布尔组也持有子节点（操作数），因此允许当作容器；文本/图片/矢量仍然不行。
  if ("type" in container && !["frame", "component", "instance", "boolean"].includes(container.type)) throw new CommandError(`Node ${id} cannot contain children`);
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
  const parentId = operands[0]!.parentId;
  if (operands.some(node => node.parentId !== parentId)) throw new CommandError("Boolean operands must share the same parent");
  const parent = requireContainer(document, parentId);

  // 操作数带旋转时，转出去的部分也要算进布尔组的盒子：形状得画在它真正在的地方。
  const bounds = operands.map(node => rotatedBoxBounds(node.layout, node.layout.rotation ?? 0));
  const minX = Math.min(...bounds.map(bound => bound.x));
  const minY = Math.min(...bounds.map(bound => bound.y));
  const maxX = Math.max(...bounds.map(bound => bound.x + bound.width));
  const maxY = Math.max(...bounds.map(bound => bound.y + bound.height));
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
  refreshBooleanAncestors(document, node.parentId === undefined ? undefined : String(node.parentId));
}

/**
 * 布尔组按操作数包围盒 hug。
 *
 * 操作数移动/缩放后重算：先把原点移到包围盒左上角（子节点坐标相应回退），再更新宽高，
 * 内容的世界坐标因此不变。手动改布尔组自己的尺寸不在这一步覆盖——下次操作数变化才重算。
 */
function refreshBoolean(document: DesignDocument, node: DesignNode): void {
  if (node.type !== "boolean") return;
  const children = node.childIds.map(id => document.nodes[id]).filter((child): child is DesignNode => Boolean(child));
  if (children.length < 2) return;
  // 操作数带旋转时，转出去的部分也要算进布尔组的盒子。
  const bounds = children.map(child => rotatedBoxBounds({
    x: node.layout.x + child.layout.x,
    y: node.layout.y + child.layout.y,
    width: child.layout.width,
    height: child.layout.height,
  }, child.layout.rotation ?? 0));
  const minX = Math.min(...bounds.map(bound => bound.x));
  const minY = Math.min(...bounds.map(bound => bound.y));
  const maxX = Math.max(...bounds.map(bound => bound.x + bound.width));
  const maxY = Math.max(...bounds.map(bound => bound.y + bound.height));
  const originX = node.layout.x;
  const originY = node.layout.y;
  // 先把原点移到包围盒左上角（子节点坐标相应回退），再更新宽高，
  // 内容的世界坐标因此不变。
  for (const child of children) {
    child.layout = { ...child.layout, x: child.layout.x + originX - minX, y: child.layout.y + originY - minY };
  }
  node.layout = {
    ...node.layout,
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** 从某个节点往上刷新所有布尔祖先；顺序由内到外，嵌套布尔组才能逐层收对。 */
function refreshBooleanAncestors(document: DesignDocument, nodeId: NodeId | undefined): void {
  const chain: DesignNode[] = [];
  const visited = new Set<NodeId>();
  let current: NodeId | undefined = nodeId;
  while (current && !visited.has(current)) {
    visited.add(current);
    const node = document.nodes[current];
    if (!node) break;
    if (node.type === "boolean") chain.push(node);
    current = node.parentId;
  }
  for (const node of chain) refreshBoolean(document, node);
}
