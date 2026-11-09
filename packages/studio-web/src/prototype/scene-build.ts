import { buildNode, type SceneNode } from "../renderer/scene";
import type { DesignDocument, DesignNode, NodeId } from "@ufira/design-schema";

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
  return applyOverflowClip(translateScene(scene, dx, dy), document);
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

/** 滚动偏移（二维，单位 px）。 */
export interface ScrollOffset {
  x: number;
  y: number;
}

/** 节点的溢出模式。 */
export type OverflowMode = "visible" | "hidden" | "scroll";

/** 容器型节点：只有它们才有子节点，才谈得上滚动。 */
const CONTAINER_TYPES = new Set(["frame", "component", "instance"]);

/**
 * 读节点上的溢出模式；字段没写就是 `undefined`。
 *
 * `overflow` 是**可选的文档字段**，还没进 `design-schema` 的类型与 schema
 * （补丁片段见 `docs/prototype-runtime.md` 第 8.1 节）：字段缺失时读到的就是
 * `undefined`，所以未打补丁的文档行为与现在完全一致。
 */
export function overflowOf(node: DesignNode | undefined): OverflowMode | undefined {
  const value = (node as { overflow?: unknown } | undefined)?.overflow;
  return value === "scroll" || value === "visible" || value === "hidden" ? value : undefined;
}

/** 是否是容器型节点。 */
export function isContainerNode(node: DesignNode | undefined): boolean {
  if (!node) return false;
  return CONTAINER_TYPES.has(node.type);
}

/**
 * 这个节点是不是滚动宿主。
 *
 * 显式声明 `overflow: "scroll"` 的容器才是。顶层 frame 的宿主身份由
 * `scrollHostsInSubtree()` 单独给（它得先知道「谁是屏」）。
 */
export function isScrollHost(node: DesignNode | undefined): boolean {
  return isContainerNode(node) && overflowOf(node) === "scroll";
}

/**
 * 一屏里的滚动宿主（从外到内）。
 *
 * 顶层 frame 默认是宿主：Figma 的原型语义就是画板内容溢出时可以滚，
 * 不需要额外声明；显式写 `overflow: "hidden"` / `"visible"` 才放弃。
 * 其余容器必须显式 `overflow: "scroll"`。
 */
export function scrollHostsInSubtree(document: DesignDocument, rootId: NodeId): NodeId[] {
  const hosts: NodeId[] = [];
  const root = document.nodes[rootId];
  if (!root) return hosts;
  const rootOverflow = overflowOf(root);
  if (isContainerNode(root) && rootOverflow !== "hidden" && rootOverflow !== "visible") hosts.push(rootId);
  const walk = (id: NodeId) => {
    const node = document.nodes[id];
    if (!node) return;
    for (const childId of node.childIds) {
      const child = document.nodes[childId];
      if (!child) continue;
      if (isScrollHost(child)) hosts.push(childId);
      walk(childId);
    }
  };
  walk(rootId);
  return hosts;
}

/**
 * 宿主的内容能滚多远。
 *
 * 以子节点相对宿主盒子的**超出量**算：内容没超出就是 0（滚不动）。
 * 盒子取布局结果，没有布局结果时退回节点自己的 layout（与 `buildNode` 同一套兜底）。
 */
export function computeScrollMax(
  document: DesignDocument,
  boxes: Record<string, { x: number; y: number; width: number; height: number } | undefined>,
  hostId: NodeId,
): ScrollOffset {
  const host = document.nodes[hostId];
  const hostBox = boxes[hostId] ?? host?.layout;
  if (!host || !hostBox) return { x: 0, y: 0 };
  let right = hostBox.x + hostBox.width;
  let bottom = hostBox.y + hostBox.height;
  for (const childId of host.childIds) {
    const childBox = boxes[childId] ?? document.nodes[childId]?.layout;
    if (!childBox) continue;
    right = Math.max(right, childBox.x + childBox.width);
    bottom = Math.max(bottom, childBox.y + childBox.height);
  }
  return {
    x: Math.max(0, right - (hostBox.x + hostBox.width)),
    y: Math.max(0, bottom - (hostBox.y + hostBox.height)),
  };
}

/**
 * 按 `overflow: "visible"` 放开裁切。
 *
 * 渲染器默认把容器的子节点裁在盒子里（`clip: true`），
 * 显式声明 `visible` 的容器不裁切——内容可以溢出到盒子外面。
 * 只在原型预览里生效：编辑画布的裁切行为由画布自己决定。
 */
function applyOverflowClip(node: SceneNode, document: DesignDocument): SceneNode {
  const children = node.children.map(child => applyOverflowClip(child, document));
  return overflowOf(document.nodes[node.id]) === "visible" ? { ...node, clip: false, children } : { ...node, children };
}

/**
 * 把滚动偏移应用到场景树。
 *
 * 滚动宿主**自己不动**，它的内容整体平移 `-offset`——于是内容在宿主盒子里挪动，
 * 超出盒子的部分照常被裁切（这正是滚动容器该有的样子）。
 * 嵌套的宿主各自平移自己的内容。
 */
export function applyScrollToScene(node: SceneNode, offsets: Record<string, ScrollOffset | undefined>): SceneNode {
  const offset = offsets[node.id];
  const children = node.children.map(child => {
    const moved = offset ? translateScene(child, -offset.x, -offset.y) : child;
    return applyScrollToScene(moved, offsets);
  });
  return { ...node, children };
}
