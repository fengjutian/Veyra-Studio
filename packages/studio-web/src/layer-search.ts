import type { DesignDocument, DesignNode } from "@ufira/design-schema";

/**
 * Whether a node matches a layer search.
 *
 * The name is the primary signal; a text node also matches on its content, so
 * searching for a word that is written on the canvas finds the layer that holds it.
 */
export function layerMatches(node: DesignNode, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (node.name.toLowerCase().includes(needle)) return true;
  return node.type === "text" && node.text.toLowerCase().includes(needle);
}

/**
 * Computes the layers that stay visible for a search.
 *
 * A matching layer is visible, and so are its ancestors: hiding the parent would
 * hide the match as well. An empty query keeps the whole tree visible.
 */
export function visibleLayerIds(document: DesignDocument, rootIds: string[], query: string): Set<string> {
  const visible = new Set<string>();
  if (!query.trim()) {
    for (const rootId of rootIds) collectIds(document, rootId, visible);
    return visible;
  }
  const visit = (id: string): boolean => {
    const node = document.nodes[id];
    if (!node) return false;
    let matched = layerMatches(node, query);
    for (const childId of node.childIds) {
      if (visit(childId)) matched = true;
    }
    if (matched) visible.add(id);
    return matched;
  };
  for (const rootId of rootIds) visit(rootId);
  return visible;
}

function collectIds(document: DesignDocument, id: string, target: Set<string>): void {
  const node = document.nodes[id];
  if (!node) return;
  target.add(id);
  for (const childId of node.childIds) collectIds(document, childId, target);
}
