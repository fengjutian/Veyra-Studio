import { constrainLayout } from "@ufira/design-runtime";
import type { DesignDocument, DesignNode } from "@ufira/design-schema";
import type { SceneBox } from "./renderer/scene";

/**
 * 拖动父级尺寸时的约束预览。
 *
 * 画布在拖拽过程中不会重跑布局引擎，子节点的盒子停在原地；这里用**和运行时同一套**
 * `constrainLayout()` 算出子节点的新盒子，让预览与松手后的结果完全一致。各写一份的话，
 * 松手那一刻子节点会跳一下。
 *
 * 坐标换算：文档里子节点的 x/y 是相对父级的，而画布盒子是绝对坐标，所以用
 * 「父级绝对位移 + 子节点相对位移」来推新盒子——这样不用关心父级有没有内边距。
 */
export function constrainedBoxes(
  document: DesignDocument,
  boxes: Record<string, SceneBox>,
  parentId: string,
  from: SceneBox,
  to: SceneBox,
): Record<string, SceneBox> {
  const result: Record<string, SceneBox> = {};
  const parent = document.nodes[parentId];
  // stack 容器的子节点由布局引擎排，约束不参与（和运行时一致）。
  if (!parent || parent.layout.mode !== "absolute") return result;
  if (from.width === to.width && from.height === to.height) return result;

  const walk = (node: DesignNode, absoluteDelta: { x: number; y: number }, fromSize: { width: number; height: number }, toSize: { width: number; height: number }): void => {
    for (const childId of node.childIds) {
      const child = document.nodes[childId];
      if (!child || child.layout.mode !== "absolute") continue;
      const next = constrainLayout(child.layout, child.constraints, fromSize, toSize);
      if (!next) continue;
      const oldBox = boxes[childId];
      if (!oldBox) continue;
      const dx = absoluteDelta.x + (next.x - child.layout.x);
      const dy = absoluteDelta.y + (next.y - child.layout.y);
      result[childId] = { x: oldBox.x + dx, y: oldBox.y + dy, width: next.width, height: next.height };
      // 子节点自己变宽/变高时（stretch、scale），它的子节点也要跟着预览。
      if (next.width !== child.layout.width || next.height !== child.layout.height) {
        walk(child, { x: dx, y: dy }, { width: child.layout.width, height: child.layout.height }, { width: next.width, height: next.height });
      }
    }
  };

  walk(parent, { x: to.x - from.x, y: to.y - from.y }, { width: from.width, height: from.height }, { width: to.width, height: to.height });
  return result;
}
