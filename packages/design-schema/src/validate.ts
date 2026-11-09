import { designDocumentSchema } from "./schema";
import { fontKey, isFontMimeType } from "./fonts";
import { supportsBooleanOperand } from "./boolean";
import { findOwningComponentId } from "./components";
import {
  BINDING_REQUIREMENTS,
  effectiveComponentProperties,
  isInsideSubtree,
  sharedPropertyTypeConflicts,
  validatePropertyValue,
  type BindingRequirement,
  type ComponentPropertyField,
} from "./component-properties";
import type { ComponentPropertyBindings, DesignDocument, NodeId } from "./types";

export class DocumentValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid design document:\n- ${issues.join("\n- ")}`);
    this.name = "DocumentValidationError";
  }
}

export function validateDocument(input: unknown): DesignDocument {
  const parsed = designDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new DocumentValidationError(parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`));
  }

  const document = parsed.data as DesignDocument;
  const issues: string[] = [];
  const pageIds = new Set(Object.keys(document.pages));

  if (new Set(document.pageOrder).size !== document.pageOrder.length) issues.push("pageOrder contains duplicate IDs");
  for (const pageId of document.pageOrder) if (!document.pages[pageId]) issues.push(`pageOrder references missing page ${pageId}`);
  for (const pageId of pageIds) if (!document.pageOrder.includes(pageId)) issues.push(`page ${pageId} is missing from pageOrder`);

  const claimed = new Map<NodeId, string>();
  const claim = (childId: NodeId, owner: string) => {
    const previous = claimed.get(childId);
    if (previous) issues.push(`node ${childId} is listed by both ${previous} and ${owner}`);
    else claimed.set(childId, owner);
  };

  for (const page of Object.values(document.pages)) {
    if (page.id !== findRecordKey(document.pages, page)) issues.push(`page record key does not match page.id ${page.id}`);
    if (new Set(page.childIds).size !== page.childIds.length) issues.push(`page ${page.id} contains duplicate child IDs`);
    for (const childId of page.childIds) {
      claim(childId, `page ${page.id}`);
      const child = document.nodes[childId];
      if (!child) issues.push(`page ${page.id} references missing node ${childId}`);
      else if (child.parentId !== page.id) issues.push(`node ${childId} parentId does not match page ${page.id}`);
    }
  }

  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.id !== nodeId) issues.push(`node record key ${nodeId} does not match node.id ${node.id}`);
    if (new Set(node.childIds).size !== node.childIds.length) issues.push(`node ${nodeId} contains duplicate child IDs`);
    if (node.childIds.length && node.type !== "frame" && node.type !== "component" && node.type !== "instance" && node.type !== "boolean") issues.push(`node ${nodeId} of type ${node.type} cannot contain children`);
    if (node.type === "boolean") {
      if (node.childIds.length < 2) issues.push(`boolean ${nodeId} needs at least two operands`);
      for (const childId of node.childIds) {
        const child = document.nodes[childId];
        if (child && !supportsBooleanOperand(child)) issues.push(`boolean ${nodeId} operand ${childId} of type ${child.type} is not a shape`);
      }
    }
    for (const childId of node.childIds) {
      claim(childId, `node ${nodeId}`);
      const child = document.nodes[childId];
      if (!child) issues.push(`node ${nodeId} references missing child ${childId}`);
      else if (child.parentId !== nodeId) issues.push(`child ${childId} parentId does not match node ${nodeId}`);
    }
    if (node.slot && node.type !== "frame" && node.type !== "component") issues.push(`node ${nodeId} of type ${node.type} cannot be a slot`);
    // 溢出模式只对容器有意义：形状没有「内容超出盒子」这回事。
    if (node.overflow !== undefined && node.type !== "frame" && node.type !== "component" && node.type !== "instance") {
      issues.push(`node ${nodeId} of type ${node.type} cannot have an overflow mode`);
    }
    if (node.type === "image" && !document.assets[node.assetId]) issues.push(`image ${nodeId} references missing asset ${node.assetId}`);
    if (node.type === "instance" && !document.components[node.componentId]) issues.push(`instance ${nodeId} references missing component ${node.componentId}`);
    for (const [property, tokenName] of Object.entries(node.bindings ?? {})) {
      const token = document.tokens[tokenName];
      if (!token) issues.push(`node ${nodeId} ${property} binding references missing token ${tokenName}`);
      else if (!bindingAccepts(property, token.type)) issues.push(`node ${nodeId} ${property} binding cannot use ${token.type} token ${tokenName}`);
      // 字体样式只对文本节点有意义；绑在容器上不会生效，早报比静默忽略好。
      else if (property === "typography" && node.type !== "text") issues.push(`node ${nodeId} typography binding requires a text node`);
    }
  }

  for (const nodeId of Object.keys(document.nodes)) {
    if (!claimed.has(nodeId)) issues.push(`node ${nodeId} is orphaned`);
  }

  // 组件属性绑定：绑定必须指向组件内部节点、属性必须存在且类型匹配。
  // 命令层也会拦，但导入一份手改过的 JSON 时只能靠这里。
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    const bindings = node.componentPropertyBindings;
    if (!bindings) continue;
    const ownerId = findOwningComponentId(document, nodeId);
    if (!ownerId) {
      issues.push(`node ${nodeId} has component property bindings but is not inside a component`);
      continue;
    }
    const owner = document.components[ownerId];
    // 有效声明 = 变体集共享声明 + 组件自己的声明。
    const properties = new Map(effectiveComponentProperties(document, ownerId).map(property => [property.id, property]));
    if (!isInsideSubtree(document, nodeId, owner!.rootNodeId)) {
      issues.push(`node ${nodeId} has component property bindings but is not inside component ${ownerId}`);
    }
    // 每个绑定字段的语义要求：字段 → 允许的属性类型 + 节点类型要求。
    for (const [field, requirement] of Object.entries(BINDING_REQUIREMENTS) as Array<[ComponentPropertyField, BindingRequirement]>) {
      const propertyId = bindings[field as keyof ComponentPropertyBindings];
      if (!propertyId) continue;
      const property = properties.get(propertyId);
      if (!property) {
        issues.push(`node ${nodeId} ${field} binding references unknown property ${propertyId} of component ${ownerId}`);
        continue;
      }
      if (property.type !== requirement.propertyType) {
        issues.push(`node ${nodeId} ${field} binding cannot use ${property.type} property ${property.id}`);
      }
      if (requirement.nodeType && node.type !== requirement.nodeType) {
        issues.push(`node ${nodeId} ${field} binding requires a ${requirement.nodeType} node`);
      }
    }
  }

  // 实例属性值：键必须是所属组件声明过的属性，值类型必须匹配。
  for (const [nodeId, node] of Object.entries(document.nodes)) {
    if (node.type !== "instance") continue;
    const properties = new Map(
      effectiveComponentProperties(document, node.componentId).map(property => [property.id, property]),
    );
    for (const [propertyId, value] of Object.entries(node.propValues ?? {})) {
      const property = properties.get(propertyId);
      if (!property) {
        issues.push(`instance ${nodeId} sets unknown component property ${propertyId}`);
        continue;
      }
      const problem = validatePropertyValue(property, value, { document });
      if (problem) issues.push(`instance ${nodeId} property ${propertyId} ${problem}`);
    }
  }

  // 变体集共享声明：组件不得改变共享属性的类型（那是破坏共享契约）。
  for (const [componentId] of Object.entries(document.components)) {
    for (const propertyId of sharedPropertyTypeConflicts(document, componentId)) {
      issues.push(`component ${componentId} changes the type of shared property ${propertyId}`);
    }
  }

  detectCycles(document, issues);

  for (const [componentId, component] of Object.entries(document.components)) {
    if (component.id !== componentId) issues.push(`component record key ${componentId} does not match component.id`);
    const root = document.nodes[component.rootNodeId];
    if (!root) issues.push(`component ${componentId} references missing root ${component.rootNodeId}`);
    else if (root.type !== "component") issues.push(`component ${componentId} root ${root.id} is not a component node`);
    if (component.variantSetId && !document.componentSets?.[component.variantSetId]) {
      issues.push(`component ${componentId} references missing variant set ${component.variantSetId}`);
    }
    if (component.variant && !component.variantSetId) {
      issues.push(`component ${componentId} has variant values but no variant set`);
    }
    // 组件属性：id 在组件内唯一，属性名不能为空。
    const propertyIds = new Set<string>();
    for (const property of component.properties ?? []) {
      if (propertyIds.has(property.id)) issues.push(`component ${componentId} has duplicate property ${property.id}`);
      propertyIds.add(property.id);
      if (!property.name.trim()) issues.push(`component ${componentId} property ${property.id} has an empty name`);
    }
  }

  // 变体集自洽性：属性名唯一、成员值覆盖全部属性且组内不重复。
  // 这些在命令层也会拦，但导入一份手改过的 JSON 时只能靠这里。
  for (const [setId, set] of Object.entries(document.componentSets ?? {})) {
    if (set.id !== setId) issues.push(`component set record key ${setId} does not match id ${set.id}`);
    if (new Set(set.properties).size !== set.properties.length) issues.push(`component set ${setId} has duplicate properties`);
    const seen = new Map<string, string>();
    for (const [componentId, component] of Object.entries(document.components)) {
      if (component.variantSetId !== setId) continue;
      if (!component.variant) {
        issues.push(`component ${componentId} belongs to set ${setId} but has no variant values`);
        continue;
      }
      for (const key of Object.keys(component.variant)) {
        if (!set.properties.includes(key)) issues.push(`component ${componentId} variant has unknown property ${key}`);
      }
      for (const property of set.properties) {
        if (!component.variant[property]) issues.push(`component ${componentId} variant is missing property ${property}`);
      }
      const signature = set.properties.map(property => component.variant?.[property] ?? "").join("\u0000");
      const duplicate = seen.get(signature);
      if (duplicate) issues.push(`components ${duplicate} and ${componentId} share the same variant values in set ${setId}`);
      else seen.set(signature, componentId);
    }
  }

  // 字体声明自洽性：同一族名+字重+字形只能有一条；引用的资源必须存在且确实是字体文件。
  const fontKeys = new Set<string>();
  for (const [index, font] of (document.fonts ?? []).entries()) {
    if (!font.family.trim()) issues.push(`fonts.${index}.family cannot be empty`);
    const key = fontKey(font);
    if (fontKeys.has(key)) issues.push(`fonts.${index} duplicates ${font.family} (${font.weight ?? 400}/${font.style ?? "normal"})`);
    fontKeys.add(key);
    if (!font.assetId) continue;
    const asset = document.assets[font.assetId];
    if (!asset) issues.push(`fonts.${index} references missing asset ${font.assetId}`);
    else if (!isFontMimeType(asset.mimeType)) issues.push(`fonts.${index} asset ${font.assetId} is ${asset.mimeType}, not a font`);
  }

  detectComponentCycles(document, issues);

  if (issues.length) throw new DocumentValidationError(issues);
  return document;
}

