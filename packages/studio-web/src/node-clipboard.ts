import type { DesignCommand } from "@ufira/design-runtime";
import type { DesignDocument, DesignNode } from "@ufira/design-schema";

export interface NodeClipboard {
  roots: string[];
  nodes: Record<string, DesignNode>;
}

export interface PasteResult {
  commands: DesignCommand[];
  rootIds: string[];
}

export function copyNodeTrees(document: DesignDocument, selectedIds: string[]): NodeClipboard {
  const selected = new Set(selectedIds.filter(id => Boolean(document.nodes[id])));
  const roots = [...selected].filter(id => !hasSelectedAncestor(document, id, selected));
  const nodes: Record<string, DesignNode> = {};

  const visit = (id: string) => {
    const node = document.nodes[id];
    if (!node || nodes[id]) return;
    nodes[id] = structuredClone(node);
    node.childIds.forEach(visit);
  };
  roots.forEach(visit);
  return { roots, nodes };
}

export function pasteNodeTrees(
  clipboard: NodeClipboard,
  parentId: string,
  offset = 24,
  createId: (node: DesignNode) => string = node => `${node.type}:${crypto.randomUUID().slice(0, 8)}`,
): PasteResult {
  const idMap = new Map(Object.values(clipboard.nodes).map(node => [node.id, createId(node)]));
  const commands: DesignCommand[] = [];

  const visit = (sourceId: string, newParentId: string, isRoot: boolean) => {
    const source = clipboard.nodes[sourceId];
    if (!source) return;
    const id = idMap.get(sourceId)!;
    const node = structuredClone(source);
    node.id = id;
    node.parentId = newParentId;
    node.childIds = [];
    if (isRoot) {
      node.name = `${node.name} 副本`;
      node.layout = { ...node.layout, x: node.layout.x + offset, y: node.layout.y + offset };
    }
    commands.push({ type: "node.create", payload: { node } });
    source.childIds.forEach(childId => visit(childId, id, false));
  };

  clipboard.roots.forEach(rootId => visit(rootId, parentId, true));
  return { commands, rootIds: clipboard.roots.map(id => idMap.get(id)!).filter(Boolean) };
}

function hasSelectedAncestor(document: DesignDocument, id: string, selected: Set<string>): boolean {
  let parentId = document.nodes[id]?.parentId;
  while (parentId && document.nodes[parentId]) {
    if (selected.has(parentId)) return true;
    parentId = document.nodes[parentId]?.parentId;
  }
  return false;
}
