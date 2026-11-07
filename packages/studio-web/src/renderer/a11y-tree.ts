import type { DesignDocument, DesignNode } from "@ufira/design-schema";
import { deletableRoots } from "../selection-policy";

/**
 * 画布的可访问性节点树。
 *
 * 纯 Canvas 画布没有可聚焦的 DOM 节点，键盘用户和屏幕阅读器会完全丢失结构。
 * 这里按绘制顺序（同样是图层顺序）生成一份扁平的、带层级的列表，渲染成一个视觉
 * 隐藏但可聚焦的 listbox —— 和 tldraw 的隐藏列表思路一致。
 *
 * 这个模块只做数据，不碰 DOM，所以顺序、过滤、层级都能直接测。
 */
export interface A11yItem {
  id: string;
  label: string;
  /** 缩进层级：顶层为 0。 */
  level: number;
  kind: DesignNode["type"];
  locked: boolean;
}

export interface A11yOptions {
  /** 是否包含隐藏节点；默认不包含（与画布可见性一致）。 */
  includeHidden?: boolean;
}

export function buildA11yTree(document: DesignDocument, pageId: string, options: A11yOptions = {}): A11yItem[] {
  const page = document.pages[pageId];
  if (!page) return [];
  const items: A11yItem[] = [];
  const walk = (ids: string[], level: number) => {
    for (const id of ids) {
      const node = document.nodes[id];
      if (!node) continue;
      if (node.visible === false && !options.includeHidden) continue;
      items.push({ id, label: node.name || node.id, level, kind: node.type, locked: node.locked });
      if (node.childIds.length) walk(node.childIds, level + 1);
    }
  };
  walk(page.childIds, 0);
  return items;
}

/** 键盘导航：在扁平列表里移动，两端夹紧。 */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  const base = current < 0 ? 0 : current;
  return Math.min(length - 1, Math.max(0, base + delta));
}

export function indexOfSelection(items: A11yItem[], selectedIds: string[]): number {
  return items.findIndex(item => selectedIds.includes(item.id));
}

/**
 * Delete 键要删的目标。
 *
 * 锁定节点不删：它仍然可以被选中查看属性，但批量删除不该顺手删掉它。判断走
 * `selection-policy` 的同一套规则，画布、层板和这个隐藏列表不会各说各话。
 */
export function deletionTarget(items: A11yItem[], index: number): A11yItem | undefined {
  const item = items[index];
  if (!item) return undefined;
  const [deletable] = deletableRoots([{ id: item.id, locked: item.locked }]);
  return deletable ? item : undefined;
}
