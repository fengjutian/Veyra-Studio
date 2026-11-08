import { buildNode, type SceneNode } from "../renderer/scene";
import type { DesignDocument, NodeId } from "@ufira/design-schema";

/**
 * 从任意节点（不要求是页面直属）构建场景子树，并把整棵子树平移到给定位置。
 *
 * 预览把「屏幕」摆到视口原点、把 overlay 摆到定位点，都靠这一个平移——
 * 布局引擎仍然按页面坐标算一次，渲染层只做坐标变换，不重算布局。
 */
export function buildTranslatedScene(
  document: DesignDocument,
  rootId: NodeId,
  boxes: Record<string, { x: number; y: number; width: number; height: number } | undefined>,
  dx: number,
  dy: number,
): SceneNode | undefined {
  const node = document.nodes[rootId];
  if (!node) return undefined;
  const scene = buildNode(document, node, boxes);
  if (!scene) return undefined;
  return translateScene(scene, dx, dy);
}

/** 场景子树整体平移（含蒙版盒子，否则蒙版判定会落在原位）。 */
export function translateScene(node: SceneNode, dx: number, dy: number): SceneNode {
  return {
    ...node,
    box: { ...node.box, x: node.box.x + dx, y: node.box.y + dy },
    children: node.children.map(child => translateScene(child, dx, dy)),
    ...(node.maskedBy?.length ? { maskedBy: node.maskedBy.map(mask => translateScene(mask, dx, dy)) } : {}),
  };
}
