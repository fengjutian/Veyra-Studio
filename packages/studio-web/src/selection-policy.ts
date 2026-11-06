import type { DesignNode } from "@ufira/design-schema";

/**
 * 选区语义。
 *
 * 锁定和隐藏改变的是"能不能从画布上选中、能不能被批量操作"，而不是"看不见"：
 * - 隐藏节点看不见，只能从图层面板选中；
 * - 锁定节点看得见，但画布上的点击要穿透到它下面，批量移动/删除也要跳过它；
 * - 两者的属性仍然可以改——否则用户没有解锁的入口。
 *
 * 这些规则集中在这里，是为了让画布、键盘、删除和层板共用同一套判断。
 */

/** 画布上可以用鼠标直接选中的节点。 */
export function canvasSelectable(node: DesignNode): boolean {
  return node.visible && !node.locked;
}

/** 可以参与批量移动/对齐/编组的节点。 */
export function editableNodes(nodes: DesignNode[]): DesignNode[] {
  return nodes.filter(node => !node.locked);
}

/** 选区全部被锁定：这时要明确告诉用户"先解锁"，而不是静默什么都不做。 */
export function allLocked(nodes: DesignNode[]): boolean {
  return nodes.length > 0 && nodes.every(node => node.locked);
}

/** 删除时真正会被删掉的根节点；锁定节点保留。 */
export function deletableRoots(nodes: Array<{ id: string; locked: boolean }>): string[] {
  return nodes.filter(node => !node.locked).map(node => node.id);
}
