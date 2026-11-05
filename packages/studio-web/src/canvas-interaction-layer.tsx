import { useEffect, useMemo, useState } from "react";
import Moveable from "react-moveable";
import Selecto from "react-selecto";
import type { DesignNode } from "@ufira/design-schema";

export interface CanvasInteractionLayerProps {
  canvas: HTMLElement | null;
  nodes: DesignNode[];
  selectedId?: string;
  disabled?: boolean;
  onSelect(id?: string): void;
  onCommit(id: string, layout: DesignNode["layout"]): void;
}

export function CanvasInteractionLayer({ canvas, nodes, selectedId, disabled, onSelect, onCommit }: CanvasInteractionLayerProps) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const selectedNode = selectedId ? nodes.find(node => node.id === selectedId) : undefined;
  const guidelines = useMemo(() => canvas ? [...canvas.querySelectorAll<HTMLElement>("[data-node-id]")].filter(element => element !== target) : [], [canvas, nodes, target]);

  useEffect(() => {
    setTarget(selectedId && canvas ? canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(selectedId)}"]`) : null);
  }, [canvas, nodes, selectedId]);

  if (!canvas) return null;
  return <>
    <Selecto
      container={canvas}
      dragContainer={canvas}
      selectableTargets={["[data-node-id]"]}
      selectByClick
      selectFromInside={false}
      hitRate={20}
      onSelect={event => onSelect(event.selected.at(-1)?.dataset.nodeId)}
    />
    <Moveable
      target={target}
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
        event.target.style.left = `${Math.round(event.left)}px`;
        event.target.style.top = `${Math.round(event.top)}px`;
      }}
      onDragEnd={event => {
        if (!selectedNode || !event.target) return;
        const x = parsePixels(event.target.style.left, selectedNode.layout.x);
        const y = parsePixels(event.target.style.top, selectedNode.layout.y);
        if (x !== selectedNode.layout.x || y !== selectedNode.layout.y) onCommit(selectedNode.id, { ...selectedNode.layout, x, y });
      }}
      onResize={event => {
        event.target.style.width = `${Math.round(event.width)}px`;
        event.target.style.height = `${Math.round(event.height)}px`;
        event.target.style.left = `${Math.round(event.drag.left)}px`;
        event.target.style.top = `${Math.round(event.drag.top)}px`;
      }}
      onResizeEnd={event => {
        if (!selectedNode || !event.target) return;
        const layout = {
          ...selectedNode.layout,
          x: parsePixels(event.target.style.left, selectedNode.layout.x),
          y: parsePixels(event.target.style.top, selectedNode.layout.y),
          width: Math.max(1, parsePixels(event.target.style.width, selectedNode.layout.width)),
          height: Math.max(1, parsePixels(event.target.style.height, selectedNode.layout.height)),
        };
        if (layout.x !== selectedNode.layout.x || layout.y !== selectedNode.layout.y || layout.width !== selectedNode.layout.width || layout.height !== selectedNode.layout.height) onCommit(selectedNode.id, layout);
      }}
    />
  </>;
}

export default CanvasInteractionLayer;

function parsePixels(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}
