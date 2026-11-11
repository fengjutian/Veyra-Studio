export type DocumentId = string;
export type PageId = string;
export type NodeId = string;
export type ComponentId = string;
export type ComponentSetId = string;
export type AssetId = string;

import type { VectorGeometry } from "./geometry";
import type { Interaction } from "./interactions";
import type { TextRun } from "./rich-text";
import type { ParagraphStyleRun } from "./paragraph-styles";
import type { DocumentFont } from "./fonts";
import type { BooleanOperation } from "./boolean";

export interface DocumentMeta {
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface DesignPage {
  id: PageId;
  name: string;
  childIds: NodeId[];
  /** Page viewport in CSS pixels. Missing values keep legacy documents at 960 × 680. */
  width?: number;
  height?: number;
  /**
   * 这一页自带的主题（可选）。
   *
   * 翻到这一页时默认用这个主题——「暗色模式演示页」就是靠它：那一页单独是暗色，
   * 其它页是亮色，不需要用户手动切主题。
   *
   * 视图层显式选了某个主题时以视图为准；不选就跟随页面。指向不存在的主题会在
   * 文档校验阶段报错。
   */
  themeId?: string;
}

export type SizeMode = "fixed" | "fill" | "hug";

/**
 * Grid 轨道。
 *
 * 前五种类型对应 CSS Grid 的 `grid-template-columns/rows` 里的轨道尺寸：
 * - `fixed` — 固定像素；
 * - `fraction` — 比例权重（`1fr` / `2fr`），按剩余空间分配；
 * - `auto` — 按内容撑开（既不是最小也不是最大，取内容的固有尺寸）；
 * - `min-content` — 按内容最小尺寸；
 * - `max-content` — 按内容最大尺寸。
 *
 * 第六种是**自动重复轨道**，对应 CSS 的 `repeat(auto-fill|auto-fit, …)`：
 * 轨道数量由容器可用尺寸推导，而不是写死。
 *
 * 语义对齐 Penpot 的 grid-track，见 `docs/figma-gap-roadmap.md`。
 */
export type GridTrack =
  | { type: "fixed"; size: number }
  | { type: "fraction"; weight: number }
  | { type: "auto" }
  | { type: "min-content" }
  | { type: "max-content" }
  /**
   * 自动重复轨道（`repeat(auto-fill|auto-fit, minmax(min, 1fr))`）。
   *
   * 轨道条数 = ⌊(可用尺寸 + gap) ÷ (min + gap)⌋，至少 1 条。
   * - `auto-fill`：条数只由容器决定，放不满时右侧留空轨道；
   * - `auto-fit`：条数再被「这一轴上有几个子节点」夹住，空轨道被收起，
   *   于是剩余空间全部给到子节点（Figma 里「自动铺满」的常见效果）。
   * - `grow`：轨道在最小宽度之上继续均分剩余空间（相当于 `minmax(min, 1fr)`）；
   *   关掉就是 `repeat(…, min)`，右侧留白。
   */
  | { type: "repeat"; mode: "auto-fill" | "auto-fit"; min: number; grow?: boolean };

/** 子节点在 Grid 容器里占据的单元格区间（行列均从 1 开始计数）。 */
export interface GridCellPlacement {
  /** 起始行（1-based）。 */
  row: number;
  /** 起始列（1-based）。 */
  column: number;
  /** 跨几行；缺省 1。 */
  rowSpan?: number;
  /** 跨几列；缺省 1。 */
  columnSpan?: number;
  /** 与 `area` 互斥。 */
  area?: undefined;
}

/**
 * 用命名区域定位子节点。
 *
 * 行列区间由 `GridSpec.areas` 模板里同名区域的外接矩形推导，
 * 因此改模板时子节点会跟着走——这正是命名区域相对「手写行列号」的价值。
 */
export interface GridCellArea {
  /** 区域名；必须在 `GridSpec.areas` 模板里存在且构成矩形。 */
  area: string;
  /** 与 `area` 互斥。 */
  row?: undefined;
  column?: undefined;
  rowSpan?: undefined;
  columnSpan?: undefined;
}

/**
 * 子节点在 Grid 容器里的位置。
 *
 * 两种写法二选一：直接给行列区间，或引用命名区域。
 * 同时给出两者会让「到底听谁的」变得含糊，schema 层直接拒绝。
 */
export type GridCell = GridCellPlacement | GridCellArea;

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
  /**
   * 命名网格区域模板（CSS `grid-template-areas` 语义）。
   *
   * 每个字符串是一行，以空格分列；同名单元格必须构成矩形，`.` 表示空位。
   * 模板的行列数必须与 `rows` / `columns` 的轨道数一致——否则「区域画在第 3 列、
   * 轨道只有 2 条」这类错位只能靠猜，不如直接拒绝。
   */
  areas?: string[];
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

/**
 * 阴影（投影 / 内阴影）。
 *
 * `spread`（扩散半径）与 `type`（投影 / 内阴影）是**可选**字段：旧文档没有它们，
 * 行为与升级前逐字一致，格式版本也不用动。
 */
export interface ShadowSpec {
  /** 水平偏移，px。 */
  x: number;
  /** 垂直偏移，px。 */
  y: number;
  /** 模糊半径，px，>= 0。 */
  blur: number;
  /** CSS 颜色。 */
  color: string;
  /**
   * 扩散半径（px）：把阴影轮廓向外扩这么多再模糊，对应 CSS `box-shadow` 的第 4 个值。
   *
   * 缺省 0（不扩散）。正数向外扩、负数向内收。
   */
  spread?: number;
  /**
   * 阴影类型：缺省 `drop`（投影，落在形状外面）；`inner` 是内阴影（落在形状内部）。
   *
   * 内阴影的偏移方向与投影相反——与 CSS `box-shadow: inset` 同一套语义。
   */
  type?: "drop" | "inner";
}

/**
 * 渐变色标：`offset` 是 0–1 的位置。 */
export interface PaintStop {
  offset: number;
  color: string;
}

/**
 * 混合模式。
 *
 * 取值与 CSS `mix-blend-mode` 对齐——这样 HTML/SVG 导出可以直接用同一套名字，
 * 不必每种格式各翻译一次。
 *
 * **注意 Canvas 2D 不支持全部取值**：`hue` / `saturation` / `color` / `luminosity`
 * 在 `globalCompositeOperation` 里没有对应值，画布上会退回 `normal`
 * 并给出警告，而不是画出一个看起来对但其实错的结果。
 */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

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
  | { type: "radial"; cx: number; cy: number; r: number; stops: PaintStop[] }
  /**
   * 椭圆渐变：`cx`/`cy` 是归一化中心，`rx`/`ry` 是两个半轴（相对盒子的比例）。
   *
   * 与 `radial` 的区别就是「圆」与「椭圆」——Figma 的径向渐变默认是正圆，
   * 拉宽盒子就得到椭圆；这里显式给出两个半轴，避免依赖盒子长宽比。
   *
   * `angle` 是旋转角（度，顺时针，缺省 0 = 不旋转）：椭圆长轴的方向。
   */
  | { type: "elliptical"; cx: number; cy: number; rx: number; ry: number; angle?: number; stops: PaintStop[] };

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
  /**
   * 混合模式；缺省 `normal`。
   *
   * 节点级属性（与 `opacity` / `shadow` / `blur` 平级），
   * 决定这个节点与**它下面的内容**如何混合——语义对齐 Penpot 的 `:blend-mode`。
   */
  blendMode?: BlendMode;
  /**
   * 背景模糊半径（px）：节点**后面**的内容被模糊，节点自身不模糊。
   *
   * 与 `blur`（图层模糊，模糊节点自己）是两件事。
   */
  backgroundBlur?: number;
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
  | "instance"
  | "boolean";

/** 约束：父级尺寸变化时子节点的行为。缺省 `start`（贴左/贴上，不随父级变化）。 */
export type ConstraintAxis = "start" | "end" | "center" | "stretch" | "scale";

export interface Constraints {
  horizontal: ConstraintAxis;
  vertical: ConstraintAxis;
}

/**
 * 溢出模式：内容超出盒子时怎么办。
 *
 * - `hidden`：裁切但不滚动（**缺省**，与现有 frame 的裁剪行为一致）；
 * - `scroll`：内容超出盒子时可以滚动，超出部分照常被裁切；
 * - `visible`：不裁切，内容溢出到盒子外面。
 *
 * 只对容器型节点（frame / component / instance）有意义；其它节点类型写这个字段
 * 会被运行时拒绝。
 */
export type OverflowMode = "visible" | "hidden" | "scroll";

/**
 * 滚动定位。
 *
 * - `fixed`：相对预览视口钉住，滚动时不动；
 * - `sticky`：在最近的滚动宿主里粘住，滚到边缘时停住。
 *
 * 缺省是「跟着内容一起滚」，所以旧文档不需要迁移。
 */
export type NodePosition = "fixed" | "sticky";

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
   * 溢出模式；只对容器型节点有意义。
   *
   * 做成属性而不是新的节点类型——「内容超出盒子怎么办」本来就是盒子语义，
   * 新类型会牵动判别联合、导出、组件和 AI 计划解析的每一处。
   *
   * 缺省是 `hidden`（裁切不滚动），所以旧文档不需要迁移。
   */
  overflow?: OverflowMode;
  /**
   * 滚动定位；只在原型预览里生效。
   *
   * - `fixed`：相对预览视口钉住，滚动时不动；
   * - `sticky`：在最近的滚动宿主里粘住，滚到边缘时停住。
   *
   * 缺省是「跟着内容一起滚」，所以旧文档不需要迁移。
   * 做成可选字段而不是新节点类型——定位是「节点在滚动里的行为」，
   * 新类型会牵动判别联合、导出、组件和 AI 计划解析的每一处。
   */
  position?: NodePosition;
  /** 组件属性绑定；只在组件定义子树里有意义。 */
  componentPropertyBindings?: ComponentPropertyBindings;
  /**
   * 蒙版：这个形状不直接绘制，而是裁剪同一父级里排在它上面的兄弟层。
   *
   * 做成属性而不是新的节点类型——「这块形状只用来裁剪」本来就是属性语义，
   * 新类型会牵动判别联合、导出、组件和 AI 计划解析的每一处。
   */
  mask?: boolean;
  /**
   * 蒙版边缘羽化半径（px）：蒙版轮廓被模糊，被裁剪的内容在边缘渐隐。
   *
   * 只对 `mask: true` 的节点有意义；缺省 0（硬边，与升级前一致）。
   */
  maskFeather?: number;
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
  /**
   * 段落样式区间：列表类型、列表缩进级别、段落缩进。
   *
   * 与 `runs` 的分工：`runs` 是字符级覆盖（局部加粗），这里是整段级（这一段是不是列表项）。
   * 区间必须对齐段落边界（`\n` 切出的段），因此与 `runs` 的半段覆盖语义不同。
   * 编号不存进文档——它在渲染时按段落顺序现算，插行删行不需要迁移数据。
   */
  paragraphStyles?: ParagraphStyleRun[];
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
  /**
   * 实例显式设置过的组件属性值；键是属性 id。
   *
   * 只存**改过**的值：没改过的实例不写任何东西，这样组件默认值变化时
   * 这类实例会跟着变（和 Figma 一致）。
   */
  propValues?: Record<string, ComponentPropertyValue>;
}

