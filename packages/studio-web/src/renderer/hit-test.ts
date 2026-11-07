import type { NodeId } from "@ufira/design-schema";
import type { SceneNode } from "./scene";

/**
 * 画布命中测试。
 *
 * 语义与现有 DOM 实现一致：返回**最深**的命中节点（DOM 侧是 `closest("[data-node-id]")`），
 * 并且按绘制顺序取最上层（后画的在上）。这里不处理锁定（属于选择策略），只回答
 * "这个点落在哪个节点上"。
 *
 * 命中判定对椭圆做精确判断（DOM 里 `border-radius: 50%` 同样会让角落不可点），
 * 圆角矩形暂按矩形处理——圆角只在四角几个像素上有差异，后续需要时再补。
 */
export interface HitPoint {
  x: number;
  y: number;
}

/** 图片/文本等叶子节点也算命中：点文字等于点它所在的文本节点。 */
export function hitTest(nodes: SceneNode[], point: HitPoint): NodeId | undefined {
  const stack = hitTestStack(nodes, point);
  return stack[0];
}

/** 从最深层到最外层的命中路径，供右键菜单、Alt+点击穿透使用。 */
export function hitTestStack(nodes: SceneNode[], point: HitPoint): NodeId[] {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const path = pathInNode(nodes[index]!, point);
    if (path.length) return path;
  }
  return [];
}

function pathInNode(node: SceneNode, point: HitPoint): NodeId[] {
  if (node.opacity <= 0) return [];
  if (!containsPoint(node, point)) return [];
  for (let index = node.children.length - 1; index >= 0; index -= 1) {
    const childPath = pathInNode(node.children[index]!, point);
    // 返回「最深 → 最外层」，方便调用方按选择优先级取用。
    if (childPath.length) return [...childPath, node.id];
  }
  return [node.id];
}

export function containsPoint(node: SceneNode, point: HitPoint): boolean {
  const { x, y, width, height } = node.box;
  if (width <= 0 || height <= 0) return false;
  if (node.type === "ellipse") {
    const radiusX = width / 2;
    const radiusY = height / 2;
    const dx = (point.x - (x + radiusX)) / radiusX;
    const dy = (point.y - (y + radiusY)) / radiusY;
    return dx * dx + dy * dy <= 1;
  }
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}
