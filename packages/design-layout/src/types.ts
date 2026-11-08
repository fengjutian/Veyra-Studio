import type { FontStyle, NodeId, TextNode, TextRun } from "@ufira/design-schema";

export interface Size {
  width: number;
  height: number;
}

export interface ComputedBox extends Size {
  x: number;
  y: number;
}

export interface TextMeasurementRequest {
  text: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontStyle: FontStyle;
  letterSpacing: number;
  /** 段内样式覆盖；宿主测量器要按区间换字体量宽，否则 hug 高度会算错。 */
  runs?: readonly TextRun[];
  availableWidth?: number;
}

export interface TextMeasurer {
  measure(node: TextNode, availableWidth?: number): Size;
}

export interface LayoutWarning {
  nodeId: NodeId;
  code: "fill-in-hug" | "overflow" | "text-overflow";
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
