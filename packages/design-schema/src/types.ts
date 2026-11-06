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
  /** 作为组件插槽的 frame：实例可以往这里填充自己的内容。 */
  slot?: boolean;
}

/** 文本在自身盒内的水平对齐方式。 */
export type TextAlign = "left" | "center" | "right";

/** 文本的字形倾斜方式。 */
export type FontStyle = "normal" | "italic";

/**
 * 文本样式的缺省值。
 *
 * 这四个字段在 `TextNode` 上都是可选的，旧文档不需要迁移；读取时统一用这里的
 * 默认值兜底，这样 schema、布局、导出和 UI 看到的语义一致。
 */
export const TEXT_DEFAULTS = {
  fontWeight: 400,
  fontStyle: "normal",
  textAlign: "left",
  letterSpacing: 0,
} as const satisfies { fontWeight: number; fontStyle: FontStyle; textAlign: TextAlign; letterSpacing: number };

export interface TextNode extends BaseNode {
  type: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** CSS 字重，100–900。缺省等同于 `TEXT_DEFAULTS.fontWeight`。 */
  fontWeight?: number;
  /** 斜体。缺省等同于 `TEXT_DEFAULTS.fontStyle`。 */
  fontStyle?: FontStyle;
  /** 盒内水平对齐。缺省等同于 `TEXT_DEFAULTS.textAlign`。 */
  textAlign?: TextAlign;
  /** 字间距，单位 px，可为负。缺省等同于 `TEXT_DEFAULTS.letterSpacing`。 */
  letterSpacing?: number;
}

/** 可以一次改动掉的文本字段。 */
export type TextPatch = Partial<Pick<TextNode, "text" | "fontFamily" | "fontSize" | "lineHeight" | "fontWeight" | "fontStyle" | "textAlign" | "letterSpacing">>;

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

/**
 * 一次文档格式迁移的记录。
 *
 * 迁移后的文档会把这段历史留在自己身上，这样导入、恢复和备份报告都能说清
 * "这份文档是从哪个格式版本升上来的"。
 */
export interface MigrationRecord {
  from: number;
  to: number;
  at: string;
}

export interface DesignDocument {
  schemaVersion: 2;
  id: DocumentId;
  revision: number;
  meta: DocumentMeta;
  pageOrder: PageId[];
  pages: Record<PageId, DesignPage>;
  nodes: Record<NodeId, DesignNode>;
  components: Record<ComponentId, ComponentDefinition>;
  tokens: Record<string, TokenValue>;
  assets: Record<AssetId, AssetMetadata>;
  /** 迁移历史；新建文档没有这个字段，迁移过的文档才有。 */
  migrations?: MigrationRecord[];
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