/**
 * 组件属性：组件对外暴露的一个可变参数。
 *
 * 用判别联合而不是 `defaultValue: string | boolean`——类型与默认值必须配对，
 * 写成联合会让「text 属性的默认值是 false」这种错误数据也能通过 schema。
 */
export type ComponentPropertyType = "text" | "boolean" | "instance-swap" | "color" | "number";

/** 组件属性的类型。 */
export type ComponentProperty =
  | { id: string; name: string; type: "text"; defaultValue: string }
  | { id: string; name: string; type: "boolean"; defaultValue: boolean }
  | { id: string; name: string; type: "instance-swap"; defaultValue: string }
  | { id: string; name: string; type: "color"; defaultValue: string }
  | { id: string; name: string; type: "number"; defaultValue: number };

/**
 * 属性值在实例上的存储形态。
 *
 * `text` / `color` / `instance-swap` 是字符串，`boolean` 是布尔值，
 * `number` 是数字。判别联合保证了「类型 → 值形态」的对应，
 * 这里只需要一个「值本身」的联合类型来描述存储。
 */
export type ComponentPropertyValue = string | boolean | number;

/**
 * 节点字段与组件属性的绑定，方向是「字段 → 属性 id」。
 *
 * 绑定写在**被绑定的节点**上而不是写在属性上：一个节点最多绑一个 text 属性
 * 和一个 visible 属性，这样天然满足；节点被删除时绑定随之消失，
 * 不会留下指向已删节点的悬空引用。
 *
 * 支持的字段与属性类型的对应：
 *
 * | 字段 | 属性类型 | 语义 |
 * | --- | --- | --- |
 * | `text` | `text` | 文本节点的内容被属性值取代 |
 * | `visible` | `boolean` | 节点的可见性被属性值控制 |
 * | `fill` | `color` | 节点的填充色被属性值取代 |
 * | `fontSize` | `number` | 文本节点的字号被属性值取代 |
 * | `instance` | `instance-swap` | 组件内部的实例被换成属性值指向的组件 |
 */
