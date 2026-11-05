import type { NodeId, TextNode } from "@ufira/design-schema";

export interface Size {
  width: number;
  height: number;
}

export interface ComputedBox extends Size {
  x: number;
  y: number;
}

export interface TextMeasurer {
  measure(node: TextNode, availableWidth?: number): Size;
}

export interface LayoutWarning {
  nodeId: NodeId;
  code: "fill-in-hug" | "overflow";
  message: string;
}

export interface LayoutResult {
  pageId: string;
  viewport: Size;
  boxes: Record<NodeId, ComputedBox>;
  warnings: LayoutWarning[];
}

export interface LayoutOptions {
  viewport: Size;
  textMeasurer?: TextMeasurer;
}
