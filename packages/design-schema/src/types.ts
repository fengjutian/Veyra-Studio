export type DocumentId = string;
export type PageId = string;
export type NodeId = string;
export type ComponentId = string;
export type AssetId = string;

export interface DocumentMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignPage {
  id: PageId;
  name: string;
  childIds: NodeId[];
}

export type SizeMode = "fixed" | "fill" | "hug";

export interface LayoutSpec {
  mode: "absolute" | "stack";
  direction?: "horizontal" | "vertical";
  x: number;
  y: number;
  width: number;
  height: number;
  widthMode: SizeMode;
  heightMode: SizeMode;
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  align?: "start" | "center" | "end" | "stretch";
}

export interface AppearanceSpec {
  opacity: number;
  fill?: string;
  stroke?: string;
  cornerRadius?: number;
}

export interface PropertyBindings {
  fill?: string;
  stroke?: string;
  typography?: string;
  spacing?: string;
  radius?: string;
}

export interface ExternalReference {
  provider: string;
  id: string;
}

export type NodeType =
  | "frame"
  | "text"
  | "image"
  | "rectangle"
  | "ellipse"
  | "vector"
  | "component"
  | "instance";

export interface BaseNode {
  id: NodeId;
  type: NodeType;
  name: string;
  parentId: NodeId | PageId;
  childIds: NodeId[];
  visible: boolean;
  locked: boolean;
  layout: LayoutSpec;
  appearance: AppearanceSpec;
  bindings?: PropertyBindings;
  externalRefs?: ExternalReference[];
}

export interface TextNode extends BaseNode {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

export interface ImageNode extends BaseNode {
  type: "image";
  assetId: AssetId;
  fit: "cover" | "contain" | "fill";
}

export interface InstanceNode extends BaseNode {
  type: "instance";
  componentId: ComponentId;
  overrides: Record<string, unknown>;
}

export interface GenericNode extends BaseNode {
  type: Exclude<NodeType, "text" | "image" | "instance">;
}

export type DesignNode = TextNode | ImageNode | InstanceNode | GenericNode;

export interface ComponentDefinition {
  id: ComponentId;
  name: string;
  rootNodeId: NodeId;
}

export interface TokenValue {
  type: "color" | "number" | "string";
  value: string | number;
}

export interface AssetMetadata {
  id: AssetId;
  hash: string;
  mimeType: string;
  byteLength: number;
  name?: string;
}

export interface DesignDocument {
  schemaVersion: 1;
  id: DocumentId;
  revision: number;
  meta: DocumentMeta;
  pageOrder: PageId[];
  pages: Record<PageId, DesignPage>;
  nodes: Record<NodeId, DesignNode>;
  components: Record<ComponentId, ComponentDefinition>;
  tokens: Record<string, TokenValue>;
  assets: Record<AssetId, AssetMetadata>;
}

export const defaultLayout = (): LayoutSpec => ({
  mode: "absolute",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  widthMode: "fixed",
  heightMode: "fixed",
});

export const defaultAppearance = (): AppearanceSpec => ({ opacity: 1 });
