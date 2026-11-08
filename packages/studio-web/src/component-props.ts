import type { ComponentProperty, ComponentPropertyField, DesignDocument, DesignNode, InstanceNode } from "@ufira/design-schema";
import { componentProperties, propertyTargets, resolvePropertyValue } from "@ufira/design-schema";

/**
 * 组件属性（component props）的展示层数据。
 *
 * 纯函数：不碰 React，方便直接测。规格见 `docs/component-properties.md`。
 */

/** 实例面板里一个属性的行。 */
export interface InstancePropertyView {
  propertyId: string;
  name: string;
  type: "text" | "boolean";
  /** 有效值：显式值优先，没有就用组件默认值。 */
  value: string | boolean;
  /** 实例是否显式改过这个属性。 */
  explicit: boolean;
  /** 绑定目标的节点名（人话）；没有绑定时为空。 */
  targetName?: string;
}

/** 组件面板里一个属性的行。 */
export interface ComponentPropertyView {
  propertyId: string;
  name: string;
  type: "text" | "boolean";
  defaultValue: string | boolean;
  /** 绑定在哪个节点、哪个字段上；没有绑定时为空。 */
  targetNodeId?: string;
  targetName?: string;
  field?: ComponentPropertyField;
}

/**
 * 实例的属性列表。
 *
 * 顺序按组件声明的属性顺序——声明顺序就是设计者给出的语义顺序，
 * 按 id 排序会让「标题 / 副标题 / 按钮文字」变成随机顺序。
 */
export function instancePropertyViews(document: DesignDocument, instance: InstanceNode): InstancePropertyView[] {
  const definition = document.components[instance.componentId];
  if (!definition) return [];
  const targets = propertyTargets(document, instance.componentId);
  return componentProperties(document, instance.componentId).map(property => {
    const target = targets.find(entry => entry.property.id === property.id);
    return {
      propertyId: property.id,
      name: property.name,
      type: property.type,
      value: resolvePropertyValue(document, instance, property),
      explicit: instance.propValues?.[property.id] !== undefined,
      ...(target ? { targetName: document.nodes[target.sourceNodeId]?.name ?? target.sourceNodeId } : {}),
    };
  });
}

/** 组件的属性列表（含绑定目标）。 */
export function componentPropertyViews(document: DesignDocument, componentId: string): ComponentPropertyView[] {
  const targets = propertyTargets(document, componentId);
  return componentProperties(document, componentId).map(property => {
    const target = targets.find(entry => entry.property.id === property.id);
    return {
      propertyId: property.id,
      name: property.name,
      type: property.type,
      defaultValue: property.defaultValue,
      ...(target
        ? {
            targetNodeId: target.sourceNodeId,
            targetName: document.nodes[target.sourceNodeId]?.name ?? target.sourceNodeId,
            field: target.field,
          }
        : {}),
    };
  });
}

/**
 * 节点是否已经被某个属性绑定在指定字段上。
 *
 * 实例面板用它把「被属性接管的文本节点」从覆盖列表里去掉——
 * 同一处内容两处都能改，用户会以为有一个改动没生效。
 */
export function nodeBoundByProperty(
  document: DesignDocument,
  componentId: string,
  sourceNodeId: string,
  field: ComponentPropertyField,
): string | undefined {
  return propertyTargets(document, componentId).find(
    target => target.sourceNodeId === sourceNodeId && target.field === field,
  )?.property.id;
}

/**
 * 组件里可以被暴露成属性的节点：组件根子树内部的文本节点与形状。
 *
 * 组件根本身排除——它只是容器，把它绑成属性没有意义。
 */
export function exposableNodes(document: DesignDocument, componentId: string): DesignNode[] {
  const definition = document.components[componentId];
  if (!definition) return [];
  const found: DesignNode[] = [];
  const visited = new Set<string>();
  const walk = (nodeId: string): void => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = document.nodes[nodeId];
    if (!node) return;
    found.push(node);
    for (const childId of node.childIds) walk(childId);
  };
  walk(definition.rootNodeId);
  return found.filter(node => node.id !== definition.rootNodeId);
}

/** 新属性的默认 id：带前缀便于在文档里一眼看出。 */
export function newPropertyId(prefix = "prop"): string {
  return `${prefix}:${Math.random().toString(36).slice(2, 10)}`;
}

/** 布尔属性在界面上的开关标签。 */
export function booleanPropertyLabel(property: ComponentProperty): string {
  return property.type === "boolean" ? `${property.name}（开/关）` : property.name;
}
