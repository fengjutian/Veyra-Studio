/**
 * Studio 图标表 —— 统一使用 Lucide（ISC License，https://lucide.dev）。
 *
 * 这里是「语义 → 图标」的唯一映射：顶栏按钮、图层面板、属性面板、图层类型
 * 都从这张表取图形。改图标只改这一处，不要在业务文件里手写 SVG path。
 *
 * 命名约定：`<scope><Action>`，scope 对应 UI 区域（action / export / page /
 * shape / layerOrder / align / token / component / ai / node）。
 */
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Braces,
  Boxes,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle as CircleIcon,
  ClipboardPaste,
  Combine,
  Component as ComponentIcon,
  Copy,
  CopyPlus,
  Diff,
  FileCode,
  FileImage,
  FilePlus,
  Focus,
  Frame as FrameIcon,
  Group,
  Hand,
  History,
  Image as ImageIcon,
  Layers as LayersIcon,
  Link2,
  Lock,
  LockOpen,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Pencil,
  PenTool,
  Pentagon,
  Plus,
  Redo2,
  RotateCcw,
  Scan,
  Search,
  Shapes,
  Shuffle,
  Slash,
  Spline,
  Square as SquareIcon,
  Star,
  Trash,
  Type as TypeIcon,
  Undo2,
  Ungroup,
  Unlink,
  Upload,
  VenetianMask,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";

export type { LucideIcon };

/** 语义 → Lucide 图形的映射表。 */
export const ICONS = {
  // 顶栏 / 通用动作
  newProject: FilePlus,
  rename: Pencil,
  undo: Undo2,
  redo: Redo2,
  trash: Trash,

  // 导出 / 导入
  exportHtml: FileCode,
  exportSvg: Shapes,
  exportPng: FileImage,
  exportJson: Braces,
  import: Upload,

  // 页面
  page: FilePlus,
  pageAdd: Plus,
  pageDelete: Trash,

  // 画布工具
  select: MousePointer2,

  // 新建节点
  addFrame: FrameIcon,
  addRectangle: SquareIcon,
  addEllipse: CircleIcon,
  addText: TypeIcon,
  addLine: Slash,
  addPolygon: Pentagon,
  addStar: Star,
  addPen: PenTool,

  // 图层编辑
  copy: Copy,
  paste: ClipboardPaste,
  duplicate: CopyPlus,
  group: Group,
  ungroup: Ungroup,

  // 选区
  selectAll: CheckCheck,

  // 画布视图
  zoomIn: ZoomIn,
  zoomOut: ZoomOut,
  zoomFit: Scan,
  pan: Hand,

  // 面板开合
  panelLeft: PanelLeft,
  panelRight: PanelRight,

  // 通用
  search: Search,
  close: X,

  // 图层顺序
  toBack: ArrowDownToLine,
  moveDown: ArrowDown,
  moveUp: ArrowUp,
  toFront: ArrowUpToLine,
  layerOrder: LayersIcon,

  // 锁定状态
  lock: Lock,
  unlock: LockOpen,

  // 蒙版
  mask: VenetianMask,

  // 对齐与分布
  alignLeft: AlignStartHorizontal,  alignCenterX: AlignCenterHorizontal,
  alignRight: AlignEndHorizontal,
  alignTop: AlignStartVertical,
  alignCenterY: AlignCenterVertical,
  alignBottom: AlignEndVertical,
  distributeX: AlignHorizontalSpaceAround,
  distributeY: AlignVerticalSpaceAround,
  alignGroup: AlignCenterHorizontal,

  // 布尔运算
  booleanUnion: Combine,
  booleanSubtract: Diff,
  booleanIntersect: Focus,
  booleanExclude: Shuffle,

  // 颜色 Token
  tokenAdd: Plus,
  tokenEdit: Pencil,
  tokenBind: Link2,
  tokenUnbind: Unlink,
  tokenRemove: X,

  // 组件
  componentCreate: ComponentIcon,
  componentInstantiate: Boxes,
  componentRemove: X,

  // AI 安全编辑
  aiPlan: WandSparkles,
  aiConfirm: Check,
  aiCancel: X,

  // 图层树
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,

  // 历史版本
  versionHistory: History,
  versionRestore: RotateCcw,

  // 节点类型
  nodeFrame: FrameIcon,
  nodeText: TypeIcon,
  nodeImage: ImageIcon,
  nodeRectangle: SquareIcon,
  nodeEllipse: CircleIcon,
  nodeComponent: ComponentIcon,
  nodeInstance: LayersIcon,
  nodeVector: Spline,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** 边长（px），默认 13，适配 12px 的紧凑面板。 */
  size?: number;
  /** 可选的无障碍名称；不传时图标对读屏隐藏。 */
  title?: string;
}

/** 渲染一个 Studio 图标，统一 stroke 粗细与无障碍行为。 */
export function Icon({ name, size = 13, title }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={2}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title}
    />
  );
}
