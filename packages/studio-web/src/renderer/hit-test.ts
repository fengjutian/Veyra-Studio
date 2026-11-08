import { hitTestVectorPath, type NodeId } from "@ufira/design-schema";
import type { SceneNode } from "./scene";

/**
 * 画布命中测试。
 *
 * 语义与原先的 DOM 实现一致：返回**最深**的命中节点，并且按绘制顺序取最上层
 * （后画的在上）。这里不处理锁定（属于选择策略），只回答"这个点落在哪个节点上"。
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
    // 蒙版节点自身不可点选（能在图层树里选中），只通过 maskedBy 影响兄弟。
    if (node.children[index]!.mask) continue;
    const childPath = pathInNode(node.children[index]!, point);
    // 返回「最深 → 最外层」，方便调用方按选择优先级取用。
    if (childPath.length) return [...childPath, node.id];
  }
  return [node.id];
}

export function containsPoint(node: SceneNode, point: HitPoint): boolean {
  // 被蒙版裁掉的部分不可点：否则图片在视觉上被剪掉，落点却还能选中它。
  if (node.maskedBy?.length) {
    for (const mask of node.maskedBy) if (!containsPoint(mask, point)) return false;
  }
  const { x, y, width, height } = node.box;
  if (width <= 0 || height <= 0) return false;
  // 矢量按真实路径判定：开放路径（直线）用容差，闭合路径用奇偶规则。
  // 否则一条对角线会把它整个包围盒都变成可点击区域。
  if (node.path) return hitTestVectorPath(node.path, node.box, point);
  if (node.type === "ellipse") {
    const radiusX = width / 2;
    const radiusY = height / 2;
    const dx = (point.x - (x + radiusX)) / radiusX;
    const dy = (point.y - (y + radiusY)) / radiusY;
    return dx * dx + dy * dy <= 1;
  }
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}

/**
 * 把指针事件换算成场景坐标。
 *
 * `rect` 是画布元素的布局矩形（已被 CSS zoom 放大），所以除以 zoom 得到 960×680
 * 场景里的坐标。
 */
export function pointFromEvent(rect: { left: number; top: number }, clientX: number, clientY: number, zoom: number): HitPoint {
  const scale = zoom > 0 ? zoom : 1;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}
