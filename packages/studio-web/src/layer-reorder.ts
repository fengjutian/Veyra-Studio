import type { DesignDocument } from "@ufira/design-schema";

export type DropPosition = "before" | "after" | "inside";

export interface ReparentPlan {
  parentId: string;
  index: number;
}

/**
 * Computes where a dragged node must land to satisfy a drop.
 *
 * `before` and `after` keep the node a sibling of the target and take the
 * target's slot — the same semantics as moving an item in a list. `inside`
 * reparents it into the target as its last child.
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
  const from = siblings.indexOf(draggedId);
  const to = siblings.indexOf(targetId);
  if (from < 0 || to < 0) return undefined;

  // Moving an item to another item's slot: remove it, then insert at the slot
  // the target occupied. This keeps the relative order of the other siblings.
  const reordered = arrayMove(siblings, from, to);
  return { parentId, index: reordered.indexOf(draggedId) };
}

/**
 * Moves an item inside an array, the way list reordering is expected to work.
 */
export function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const result = [...items];
  const [removed] = result.splice(from, 1);
  result.splice(to, 0, removed);
  return result;
}

/**
 * Decides the drop position from where the pointer landed on the target.
 *
 * The top and bottom quarters reorder as siblings; the middle half nests the
 * node inside the target when the target can own children.
 */
export function resolveDropPosition(
  target: { type: string },
  pointerOffsetY: number | undefined,
  targetHeight: number | undefined,
): DropPosition {
  if (!canContainChildren(target)) return "after";
  if (pointerOffsetY === undefined || targetHeight === undefined || targetHeight <= 0) return "inside";
  const ratio = pointerOffsetY / targetHeight;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
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
  return node.type === "frame" || node.type === "component" || node.type === "instance";
}

export function isDescendant(document: DesignDocument, ancestorId: string, candidateId: string): boolean {
  const ancestor = document.nodes[ancestorId];
  if (!ancestor) return false;
  return ancestor.childIds.some(childId => childId === candidateId || isDescendant(document, childId, candidateId));
}
