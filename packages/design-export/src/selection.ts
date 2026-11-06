import type { DesignDocument, NodeId } from "@ufira/design-schema";

/**
 * Computes the nodes an export has to render.
 *
 * Exporting a selection keeps two chains: the selected nodes with their own
 * children, and the ancestors that lead to them. The ancestors keep the geometry
 * intact — a node's `layout.x` is relative to its parent — while siblings that
 * are not part of the selection stay out of the export.
 */
export function exportNodeSet(document: DesignDocument, selectedIds: readonly NodeId[]): Set<NodeId> {
  const keep = new Set<NodeId>();
  const visited = new Set<NodeId>();
  const addSubtree = (id: NodeId): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = document.nodes[id];
    if (!node) return;
    keep.add(id);
    for (const childId of node.childIds) addSubtree(childId);
  };
  const addAncestors = (id: NodeId): void => {
    const node = document.nodes[id];
    if (!node) return;
    keep.add(id);
    // 页面是根，页面本身不作为节点渲染，链到这里就停。
    const parentId = node.parentId;
    if (document.nodes[parentId]) addAncestors(parentId);
  };
  for (const id of selectedIds) {
    addAncestors(id);
    addSubtree(id);
  }
  return keep;
}

/**
 * The nodes of a page that an export renders.
 *
 * Without a selection this is the whole page; with one it is the branches that
 * contain the selected nodes.
 */
export function exportRootIds(document: DesignDocument, pageId: string, keep?: Set<NodeId>): NodeId[] {
  const page = document.pages[pageId];
  if (!page) return [];
  return page.childIds.filter(id => !keep || keep.has(id));
}