function bindingAccepts(property: string, tokenType: string): boolean {
  if (property === "fill" || property === "stroke") return tokenType === "color";
  if (property === "spacing" || property === "radius") return tokenType === "number";
  // 字体绑定只认 typography token：`string` 是早期的标量类型，没有渲染语义。
  if (property === "typography") return tokenType === "typography";
  return true;
}

function findRecordKey<T extends { id: string }>(records: Record<string, T>, value: T): string | undefined {
  return Object.entries(records).find(([, candidate]) => candidate === value)?.[0];
}

function detectCycles(document: DesignDocument, issues: string[]): void {
  const visiting = new Set<NodeId>();
  const visited = new Set<NodeId>();

  const visit = (nodeId: NodeId) => {
    if (visiting.has(nodeId)) {
      issues.push(`node tree contains a cycle at ${nodeId}`);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of document.nodes[nodeId]?.childIds ?? []) visit(childId);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const page of Object.values(document.pages)) for (const childId of page.childIds) visit(childId);
}

function detectComponentCycles(document: DesignDocument, issues: string[]): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const dependencies = (componentId: string): string[] => {
    const rootId = document.components[componentId]?.rootNodeId;
    if (!rootId) return [];
    const found = new Set<string>();
    const walk = (nodeId: NodeId) => {
      const node = document.nodes[nodeId];
      if (!node) return;
      if (node.type === "instance") found.add(node.componentId);
      for (const childId of node.childIds) walk(childId);
    };
    walk(rootId);
    return [...found];
  };

  const visit = (componentId: string) => {
    if (visiting.has(componentId)) {
      issues.push(`component graph contains a cycle at ${componentId}`);
      return;
    }
    if (visited.has(componentId)) return;
    visiting.add(componentId);
    for (const dependency of dependencies(componentId)) visit(dependency);
    visiting.delete(componentId);
    visited.add(componentId);
  };

  for (const componentId of Object.keys(document.components)) visit(componentId);
}

export function createDocument(id: string, name: string, pageId = "page:1"): DesignDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: 4,
    id,
    revision: 0,
    meta: { name, createdAt: now, updatedAt: now },
    pageOrder: [pageId],
    pages: { [pageId]: { id: pageId, name: "Page 1", childIds: [] } },
    nodes: {},
    components: {},
    tokens: {},
    assets: {},
  };
}
