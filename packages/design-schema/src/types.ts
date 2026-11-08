export type DocumentId = string;
export type PageId = string;
export type NodeId = string;
export type ComponentId = string;
export type AssetId = string;

import type { VectorGeometry } from "./geometry";
import type { Interaction } from "./interactions";
import type { TextRun } from "./rich-text";

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

/**
 * Grid 轨道。
 *
 * 五种类型对应 CSS Grid 的 `grid-template-columns/rows` 里的五种轨道尺寸：
 * - `fixed` — 固定像素；
 * - `fraction` — 比例权重（`1fr` / `2fr`），按剩余空间分配；
 * - `auto` — 按内容撑开（既不是最小也不是最大，取内容的固有尺寸）；
 * - `min-content` — 按内容最小尺寸；
 * - `max-content` — 按内容最大尺寸。
 *
 * 语义对齐 Penpot 的 grid-track，见 `docs/figma-gap-roadmap.md`。
 */
export type GridTrack =
  | { type: "fixed"; size: number }
  | { type: "fraction"; weight: number }
  | { type: "auto" }
  | { type: "min-content" }
  | { type: "max-content" };

/** 子节点在 Grid 容器里占据的单元格区间（行列均从 1 开始计数）。 */
export interface GridCell {
  /** 起始行（1-based）。 */
  row: number;
  /** 起始列（1-based）。 */
  column: number;
  /** 跨几行；缺省 1。 */
  rowSpan?: number;
  /** 跨几列；缺省 1。 */
  columnSpan?: number;
}

/**
 * Grid 容器配置。
 *
 * `cells` 按**子节点 id** 索引：子节点占哪一格是它自己的属性，
 * 放在容器里是为了让布局求解一次读全，不必每个子节点回头查父级。
 */
export interface GridSpec {
  columns: GridTrack[];
  rows: GridTrack[];
  columnGap: number;
  rowGap: number;
  /** 子节点 → 单元格区间。缺省的子节点按顺序依次填格子。 */
  cells?: Record<NodeId, GridCell>;
  /** 子节点在格子内的对齐；缺省 `start`。 */
  align?: "start" | "center" | "end" | "stretch";
}

export interface LayoutSpec {
  mode: "absolute" | "stack" | "grid";
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
  /**
   * Grid 容器配置；只在 `mode: "grid"` 时有意义。
   *
   * 做成可选字段而不是新节点类型——「这个容器用网格排版」是布局属性，
   * 与 `mode` 的其它取值是同一层语义。
   */
  grid?: GridSpec;
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
  | { type: "linear"; angle: number; stops: PaintStop[] }
  /**
   * 径向渐变：`cx`/`cy` 是相对盒子的归一化中心（0–1），`r` 是半径占盒子长边的比例。
   * 三处渲染都用「盒子长边 × r」算圆半径，非等比盒子上也是一个正圆（不是椭圆）。
   */
  | { type: "radial"; cx: number; cy: number; r: number; stops: PaintStop[] };

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
  /**
   * 原型交互：点击等事件触发的动作。
   *
   * 做成节点上的可选数组而不是新节点类型——交互是「节点的行为」，
   * 新类型会牵动判别联合、导出、组件和 AI 计划解析的每一处。
   *
   * 语义对齐 Penpot 的 interactions 模型，见 `docs/penpot-porting.md`。
   */
  interactions?: Interaction[];
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
  /**
   * 段内样式覆盖（富文本）：一段文字里局部加粗/斜体/变色。
   *
   * 用「偏移 + 样式」的区间表示，而不是把文本拆成数组：`text` 仍是唯一的内容真相，
   * 纯文本编辑器、AI 计划、搜索和导出拿 `text` 就能工作，不必理解富文本结构。
   */
  runs?: TextRun[];
}

/** 可以一次改动掉的文本字段。 */
export type TextPatch = Partial<Pick<TextNode, "text" | "fontFamily" | "fontSize" | "lineHeight" | "fontWeight" | "fontStyle" | "textAlign" | "letterSpacing" | "runs">>;

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
  schemaVersion: 4;
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
