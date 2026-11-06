import type { DesignDocument, DesignNode } from "@ufira/design-schema";

export function flattenNodeTrees(document: DesignDocument, rootIds: string[]): DesignNode[] {
  const result: DesignNode[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    const node = document.nodes[id];
    if (!node) return;
    visited.add(id);
    result.push(node);
    node.childIds.forEach(visit);
  };
  rootIds.forEach(visit);
  return result;
}
