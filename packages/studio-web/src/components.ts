import type { DesignDocument, DesignNode, InstanceNode } from "@ufira/design-schema";

export interface ComponentSummary {
  id: string;
  name: string;
  rootNodeId: string;
  instanceCount: number;
}

/**
 * Lists the components of a document together with how often they are instanced.
 */
export function listComponents(document: DesignDocument): ComponentSummary[] {
  return Object.values(document.components).map(component => ({
    id: component.id,
    name: component.name,
    rootNodeId: component.rootNodeId,
    instanceCount: Object.values(document.nodes).filter(node => node.type === "instance" && node.componentId === component.id).length,
  }));
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
