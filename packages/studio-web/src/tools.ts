import type { IconName } from "./icons";
import type { HitPoint } from "./renderer/hit-test";
import type { Rect } from "./renderer/selection";

/**
 * 画布工具表。
 *
 * 「工具」回答的是**指针现在准备做什么**，不是「插入什么」：选中矩形工具之后，
 * 在画布上拖拽就是画矩形，松手提交一条 `node.create`，然后回到选择工具。
 * 工具本身只是视图状态——不进文档、不涨 revision、不写快照。
 *
 * 这个模块是纯函数层：没有 React、没有 DOM，图标只以名字引用（type-only import），
 * 因此可以在 node 环境里直接跑单测。
 */
export type ToolId = "select" | "frame" | "rectangle" | "ellipse" | "text" | "hand";

/** 能用拖拽「画出来」的工具，也就是会创建节点的工具。 */
export type DrawToolId = Extract<ToolId, "frame" | "rectangle" | "ellipse" | "text">;

export interface ToolSpec {
  id: ToolId;
  /** 工具栏提示文案里的名字。 */
  label: string;
  /** 单键快捷键（小写，匹配 `event.key.toLowerCase()`）。 */
  shortcut: string;
  icon: IconName;
  cursor: string;
  /** 这个工具拖拽时创建的节点类型。选择/抓手没有。 */
  creates?: DrawToolId;
}

/** 工具栏顺序：选择在前，然后是图元，抓手放在画布控件里但仍在工具表中。 */
export const TOOLS: readonly ToolSpec[] = [
  { id: "select", label: "选择", shortcut: "v", icon: "select", cursor: "default" },
  { id: "frame", label: "Frame", shortcut: "f", icon: "addFrame", cursor: "crosshair", creates: "frame" },
  { id: "rectangle", label: "矩形", shortcut: "r", icon: "addRectangle", cursor: "crosshair", creates: "rectangle" },
  { id: "ellipse", label: "椭圆", shortcut: "o", icon: "addEllipse", cursor: "crosshair", creates: "ellipse" },
  { id: "text", label: "文本", shortcut: "t", icon: "addText", cursor: "text", creates: "text" },
  { id: "hand", label: "抓手", shortcut: "h", icon: "pan", cursor: "grab" },
];

export function toolSpec(id: ToolId): ToolSpec {
  return TOOLS.find(spec => spec.id === id) ?? TOOLS[0]!;
}

/** 是否为「拖拽绘制」工具（选择与抓手不是）。 */
export function isDrawTool(tool: ToolId): tool is DrawToolId {
  return tool === "frame" || tool === "rectangle" || tool === "ellipse" || tool === "text";
}

/** 单击（没有拖拽）时创建的默认尺寸。 */
export const DEFAULT_DRAW_SIZE: Record<DrawToolId, { width: number; height: number }> = {
  frame: { width: 240, height: 140 },
  rectangle: { width: 240, height: 140 },
  ellipse: { width: 240, height: 140 },
  text: { width: 160, height: 48 },
};

/** 小于这个尺寸（场景单位）的拖拽按「单击」处理。 */
export const MIN_DRAW_SIZE = 2;

/** 单击落点对应的默认矩形：左上角落在点上。 */
export function defaultRectFor(tool: DrawToolId, point: HitPoint): Rect {
  const size = DEFAULT_DRAW_SIZE[tool];
  return { x: point.x, y: point.y, width: size.width, height: size.height };
}

export interface DrawModifiers {
  /** 按住 Shift：等比（正方形 / 正圆）。 */
  shift?: boolean;
  /** 按住 Alt：以按下点为中心展开。 */
  alt?: boolean;
}

/**
 * 拖拽矩形求解。
 *
 * 修饰键在每次移动时重新求值（不是按下时锁定），所以可以边拖边按 Shift。
 * 返回值总是规范化过的正宽高矩形。
 */
export function rectFromDrag(start: HitPoint, current: HitPoint, modifiers: DrawModifiers = {}): Rect {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (modifiers.shift) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = dx < 0 ? -size : size;
    dy = dy < 0 ? -size : size;
  }
  if (modifiers.alt) {
    // 以按下点为中心：两个对角点相对 start 对称。
    return fromCorners(start.x - Math.abs(dx), start.y - Math.abs(dy), start.x + Math.abs(dx), start.y + Math.abs(dy));
  }
  return fromCorners(start.x, start.y, start.x + dx, start.y + dy);
}

/** 把矩形钳制在画板范围内（拖到画板外时不生成越界节点）。 */
export function clampRect(rect: Rect, bounds: { width: number; height: number }): Rect {
  const left = clamp(rect.x, 0, bounds.width);
  const top = clamp(rect.y, 0, bounds.height);
  const right = clamp(rect.x + rect.width, 0, bounds.width);
  const bottom = clamp(rect.y + rect.height, 0, bounds.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** 绘制提交后的下一个工具：图元工具回到选择，其他工具保持不变。 */
export function nextToolAfterDraw(tool: ToolId): ToolId {
  return isDrawTool(tool) ? "select" : tool;
}

/** 单键快捷键 → 工具；不认识返回 undefined（不抢别的键）。 */
export function shortcutTool(key: string): ToolId | undefined {
  const normalized = key.toLowerCase();
  return TOOLS.find(spec => spec.shortcut === normalized)?.id;
}

/** 拖拽结果是否小到该当成单击。 */
export function isClickDraw(rect: Rect): boolean {
  return rect.width < MIN_DRAW_SIZE || rect.height < MIN_DRAW_SIZE;
}

function fromCorners(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
