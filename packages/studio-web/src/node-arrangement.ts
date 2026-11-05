import type { DesignNode } from "@ufira/design-schema";

export type Arrangement = "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "distributeX" | "distributeY";
export interface LayoutChange { id: string; layout: DesignNode["layout"] }

export function arrangeNodes(nodes: DesignNode[], arrangement: Arrangement): LayoutChange[] {
  if (nodes.length < 2) return [];
  if (arrangement === "distributeX" || arrangement === "distributeY") {
    return distribute(nodes, arrangement === "distributeX" ? "x" : "y");
  }

  const left = Math.min(...nodes.map(node => node.layout.x));
  const top = Math.min(...nodes.map(node => node.layout.y));
  const right = Math.max(...nodes.map(node => node.layout.x + node.layout.width));
  const bottom = Math.max(...nodes.map(node => node.layout.y + node.layout.height));

  return nodes.map(node => {
    const layout = { ...node.layout };
    if (arrangement === "left") layout.x = left;
    if (arrangement === "centerX") layout.x = (left + right - layout.width) / 2;
    if (arrangement === "right") layout.x = right - layout.width;
    if (arrangement === "top") layout.y = top;
    if (arrangement === "centerY") layout.y = (top + bottom - layout.height) / 2;
    if (arrangement === "bottom") layout.y = bottom - layout.height;
    return { id: node.id, layout };
  });
}

function distribute(nodes: DesignNode[], axis: "x" | "y"): LayoutChange[] {
  if (nodes.length < 3) return [];
  const size = axis === "x" ? "width" : "height";
  const sorted = [...nodes].sort((a, b) => a.layout[axis] - b.layout[axis]);
  const start = sorted[0]!.layout[axis];
  const end = sorted.at(-1)!.layout[axis] + sorted.at(-1)!.layout[size];
  const occupied = sorted.reduce((sum, node) => sum + node.layout[size], 0);
  const gap = (end - start - occupied) / (sorted.length - 1);
  let cursor = start;
  return sorted.map(node => {
    const layout = { ...node.layout, [axis]: cursor };
    cursor += node.layout[size] + gap;
    return { id: node.id, layout };
  });
}
