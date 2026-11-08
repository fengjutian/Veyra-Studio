export type DocumentId = string;
export type PageId = string;
export type NodeId = string;
export type ComponentId = string;
export type AssetId = string;

import type { VectorGeometry } from "./geometry";

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
  /**
   * 旋转角（角度制，顺时针为正，绕节点自身中心）。
   *
   * 只存角度不存矩阵：矩阵每次都要分解回角度，精度会漂移；而角度 + 布局盒已经能
   * 完整表达这个变换。旋转**不参与布局**——布局引擎仍按轴对齐盒子排版，旋转只影响
   * 绘制与命中，和 Figma 的行为一致。
   */
  rotation?: number;
}

/**
 * 四角圆角，顺序与 CSS `border-radius` 一致：左上、右上、右下、左下。
 *
 * 与单值的 `cornerRadius` 并存：单值是「四角相同」的快捷写法，四角独立时用这个字段；
 * 两者同时存在时四角独立优先（画布、HTML、SVG 三处共用 `resolveCornerRadii`）。
 */
export type CornerRadii = [number, number, number, number];

/** 投影。没有 `spread`：Canvas 的 shadow 没有扩散半径，三套实现不一致的字段先不给。 */
export interface ShadowSpec {
  /** 水平偏移，px。 */
  x: number;
  /** 垂直偏移，px。 */
  y: number;
  /** 模糊半径，px，>= 0。 */
  blur: number;
  /** CSS 颜色。 */
  color: string;
}

/** 渐变色标：`offset` 是 0–1 的位置。 */
export interface PaintStop {
  offset: number;
  color: string;
}

/**
 * 填充层。
 *
 * 数组形态是为了以后加多层填充；当前至少支持一层纯色或一层线性渐变。
 * 角度沿用 CSS 约定：0deg 指向上，顺时针为正——画布、HTML、SVG 三处不需要各自换算。
 */
export type Paint =
  | { type: "solid"; color: string }
  | { type: "linear"; angle: number; stops: PaintStop[] };

export interface AppearanceSpec {
  opacity: number;
  /** 填充层；省略表示无填充。颜色 token 绑定生效时会被压成单一实色。 */
  fills?: Paint[];
  stroke?: string;
  /** 描边宽度（px）。缺省按 1px，与旧文档和 DOM 默认边框一致。 */
  strokeWidth?: number;
  cornerRadius?: number;
  cornerRadii?: CornerRadii;
  /** 投影；只作用于节点自身，子节点不继承（与 Figma 一致）。 */
  shadow?: ShadowSpec;
  /** 图层模糊半径（px）；0 表示不模糊。 */
  blur?: number;
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

/** 约束：父级尺寸变化时子节点的行为。缺省 `start`（贴左/贴上，不随父级变化）。 */
export type ConstraintAxis = "start" | "end" | "center" | "stretch" | "scale";

export interface Constraints {
  horizontal: ConstraintAxis;
  vertical: ConstraintAxis;
}

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
  /** 父级尺寸变化时的行为；只在父级是绝对布局容器时生效。 */
  constraints?: Constraints;
  /** 作为组件插槽的 frame：实例可以往这里填充自己的内容。 */
  slot?: boolean;
  /**
   * 蒙版：这个形状不直接绘制，而是裁剪同一父级里排在它上面的兄弟层。
   *
   * 做成属性而不是新的节点类型——「这块形状只用来裁剪」本来就是属性语义，
   * 新类型会牵动判别联合、导出、组件和 AI 计划解析的每一处。
   */
  mask?: boolean;
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

export interface VectorNode extends BaseNode {
  type: "vector";
  /** 归一化路径几何；缺省时沿用「按圆角矩形画」的旧回退，导出会给出诊断。 */
  geometry?: VectorGeometry;
}

export interface GenericNode extends BaseNode {
  type: Exclude<NodeType, "text" | "image" | "instance" | "vector">;
}

export type DesignNode = TextNode | ImageNode | InstanceNode | VectorNode | GenericNode;

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
  schemaVersion: 3;
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
