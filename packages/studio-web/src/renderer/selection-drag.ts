import type { SceneBox, SceneNode } from "./scene";
import { resizeRect, type HandleId, type Rect } from "./selection";

/**
 * 拖拽/缩放的预览计算。
 *
 * 画布渲染走 Canvas，所以拖动时不能像 DOM 那样直接改 `transform`；这里算出
 * 「拖动过程中每个节点应该出现在哪」，交给渲染器临时覆盖。指针抬起后只提交
 * 选中根节点的布局，子节点由布局引擎按相对坐标重算。
 */

/** 递归收集选中节点及其后代的偏移盒子（拖动整棵子树）。 */
export function offsetSubtreeBoxes(scene: SceneNode[], ids: Iterable<string>, deltaX: number, deltaY: number): Record<string, SceneBox> {
  const wanted = new Set(ids);
  const overrides: Record<string, SceneBox> = {};
  const walk = (nodes: SceneNode[], insideSelection: boolean) => {
    for (const node of nodes) {
      const selected = insideSelection || wanted.has(node.id);
      if (selected) {
        overrides[node.id] = { ...node.box, x: node.box.x + deltaX, y: node.box.y + deltaY };
      }
      if (node.children.length) walk(node.children, selected);
    }
  };
  walk(scene, false);
  return overrides;
}

/** 单个节点缩放后的盒子；多选缩放暂不支持，避免引入复杂的组变换。 */
export function resizeBox(box: SceneBox, handle: HandleId, deltaX: number, deltaY: number, minSize = 4): SceneBox {
  const next: Rect = resizeRect(box, handle, deltaX, deltaY, minSize);
  return next;
}

/** 用预览盒子生成新的场景（只克隆被覆盖的节点，其余复用引用）。 */
export function applyBoxOverrides(scene: SceneNode[], overrides: Record<string, SceneBox>): SceneNode[] {
  if (!Object.keys(overrides).length) return scene;
  const walk = (nodes: SceneNode[]): SceneNode[] => nodes.map(node => {
    const box = overrides[node.id];
    const children = node.children.length ? walk(node.children) : node.children;
    if (!box && children === node.children) return node;
    return { ...node, ...(box ? { box } : {}), children };
  });
  return walk(scene);
}

/** 拖拽结束后要提交的布局补丁：只提交选中根节点。 */
export function layoutPatches(boxes: Record<string, SceneBox>, ids: Iterable<string>): Array<{ id: string; box: SceneBox }> {
  const patches: Array<{ id: string; box: SceneBox }> = [];
  for (const id of ids) {
    const box = boxes[id];
    if (box) patches.push({ id, box });
  }
  return patches;
}