export interface ComponentPropertyBindings {
  /** 文本字段由哪个 text 属性驱动。 */
  text?: string;
  /** 可见性由哪个 boolean 属性驱动。 */
  visible?: string;
  /** 填充色由哪个 color 属性驱动。 */
  fill?: string;
  /** 字号由哪个 number 属性驱动。 */
  fontSize?: string;
  /** 内部实例由哪个 instance-swap 属性驱动。 */
  instance?: string;
}

export interface VectorNode extends BaseNode {
  type: "vector";
  /** 归一化路径几何；缺省时沿用「按圆角矩形画」的旧回退，导出会给出诊断。 */
  geometry?: VectorGeometry;
}

export interface GenericNode extends BaseNode {
  type: Exclude<NodeType, "text" | "image" | "instance" | "vector" | "boolean">;
}

/** 布尔组：子节点是操作数（第一个为基准层），几何在读取时按运算树计算。 */
export interface BooleanNode extends BaseNode {
  type: "boolean";
  operation: BooleanOperation;
}

export type DesignNode = TextNode | ImageNode | InstanceNode | VectorNode | BooleanNode | GenericNode;

export interface ComponentDefinition {
  id: ComponentId;
  name: string;
  rootNodeId: NodeId;
  /** 所属变体集；缺省表示独立组件，不参与变体切换。 */
  variantSetId?: ComponentSetId;
  /** 变体属性取值；键必须是所属集合 `properties` 的子集，并覆盖全部属性。 */
  variant?: Record<string, string>;
  /**
   * 对外暴露的组件属性；可选，旧文档没有它也不需要迁移。
   *
   * 规格见 `docs/component-properties.md`。
   */
  properties?: ComponentProperty[];
}

