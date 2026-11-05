import { useEffect, useMemo, useState } from "react";
import Moveable from "react-moveable";
import Selecto from "react-selecto";
import type { DesignNode } from "@ufira/design-schema";

export interface CanvasInteractionLayerProps {
  canvas: HTMLElement | null;
  nodes: DesignNode[];
  selectedIds: string[];
  disabled?: boolean;
  onSelect(ids: string[]): void;
  onCommit(changes: Array<{ id: string; layout: DesignNode["layout"] }>): void;
}

export function CanvasInteractionLayer({ canvas, nodes, selectedIds, disabled, onSelect, onCommit }: CanvasInteractionLayerProps) {
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const selectedNodes = selectedIds.map(id => nodes.find(node => node.id === id)).filter((node): node is DesignNode => Boolean(node));
  const guidelines = useMemo(() => canvas ? [...canvas.querySelectorAll<HTMLElement>("[data-node-id]")].filter(element => !targets.includes(element)) : [], [canvas, nodes, targets]);

  useEffect(() => {
    setTargets(canvas ? selectedIds.map(id => canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`)).filter((element): element is HTMLElement => Boolean(element)) : []);
  }, [canvas, nodes, selectedIds]);

  if (!canvas) return null;
  return <>
    <Selecto
      container={canvas}
      dragContainer={canvas}
      selectableTargets={["[data-node-id]"]}
      selectByClick
      selectFromInside={false}
      toggleContinueSelect={["shift"]}
      hitRate={20}
      onSelect={event => onSelect(event.selected.map(element => (element as HTMLElement).dataset.nodeId).filter((id): id is string => Boolean(id)))}
    />
    <Moveable
      target={targets.length === 1 ? targets[0] : targets}
      container={canvas}
      draggable={!disabled}
      resizable={!disabled}
      snappable
      snapThreshold={6}
      elementGuidelines={guidelines}
      verticalGuidelines={[0, canvas.clientWidth / 2, canvas.clientWidth]}
      horizontalGuidelines={[0, canvas.clientHeight / 2, canvas.clientHeight]}
      bounds={{ left: 0, top: 0, right: canvas.clientWidth, bottom: canvas.clientHeight, position: "css" }}
      onDrag={event => {
        if (selectedNodes.length !== 1) return;
        event.target.style.left = `${Math.round(event.left)}px`;
        event.target.style.top = `${Math.round(event.top)}px`;
      }}
      onDragEnd={event => {
        if (selectedNodes.length !== 1) return;
        const selectedNode = selectedNodes[0];
        if (!selectedNode || !event.target) return;
        const x = parsePixels(event.target.style.left, selectedNode.layout.x), y = parsePixels(event.target.style.top, selectedNode.layout.y);
        if (x !== selectedNode.layout.x || y !== selectedNode.layout.y) onCommit([{ id: selectedNode.id, layout: { ...selectedNode.layout, x, y } }]);
      }}
      onDragGroup={event => event.events.forEach(child => { child.target.style.left = `${Math.round(child.left)}px`; child.target.style.top = `${Math.round(child.top)}px`; })}
      onDragGroupEnd={event => onCommit(readLayouts(event.events.map(child => child.target), selectedNodes, false))}
      onResize={event => {
        if (selectedNodes.length !== 1) return;
        event.target.style.width = `${Math.round(event.width)}px`;
        event.target.style.height = `${Math.round(event.height)}px`;
        event.target.style.left = `${Math.round(event.drag.left)}px`;
        event.target.style.top = `${Math.round(event.drag.top)}px`;
      }}
      onResizeEnd={event => {
        if (selectedNodes.length !== 1) return;
        const selectedNode = selectedNodes[0];
        if (!selectedNode || !event.target) return;
        const layout = {
          ...selectedNode.layout,
          x: parsePixels(event.target.style.left, selectedNode.layout.x),
          y: parsePixels(event.target.style.top, selectedNode.layout.y),
          width: Math.max(1, parsePixels(event.target.style.width, selectedNode.layout.width)),
          height: Math.max(1, parsePixels(event.target.style.height, selectedNode.layout.height)),
        };
        if (layout.x !== selectedNode.layout.x || layout.y !== selectedNode.layout.y || layout.width !== selectedNode.layout.width || layout.height !== selectedNode.layout.height) onCommit([{ id: selectedNode.id, layout }]);
      }}
      onResizeGroup={event => event.events.forEach(child => {
        child.target.style.width = `${Math.round(child.width)}px`; child.target.style.height = `${Math.round(child.height)}px`;
        child.target.style.left = `${Math.round(child.drag.left)}px`; child.target.style.top = `${Math.round(child.drag.top)}px`;
      })}
      onResizeGroupEnd={event => onCommit(readLayouts(event.events.map(child => child.target), selectedNodes, true))}
    />
  </>;
}

export default CanvasInteractionLayer;

function parsePixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function readLayouts(elements: Array<HTMLElement | SVGElement>, nodes: DesignNode[], includeSize: boolean): Array<{ id: string; layout: DesignNode["layout"] }> {
  return elements.flatMap(element => {
    if (!(element instanceof HTMLElement)) return [];
    const id = element.dataset.nodeId, node = nodes.find(candidate => candidate.id === id);
    if (!id || !node) return [];
    const layout = { ...node.layout, x: parsePixels(element.style.left, node.layout.x), y: parsePixels(element.style.top, node.layout.y) };
    if (includeSize) {
      layout.width = Math.max(1, parsePixels(element.style.width, node.layout.width));
      layout.height = Math.max(1, parsePixels(element.style.height, node.layout.height));
    }
    const changed = layout.x !== node.layout.x || layout.y !== node.layout.y || layout.width !== node.layout.width || layout.height !== node.layout.height;
    return changed ? [{ id, layout }] : [];
  });
}
