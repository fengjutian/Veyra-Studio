import type { FontStyle, NodeId, ParagraphStyleRun, TextNode, TextRun } from "@ufira/design-schema";

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
  /** 段落样式区间；缩进会吃掉可用宽度，宿主测量器必须一起算。 */
  paragraphStyles?: readonly ParagraphStyleRun[];
  /** 盒内对齐：段落缩进只对左对齐生效，居中/右对齐时要把它扣掉。 */
  align?: "left" | "center" | "right";
  availableWidth?: number;
}

export interface TextMeasurer {
  measure(node: TextNode, availableWidth?: number): Size;
}

export interface LayoutWarning {
  nodeId: NodeId;
  /**
   * - `fill-in-hug`：hug 容器里的 fill 子节点没有确定尺寸；
   * - `overflow`：子节点/轨道超出容器；
   * - `text-overflow`：文本需要的行数超过盒高；
   * - `grid-auto-repeat`：自动重复轨道需要确定的容器尺寸（hug 容器退化成一条）。
   */
  code: "fill-in-hug" | "overflow" | "text-overflow" | "grid-auto-repeat";
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