/**
 * 变体集：一组互斥的组件，实例可以在它们之间切换。
 *
 * 只存属性名，不存成员列表——成员由 `components[*].variantSetId` 反查。
 * 两处都存的话，删组件时一定会有一边忘了改。
 */
export interface ComponentSetDefinition {
  id: ComponentSetId;
  name: string;
  /** 变体属性名，顺序即 UI 展示顺序。 */
  properties: string[];
  /**
   * 变体集**共享**的组件属性声明；可选，旧集合没有它也完全合法。
   *
   * 解决「同一个变体集里的每个变体都要重复声明同一组属性」：
   * 声明一次，集内所有变体都拿到。合并规则见 `docs/component-properties.md` §4.1。
   */
  componentProperties?: ComponentProperty[];
}

/**
 * 字体（typography）token 的值。
 *
 * 对应设计系统里的一条「文字样式」：族名、字号、行高、字重、字形、字距。
 * 除 `fontFamily` / `fontSize` 外都可省略——省略的字段不覆盖节点自身的值，
 * 于是「只统一字号」和「整套文字样式」都能用同一种 token 表达。
 */
export interface TypographyValue {
  fontFamily: string;
  fontSize: number;
  lineHeight?: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  letterSpacing?: number;
}

/**
 * 设计 token。
 *
 * `color` / `number` / `string` 是早期的三种标量；`typography` 是复合值，
 * 绑定到文本节点后**覆盖**节点的文字样式（见 `resolveTypography()`）；
 * `alias` 指向另一个 token，解析时沿链取最终值（见 `resolveTokenTarget()`）。
 */
export type TokenValue =
  | { type: "color" | "number" | "string"; value: string | number }
  | { type: "typography"; value: TypographyValue }
  /**
   * 别名：值就是目标 token 的名字。
   *
   * 语义对齐设计系统里的「语义 token → 基础 token」分层（`text.primary` →
   * `gray.900`）。解析时沿链取最终值，环与断链都在文档校验阶段拒绝。
   */
  | { type: "alias"; value: string };

/**
 * 资源的来源与授权信息。
 *
 * 交付设计稿时最常被问到的不是「这张图多大」，而是「这张图哪来的、能不能商用」。
 * 全部字段可选：不知道就不填，不逼用户编；填了就随文档一起备份、导出和迁移。
 */
export interface AssetOrigin {
  /** 来源：素材库名或原始 URL。 */
  source?: string;
  /** 作者或版权方。 */
  author?: string;
  /** 许可证：SPDX 标识（`CC-BY-4.0`）或一句人话。 */
  license?: string;
  /** 补充说明（例如「仅限本项目使用」）。 */
  note?: string;
}

/**
 * 资源来自某个外部素材服务的记录。
 *
 * `provider` + `providerAssetId` 一起构成**缓存键**：同一个服务里的同一个 id
 * 应当对应同一份内容，所以再取一次时不必重新请求服务（离线也能用）。
 */
