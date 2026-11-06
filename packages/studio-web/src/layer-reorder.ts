import type { DesignDocument } from "@ufira/design-schema";

export type DropPosition = "before" | "after" | "inside";

export interface ReparentPlan {
  parentId: string;
  index: number;
}

/**
 * Computes where a dragged node must land to satisfy a drop.
 *
 * `before` and `after` keep the node a sibling of the target; `inside` reparents
 * it into the target as its last child. The resulting index accounts for the
 * removal of the dragged node from its previous position, so the caller can
 * apply it directly to the target's child list.
 */
export function planReparent(
  document: DesignDocument,
  draggedId: string,
  targetId: string,
  position: DropPosition,
): ReparentPlan | undefined {
  const dragged = document.nodes[draggedId];
  const target = document.nodes[targetId];
  if (!dragged || !target) return undefined;
  if (draggedId === targetId) return undefined;
  if (isDescendant(document, draggedId, targetId)) return undefined;

  if (position === "inside") {
    if (!canContainChildren(target)) return undefined;
    return { parentId: targetId, index: target.childIds.length };
  }

  const parentId = target.parentId;
  const siblings = childIdsOf(document, parentId);
  const targetIndex = siblings.indexOf(targetId);
  if (targetIndex < 0) return undefined;

  let index = position === "before" ? targetIndex : targetIndex + 1;
  // Removing the dragged node from the same list shifts later indices left.
  const draggedIndex = siblings.indexOf(draggedId);
  if (draggedIndex >= 0 && draggedIndex < index) index -= 1;

  return { parentId, index: Math.max(0, index) };
}

/**
 * Returns the child list of a container, or an empty list for unknown containers.
 */
export function childIdsOf(document: DesignDocument, parentId: string): string[] {
  const page = document.pages[parentId];
  if (page) return page.childIds;
  const node = document.nodes[parentId];
  return node?.childIds ?? [];
}

export function canContainChildren(node: { type: string }): boolean {
  return node.type === "frame" || node.type === "component";
}

export function isDescendant(document: DesignDocument, ancestorId: string, candidateId: string): boolean {
  const ancestor = document.nodes[ancestorId];
  if (!ancestor) return false;
  return ancestor.childIds.some(childId => childId === candidateId || isDescendant(document, childId, candidateId));
}
