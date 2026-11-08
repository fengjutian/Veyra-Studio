import type { DesignDocument, DesignNode, InstanceNode } from "@ufira/design-schema";

export interface ComponentSummary {
  id: string;
  name: string;
  rootNodeId: string;
  instanceCount: number;
  /** 变体集 id；独立组件没有。 */
  variantSetId?: string;
  /** 变体取值的人话形式，例如 `state=hover`。 */
  variantLabel?: string;
}

/**
 * Lists the components of a document together with how often they are instanced.
 */
export function listComponents(document: DesignDocument): ComponentSummary[] {
  return Object.values(document.components).map(component => {
    const set = component.variantSetId ? document.componentSets?.[component.variantSetId] : undefined;
    return {
      id: component.id,
      name: component.name,
      rootNodeId: component.rootNodeId,
      instanceCount: Object.values(document.nodes).filter(node => node.type === "instance" && node.componentId === component.id).length,
      ...(component.variantSetId ? { variantSetId: component.variantSetId } : {}),
      ...(set && component.variant ? { variantLabel: formatVariant(set.properties, component.variant) } : {}),
    };
  });
}

export interface VariantOption {
  componentId: string;
  /** 例如 `state=hover`；UI 直接当选项文案。 */
  label: string;
  active: boolean;
}

/** `state=hover · size=lg`：属性顺序跟集合声明一致，保证不同组件的文案可比较。 */
export function formatVariant(properties: string[], variant: Record<string, string>): string {
  return properties.map(property => `${property}=${variant[property] ?? ""}`).join(" · ");
}

/**
 * 同一变体集里的全部成员，用于实例的变体切换下拉框。
 *
 * 返回空数组表示「这个组件没有变体」或「集合只有一个成员」——两种情况都没有切换语义，
 * UI 据此不渲染选择器。
 */
export function variantOptions(document: DesignDocument, componentId: string): VariantOption[] {
  const component = document.components[componentId];
  const setId = component?.variantSetId;
  if (!setId) return [];
  const set = document.componentSets?.[setId];
  if (!set) return [];
  const options = Object.values(document.components)
    .filter(candidate => candidate.variantSetId === setId && candidate.variant)
    .map(candidate => ({
      componentId: candidate.id,
      label: formatVariant(set.properties, candidate.variant ?? {}),
      active: candidate.id === componentId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return options.length > 1 ? options : [];
}

/**
 * Creates the instance node for a component instantiation.
 *
 * The id is derived from the component and a caller supplied suffix so the same
 * instance can be recreated deterministically.
 */
export function makeInstanceNode(
  componentId: string,
  parentId: string,
  options: { id: string; name: string; x: number; y: number; width: number; height: number },
): InstanceNode {
  return {
    id: options.id,
    type: "instance",
    name: options.name,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { mode: "absolute", x: options.x, y: options.y, width: options.width, height: options.height, widthMode: "fixed", heightMode: "fixed" },
    appearance: { opacity: 1 },
    componentId,
    overrides: {},
  };
}

/**
 * Finds the first text node inside a component so an instance can override it.
 */
export function findFirstTextNode(document: DesignDocument, rootNodeId: string): string | undefined {
  const root = document.nodes[rootNodeId];
  if (!root) return undefined;
  if (root.type === "text") return root.id;
  for (const childId of root.childIds) {
    const found = findFirstTextNode(document, childId);
    if (found) return found;
  }
  return undefined;
}
