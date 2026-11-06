import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { arrayMove, resolveDropPosition } from "./layer-reorder";
import type { DesignDocument, DesignNode } from "@ufira/design-schema";

export interface LayerTreeProps {
  document: DesignDocument;
  rootIds: string[];
  selectedIds: string[];
  onSelect(id: string, event: { shiftKey: boolean }): void;
  onReorder(draggedId: string, targetId: string, position: "before" | "after" | "inside"): void;
}

interface FlatLayer {
  id: string;
  depth: number;
  hasChildren: boolean;
}

/**
 * Flattens the node tree into an ordered list for rendering and sorting.
 * Collapsed parents hide their descendants but keep their own position.
 */
export function flattenLayers(document: DesignDocument, rootIds: string[], collapsed: ReadonlySet<string>): FlatLayer[] {
  const rows: FlatLayer[] = [];
  const visit = (id: string, depth: number) => {
    const node = document.nodes[id];
    if (!node) return;
    rows.push({ id, depth, hasChildren: node.childIds.length > 0 });
    if (collapsed.has(id)) return;
    for (const childId of node.childIds) visit(childId, depth + 1);
  };
  for (const rootId of rootIds) visit(rootId, 0);
  return rows;
}

/**
 * Builds the nesting order used by dnd-kit. Every node is sortable within its
 * own parent, so a drag can only reorder siblings.
 */
export function buildSortableGroups(document: DesignDocument, rootIds: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = { __root__: [...rootIds] };
  const visit = (id: string) => {
    const node = document.nodes[id];
    if (!node) return;
    if (node.childIds.length) groups[id] = [...node.childIds];
    for (const childId of node.childIds) visit(childId);
  };
  for (const rootId of rootIds) visit(rootId);
  return groups;
}

export function LayerTree({ document, rootIds, selectedIds, onSelect, onReorder }: LayerTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string>();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const rows = useMemo(() => flattenLayers(document, rootIds, collapsed), [document, rootIds, collapsed]);
  const groups = useMemo(() => buildSortableGroups(document, rootIds), [document, rootIds]);

  const toggle = (id: string) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));

  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(undefined);
    const { active, over } = event;
    if (!over) return;
    const draggedId = String(active.id);
    const targetId = String(over.id);
    if (draggedId === targetId) return;
    const target = document.nodes[targetId];
    if (!target) return;

    // The pointer position inside the target decides whether the node becomes a
    // sibling or is nested into the target.
    const overRect = over.rect;
    const pointerY = event.activatorEvent instanceof MouseEvent && overRect ? event.delta.y + overRect.top : undefined;
    const position = resolveDropPosition(target, pointerY, overRect?.height);
    onReorder(draggedId, targetId, position);
  };

  return (
    <div className="layer-tree">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDraggingId(undefined)}>
        <SortableContext items={rows.map(row => row.id)} strategy={verticalListSortingStrategy}>
          {rows.map(row => (
            <LayerRow
              key={row.id}
              document={document}
              row={row}
              collapsed={collapsed.has(row.id)}
              selected={selectedIds.includes(row.id)}
              onSelect={onSelect}
              onToggle={toggle}
            />
          ))}
        </SortableContext>
        <DragOverlay>{draggingId && document.nodes[draggingId] ? <div className="layer layer-drag-overlay">{document.nodes[draggingId].name}</div> : null}</DragOverlay>
      </DndContext>
    </div>
  );
}

function LayerRow({
  document,
  row,
  collapsed,
  selected,
  onSelect,
  onToggle,
}: {
  document: DesignDocument;
  row: FlatLayer;
  collapsed: boolean;
  selected: boolean;
  onSelect(id: string, event: { shiftKey: boolean }): void;
  onToggle(id: string): void;
}) {
  const node = document.nodes[row.id];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.id });
  if (!node) return null;

  return (
    <div
      ref={setNodeRef}
      className={`layer-row${isDragging ? " dragging" : ""}`}
      style={{ paddingLeft: 8 + row.depth * 14, transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <button
        className={`layer${selected ? " active" : ""}`}
        onClick={event => {
          if (event.shiftKey) onSelect(row.id, event);
          else onSelect(row.id, event);
        }}
      >
        <span
          className={`layer-twisty${row.hasChildren ? " has-children" : ""}`}
          role="button"
          tabIndex={row.hasChildren ? 0 : -1}
          aria-label={collapsed ? "展开图层" : "折叠图层"}
          onClick={event => {
            event.stopPropagation();
            if (row.hasChildren) onToggle(row.id);
          }}
          onKeyDown={event => {
            if (row.hasChildren && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault();
              event.stopPropagation();
              onToggle(row.id);
            }
          }}
        >
          {row.hasChildren ? (collapsed ? "▸" : "▾") : ""}
        </span>
        <span className={`layer-type layer-type-${node.type}`}>{typeGlyph(node)}</span>
        <span className="layer-name">{node.name}</span>
      </button>
    </div>
  );
}

function typeGlyph(node: DesignNode): string {
  switch (node.type) {
    case "text": return "T";
    case "image": return "▣";
    case "rectangle": return "▢";
    case "ellipse": return "◯";
    case "component": return "◈";
    case "instance": return "◇";
    case "vector": return "⌁";
    default: return "▣";
  }
}

function isDescendant(document: DesignDocument, ancestorId: string, candidateId: string): boolean {
  const ancestor = document.nodes[ancestorId];
  if (!ancestor) return false;
  return ancestor.childIds.some(childId => childId === candidateId || isDescendant(document, childId, candidateId));
}
