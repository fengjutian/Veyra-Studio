import type {
  ComponentProperty,
  ComponentPropertyBindings,
  DesignDocument,
  DesignNode,
  InstanceNode,
  NodeId,
} from "./types";

/**
 * 组件属性（component props）的读取与解析。
 *
 * 属性声明在组件定义上，绑定在被绑定的节点上（方向是「字段 → 属性 id」），
 * 实例显式改过的值存在实例的 `propValues` 里。规格见
 * `docs/component-properties.md`。
 */

/** 属性可以驱动的节点字段。 */
export type ComponentPropertyField = "text" | "visible";

/** 一条绑定：某个源节点的某个字段由哪个属性驱动。 */
export interface PropertyBinding {
  propertyId: string;
  /** 组件定义里的源节点 id。 */
  sourceNodeId: NodeId;
  field: ComponentPropertyField;
}

/** 组件声明的属性；没有声明时返回空数组。 */
export function componentProperties(document: DesignDocument, componentId: string): ComponentProperty[] {
  return document.components[componentId]?.properties ?? [];
}

/** 按 id 找属性；找不到返回 undefined。 */
export function findComponentProperty(document: DesignDocument, componentId: string, propertyId: string): ComponentProperty | undefined {
  return componentProperties(document, componentId).find(property => property.id === propertyId);
}

/**
 * 列出组件根子树里所有的属性绑定。
 *
 * 只扫组件**定义**的子树，不扫实例副本——实例副本在物化时会被剥掉绑定
 * （绑定是组件定义的属性，不是副本的）。
 */
export function propertyBindings(document: DesignDocument, componentId: string): PropertyBinding[] {
  const definition = document.components[componentId];
  if (!definition) return [];
  const bindings: PropertyBinding[] = [];
  const visited = new Set<NodeId>();
  const walk = (nodeId: NodeId): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node) return;
    const nodeBindings = node.componentPropertyBindings;
    if (nodeBindings) {
      if (nodeBindings.text) bindings.push({ propertyId: nodeBindings.text, sourceNodeId: nodeId, field: "text" });
      if (nodeBindings.visible) bindings.push({ propertyId: nodeBindings.visible, sourceNodeId: nodeId, field: "visible" });
    }
    for (const childId of node.childIds) walk(childId);
  };
  walk(definition.rootNodeId);
  return bindings;
}

/** 某个属性在组件里的全部绑定。 */
export function propertyBindingsFor(document: DesignDocument, componentId: string, propertyId: string): PropertyBinding[] {
  return propertyBindings(document, componentId).filter(binding => binding.propertyId === propertyId);
}

/** 一个属性的绑定目标：驱动哪个源节点的哪个字段。 */
export interface PropertyTarget {
  property: ComponentProperty;
  /** 组件定义里的源节点 id。 */
  sourceNodeId: NodeId;
  field: ComponentPropertyField;
}

/**
 * 组件里所有「属性 → 源节点字段」的绑定。
 *
 * 只列出**属性确实声明过**的绑定：绑定指向的属性被删掉后，那条绑定是残留，
 * 应用时不应当把它算进去。
 */
export function propertyTargets(document: DesignDocument, componentId: string): PropertyTarget[] {
  const properties = new Map(componentProperties(document, componentId).map(property => [property.id, property]));
  const targets: PropertyTarget[] = [];
  for (const binding of propertyBindings(document, componentId)) {
    const property = properties.get(binding.propertyId);
    if (!property) continue;
    targets.push({ property, sourceNodeId: binding.sourceNodeId, field: binding.field });
  }
  return targets;
}

/**
 * 节点是否在某棵子树的**内部**（不含子树根本身）。
 *
 * 「内部」是绑定的硬要求：组件根本身只是容器，把它绑成属性没有意义。
 */
export function isInsideSubtree(document: DesignDocument, nodeId: NodeId, rootId: NodeId): boolean {
  if (nodeId === rootId) return false;
  return isWithinSubtree(document, nodeId, rootId);
}

/** 节点是否在子树内部（含根本身）。 */
export function isWithinSubtree(document: DesignDocument, nodeId: NodeId, rootId: NodeId): boolean {
  if (nodeId === rootId) return true;
  let current: NodeId | undefined = document.nodes[nodeId]?.parentId;
  const visited = new Set<NodeId>([nodeId]);
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    if (current === rootId) return true;
    current = document.nodes[current]?.parentId;
  }
  return false;
}

/**
 * 节点是否在某个实例的子树里（祖先链上有实例节点，节点自己不算）。
 *
 * 用来区分「组件定义里的节点」和「实例副本」：副本上的绑定没有意义，
 * 物化时会剥掉。
 */
export function isInsideInstance(document: DesignDocument, nodeId: NodeId): boolean {
  let current: NodeId | undefined = document.nodes[nodeId]?.parentId;
  const visited = new Set<NodeId>([nodeId]);
  while (current) {
    if (visited.has(current)) return false;
    visited.add(current);
    const node: DesignNode | undefined = document.nodes[current];
    if (!node) return false;
    if (node.type === "instance") return true;
    current = node.parentId;
  }
  return false;
}

/**
 * 实例上某个属性的**有效值**：显式值优先，没显式改过就用组件默认值。
 */
export function resolvePropertyValue(
  document: DesignDocument,
  instance: InstanceNode,
  property: ComponentProperty,
): string | boolean {
  const explicit = instance.propValues?.[property.id];
  return explicit === undefined ? property.defaultValue : explicit;
}

/** 实例显式改过的属性 id 集合。 */
export function explicitPropertyIds(instance: InstanceNode): string[] {
  return Object.keys(instance.propValues ?? {});
}

/**
 * 把组件的某个属性绑到节点字段上，返回新的绑定表。
 *
 * 同一个字段只能绑一个属性，重复绑定是覆盖（返回新对象，不改原表）。
 */
export function withPropertyBinding(
  bindings: ComponentPropertyBindings | undefined,
  field: ComponentPropertyField,
  propertyId: string,
): ComponentPropertyBindings {
  return { ...(bindings ?? {}), [field]: propertyId };
}