export interface ExternalAssetOrigin {
  /** 服务标识，例如 `unsplash`。 */
  provider: string;
  /** 服务内部的素材 id。 */
  providerAssetId: string;
  /** 拉取时间（ISO 8601）。 */
  fetchedAt: string;
  /** 缓存过期时间（ISO 8601）；缺省表示不过期。 */
  expiresAt?: string;
}

export interface AssetMetadata {
  id: AssetId;
  hash: string;
  mimeType: string;
  byteLength: number;
  name?: string;
  /** 来源与授权；旧文档没有这个字段，缺省表示未登记。 */
  origin?: AssetOrigin;
  /** 来自外部素材服务；本地素材没有这个字段。 */
  external?: ExternalAssetOrigin;
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

/**
 * 主题对**节点自身属性**的覆盖。
 *
 * token 绑定管的是「这个值来自哪个 token」；这里管的是「写死在节点上的值」——
 * 圆角、间距、内边距、字号、透明度。主题切到暗色时，这些也要跟着变，
 * 否则「暗色下所有卡片圆角更大」这类需求做不到。
 *
 * 匹配键是**节点名**（`Theme.properties` 的键）：同名的节点会一起被覆盖，
 * 所以名字起得越具体越安全。`type` 可以再把范围收窄到某一种节点类型。
 */
export interface PropertyOverride {
  /** 只作用于这一种节点类型；缺省表示不限类型。 */
  type?: NodeType;
  /** 圆角（px）。 */
  cornerRadius?: number;
  /** 自动布局的子节点间距（px）。 */
  gap?: number;
  /** 内边距（px，四边相同）。 */
  padding?: number;
  /** 字号（px）；只对文本节点有意义。 */
  fontSize?: number;
  /** 不透明度（0–1）。 */
  opacity?: number;
}

/**
 * 一组主题覆盖。
 *
 * 主题**不改解析规则**：它只是在进入布局/渲染/导出前把覆盖合并进 token 表
 * （`applyThemeTokens()`）。因此别名、字体 token、组件、导出都自动跟随，
 * 不需要在每一处解析调用里传主题。
 *
 * 覆盖只能修改**已存在的** token：主题不是给 token 起新名字的地方，
 * 拼错名字应当在校验阶段被发现。
 */
export interface Theme {
  id: string;
  name: string;
  /**
   * 继承自另一个主题（可选）。
   *
   * 继承链上的覆盖按「祖先先、后代后」叠加：后代覆盖祖先，同一个 token 上
   * 后代的值生效。主题继承让「暗色」继承「品牌色」成为可能，而不用把品牌色
   * 的每个值在暗色里重抄一遍。
   *
   * 继承链成环、或指向不存在的主题，都在校验阶段报错。
   */
  extends?: string;
  /** token 名 → 覆盖值。未覆盖的 token 沿用 `document.tokens`。 */
  tokens: Record<string, TokenValue>;
  /**
   * 节点名 → 属性覆盖（圆角、间距等写死在节点上的值）。
   *
   * 与 `tokens` 分开：token 覆盖改的是「值」，属性覆盖改的是「节点自己的字段」，
   * 两者生效路径不同（后者直接改节点），混在一起会让「谁覆盖了谁」说不清。
   */
  properties?: Record<string, PropertyOverride>;
}

/**
 * 一个 token 分组的元数据（可选）。
 *
 * 分组本身仍然由**名字前缀**决定（`color.text.primary` → `color.text`），元数据只是
 * 覆盖它的显示方式：换个显示名、写句说明、调一下顺序。
 *
 * 保持「分组 = 前缀」这个不变，是为了让分组和 token 名始终一致——分组一旦能独立
 * 存在，就会出现「token 在哪个组」的双写问题。
 */
export interface TokenGroupMeta {
  /** 分组 id（点号路径），例如 `color.text`；未分组是空串。 */
  id: string;
  /** 面板上的显示名；缺省用 id 本身。 */
  label?: string;
  /** 一句说明，显示在分组标题下面。 */
  description?: string;
  /** 排序权重（小的在前）；缺省按 id 字典序。 */
  order?: number;
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
  /** 变体集；可选字段，旧文档没有它也不需要迁移。 */
  componentSets?: Record<ComponentSetId, ComponentSetDefinition>;
  /** 字体声明：上传的字体文件（资源 id）或依赖系统字体；可选，旧文档不需要迁移。 */
  fonts?: DocumentFont[];
  tokens: Record<string, TokenValue>;
  /** 主题：token 值的可选覆盖；旧文档没有它也不需要迁移。 */
  themes?: Theme[];
  /** token 分组的元数据（显示名、说明、顺序）；可选，旧文档没有它也不需要迁移。 */
  tokenGroups?: TokenGroupMeta[];
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
