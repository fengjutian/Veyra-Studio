import { buildNode, type SceneNode } from "../renderer/scene";
import type { DesignDocument, DesignNode, NodeId, OverflowMode } from "@ufira/design-schema";

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

/** 节点的溢出模式；字段没写就是 `undefined`（缺省裁切不滚动）。 */
export type { OverflowMode };

/** 容器型节点：只有它们才有子节点，才谈得上滚动。 */
const CONTAINER_TYPES = new Set(["frame", "component", "instance"]);

/**
 * 读节点上的溢出模式；字段没写就是 `undefined`。
 *
 * 字段是**可选的文档字段**（`design-schema` 的 `BaseNode.overflow`），
 * 缺省就是「裁切不滚动」，所以旧文档的行为与现在完全一致。
 */
export function overflowOf(node: DesignNode | undefined): OverflowMode | undefined {
  return node?.overflow;
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
 *
 * 两个定位规则在这一层生效（只在原型预览里）：
 *
 * - `fixed`：钉在预览视口上，不吃**任何**祖先的滚动位移；
 * - `sticky`：在最近的滚动宿主里粘住——跟着内容滚，但滚出宿主可视区就停住。
 *
 * 两者都写成节点上的可选字段（`position`），旧文档没有这个字段，
 * 于是旧文档的行为与现在逐字一致。
 */
export function applyScrollToScene(
  node: SceneNode,
  offsets: Record<string, ScrollOffset | undefined>,
  document: DesignDocument,
  boxes: Record<string, { x: number; y: number; width: number; height: number } | undefined> = {},
): SceneNode {
  const hosts = new Set(scrollHostsInSubtree(document, node.id));
  return applyScroll(node, offsets, document, hosts, boxes, { x: 0, y: 0 }, undefined);
}

/**
 * `accumulated` 是**已经应用到这棵子树的累计平移**（像素，右下为正；向上滚是负数）。
 *
 * 每一层只平移「这一层该差多少」，祖先的位移已经在更早的层里算进去了——
 * 所以这里不能直接平移累计值，否则会重复计算。
 */
function applyScroll(
  node: SceneNode,
  offsets: Record<string, ScrollOffset | undefined>,
  document: DesignDocument,
  hosts: Set<NodeId>,
  boxes: Record<string, { x: number; y: number; width: number; height: number } | undefined>,
  accumulated: ScrollOffset,
  nearestHost: SceneNode | undefined,
): SceneNode {
  const own = offsets[node.id];
  // 宿主自己的滚动偏移只作用在它的内容上，宿主自己不动。
  const contentShift: ScrollOffset = own
    ? { x: accumulated.x - own.x, y: accumulated.y - own.y }
    : accumulated;
  // 子节点眼里的「最近滚动宿主」：自己是宿主就换成自己，否则沿用祖先的。
  const childHost = hosts.has(node.id) ? node : nearestHost;

  const children = node.children.map(child => {
    const position = document.nodes[child.id]?.position;
    let target = contentShift;
    if (position === "fixed") {
      // 钉在视口：把一路继承下来的滚动位移全部抵消。
      target = { x: 0, y: 0 };
    } else if (position === "sticky" && childHost) {
      target = stickyShift(child, contentShift, accumulated, childHost, document, boxes);
    }
    // 当前已经累计的是 `accumulated`，要变成 `target` 就补上这段差值。
    const moved = translateScene(child, target.x - accumulated.x, target.y - accumulated.y);
    return applyScroll(moved, offsets, document, hosts, boxes, target, childHost);
  });
  return { ...node, children };
}

/**
 * 一条滚动条（轨道 + 滑块）。
 *
 * 滑块长度按「可视长度 / 内容长度」算——内容越长，滑块越短；
 * 拖动滑块时把像素位移换算成滚动距离，靠 `thumbPerScroll`。
 */
export interface ScrollbarBar {
  hostId: NodeId;
  orientation: "vertical" | "horizontal";
  /** 轨道在舞台里的盒子。 */
  track: { x: number; y: number; width: number; height: number };
  /** 滑块在舞台里的盒子。 */
  thumb: { x: number; y: number; width: number; height: number };
  /** 滑块每移动 1px，内容要滚多少 px。 */
  thumbPerScroll: number;
}

/** 滚动条厚度（px）。 */
const SCROLLBAR_THICKNESS = 8;
/** 滑块最短长度（px）；再短就没法用鼠标拖了。 */
const SCROLLBAR_MIN_THUMB = 24;
/** 滑块与宿主边缘的间距（px）。 */
const SCROLLBAR_GAP = 2;

/**
 * 一屏里所有能滚的宿主，各画一条滚动条。
 *
 * 宿主「能滚」= 它的内容超出了盒子（`computeScrollMax` > 0）；
 * 装得下的容器不画——画一条永远拖不动的条只会让人以为还能滚。
 */
export function scrollbarBars(
  scene: SceneNode,
  offsets: Record<string, ScrollOffset | undefined>,
  document: DesignDocument,
  boxes: Record<string, { x: number; y: number; width: number; height: number } | undefined>,
): ScrollbarBar[] {
  const hosts = new Set(scrollHostsInSubtree(document, scene.id));
  const bars: ScrollbarBar[] = [];
  const walk = (node: SceneNode) => {
    if (hosts.has(node.id)) {
      const max = computeScrollMax(document, boxes, node.id);
      const offset = offsets[node.id] ?? { x: 0, y: 0 };
      if (max.y > 0) bars.push(bar(node, offset, max, "vertical"));
      if (max.x > 0) bars.push(bar(node, offset, max, "horizontal"));
    }
    for (const child of node.children) walk(child);
  };
  walk(scene);
  return bars;
}

function bar(host: SceneNode, offset: ScrollOffset, max: ScrollOffset, orientation: "vertical" | "horizontal"): ScrollbarBar {
  const vertical = orientation === "vertical";
  const visible = vertical ? host.box.height : host.box.width;
  const content = visible + (vertical ? max.y : max.x);
  const thumbLength = Math.min(visible, Math.max(SCROLLBAR_MIN_THUMB, Math.round((visible * visible) / content)));
  const travel = visible - thumbLength;
  const scrolled = vertical ? offset.y : offset.x;
  const total = vertical ? max.y : max.x;
  const along = vertical ? host.box.y : host.box.x;
  const thumbStart = total > 0 ? Math.round((travel * scrolled) / total) : 0;

  if (vertical) {
    const x = host.box.x + host.box.width - SCROLLBAR_THICKNESS - SCROLLBAR_GAP;
    return {
      hostId: host.id,
      orientation,
      track: { x, y: host.box.y, width: SCROLLBAR_THICKNESS, height: host.box.height },
      thumb: { x, y: along + thumbStart, width: SCROLLBAR_THICKNESS, height: thumbLength },
      thumbPerScroll: total > 0 && travel > 0 ? travel / total : 0,
    };
  }
  const y = host.box.y + host.box.height - SCROLLBAR_THICKNESS - SCROLLBAR_GAP;
  return {
    hostId: host.id,
    orientation,
    track: { x: host.box.x, y, width: host.box.width, height: SCROLLBAR_THICKNESS },
    thumb: { x: along + thumbStart, y, width: thumbLength, height: SCROLLBAR_THICKNESS },
    thumbPerScroll: total > 0 && travel > 0 ? travel / total : 0,
  };
}

/**
 * 粘性节点的目标累计平移。
 *
 * 节点跟着内容滚，但一旦滚出滚动宿主的可视区就停住——所以最终位置要夹在
 * 宿主的可视范围里。只有宿主**真的能滚**的那个方向才夹：内容本来就装得下时，
 * 把节点拉回宿主边缘是错的。
 */
function stickyShift(
  child: SceneNode,
  contentShift: ScrollOffset,
  accumulated: ScrollOffset,
  host: SceneNode,
  document: DesignDocument,
  boxes: Record<string, { x: number; y: number; width: number; height: number } | undefined>,
): ScrollOffset {
  const max = computeScrollMax(document, boxes, host.id);
  if (max.x <= 0 && max.y <= 0) return contentShift;

  // 自然位置：完全跟着内容滚时的位置（宿主坐标系里 child.box 还没吃本层的差值）。
  const naturalX = child.box.x + (contentShift.x - accumulated.x);
  const naturalY = child.box.y + (contentShift.y - accumulated.y);
  const hostLeft = host.box.x;
  const hostTop = host.box.y;
  const hostRight = hostLeft + host.box.width;
  const hostBottom = hostTop + host.box.height;

  const finalX = max.x > 0
    ? Math.min(Math.max(naturalX, hostLeft), Math.max(hostLeft, hostRight - child.box.width))
    : naturalX;
  const finalY = max.y > 0
    ? Math.min(Math.max(naturalY, hostTop), Math.max(hostTop, hostBottom - child.box.height))
    : naturalY;

  // 累计平移 = 最终位置 - 原始位置；原始位置要减掉已经吃进去的累计。
  return {
    x: accumulated.x + (finalX - child.box.x),
    y: accumulated.y + (finalY - child.box.y),
  };
}
