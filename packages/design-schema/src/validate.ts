import { designDocumentSchema } from "./schema";
import { fontKey, isFontMimeType } from "./fonts";
import type { DesignDocument, NodeId } from "./types";

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
    if (node.childIds.length && node.type !== "frame" && node.type !== "component" && node.type !== "instance") issues.push(`node ${nodeId} of type ${node.type} cannot contain children`);
    for (const childId of node.childIds) {
      claim(childId, `node ${nodeId}`);
      const child = document.nodes[childId];
      if (!child) issues.push(`node ${nodeId} references missing child ${childId}`);
      else if (child.parentId !== nodeId) issues.push(`child ${childId} parentId does not match node ${nodeId}`);
    }
    if (node.slot && node.type !== "frame" && node.type !== "component") issues.push(`node ${nodeId} of type ${node.type} cannot be a slot`);
    if (node.type === "image" && !document.assets[node.assetId]) issues.push(`image ${nodeId} references missing asset ${node.assetId}`);
    if (node.type === "instance" && !document.components[node.componentId]) issues.push(`instance ${nodeId} references missing component ${node.componentId}`);
    for (const [property, tokenName] of Object.entries(node.bindings ?? {})) {
      const token = document.tokens[tokenName];
      if (!token) issues.push(`node ${nodeId} ${property} binding references missing token ${tokenName}`);
      else if (!bindingAccepts(property, token.type)) issues.push(`node ${nodeId} ${property} binding cannot use ${token.type} token ${tokenName}`);
    }
  }

  for (const nodeId of Object.keys(document.nodes)) {
    if (!claimed.has(nodeId)) issues.push(`node ${nodeId} is orphaned`);
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
  if (property === "typography") return tokenType === "string";
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
