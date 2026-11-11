import type { ComputedBox } from "@ufira/design-layout";
import type { DesignCommand } from "@ufira/design-runtime";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { copyNodeTrees } from "./node-clipboard";

/**
 * 编组 / 取消编组。
 *
 * 没有单独的 group 节点类型：编组就是一个不带填充的 frame。这样画布、布局引擎、
 * 导出和事务日志都不需要为新类型开分支，编组出来的东西也能直接当容器用。
 *
 * 坐标全部按**布局引擎解出来的绝对盒**换算：节点存的是相对父级的位置，直接把
 * 绝对坐标写回去会让编组后的对象整体跑偏。
 */

export interface GroupPlan {
  frameId: string;
  /** 被编组的根节点（已排除选中节点内部的子节点）。 */
  nodeIds: string[];
  /** 编组 frame 落在哪个父级里（跨父级编组时是最近共同祖先）。 */
  parentId: string;
  commands: DesignCommand[];
}

export interface UngroupPlan {
  /** 从编组里放出来的子节点。 */
  childIds: string[];
  commands: DesignCommand[];
}

/**
 * 最近共同祖先。
 *
 * 跨父级编组时，编组 frame 要落在**所有选中节点共同的祖先**里：往上找到第一个
 * 同时包含它们的容器（页面也算容器）。返回的是节点 id 或页面 id。
 */
export function nearestCommonAncestor(document: DesignDocument, ids: readonly string[]): string | undefined {
  if (!ids.length) return undefined;
  const chains = ids.map(id => ancestorChain(document, id));
  let common = chains[0]!;
  for (const chain of chains.slice(1)) {
    common = common.filter(id => chain.includes(id));
  }
  // 链是从节点往页面排的，第一个公共元素就是最深的共同祖先。
  return common[0];
}

/** 从节点往上到页面的祖先链（自己也在链里）。 */
function ancestorChain(document: DesignDocument, id: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = id;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = document.nodes[current]?.parentId;
  }
  return chain;
}

/** 选中节点在文档里的先后顺序（先序遍历），用来决定编组内的叠放次序。 */
function documentOrder(document: DesignDocument, ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (wanted.has(id)) ordered.push(id);
    for (const childId of document.nodes[id]?.childIds ?? []) walk(childId);
  };
  const pages = document.pageOrder.length ? document.pageOrder : Object.keys(document.pages);
  for (const pageId of pages) {
    for (const childId of document.pages[pageId]?.childIds ?? []) walk(childId);
  }
  // 不在页面里的节点（理论上不该出现）按传入顺序补在后面。
  for (const id of ids) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** 子树里是否含有目标节点之一。 */
function containsAny(document: DesignDocument, id: string, wanted: ReadonlySet<string>): boolean {
  if (wanted.has(id)) return true;
  for (const childId of document.nodes[id]?.childIds ?? []) {
    if (containsAny(document, childId, wanted)) return true;
  }
  return false;
}

/**
 * 编组 frame 在父级里的插入位置。
 *
 * 取「第一个含选中节点的兄弟」的位置——这样编组后的层级与原来一致，不会把整组
 * 顶到最上面或压到最后。
 */
function insertIndexFor(document: DesignDocument, ancestorId: string, ordered: readonly string[]): number {
  const siblings = document.pages[ancestorId]?.childIds ?? document.nodes[ancestorId]?.childIds ?? [];
  const wanted = new Set(ordered);
  for (let index = 0; index < siblings.length; index += 1) {
    if (containsAny(document, siblings[index]!, wanted)) return index;
  }
  return siblings.length;
}

/** 父级内容盒的原点（页面坐标）：页面是 (0,0)，容器还要加自己的 padding。 */
function contentOrigin(document: DesignDocument, boxes: Record<string, ComputedBox>, ancestorId: string): { x: number; y: number } | undefined {
  if (document.pages[ancestorId]) return { x: 0, y: 0 };
  const box = boxes[ancestorId];
  if (!box) return undefined;
  const padding = document.nodes[ancestorId]?.layout.padding;
  return { x: box.x + (padding?.left ?? 0), y: box.y + (padding?.top ?? 0) };
}

/**
 * 编组：把选中的对象包进一个不带填充的 frame。
 *
 * 跨父级也能编：frame 落在**最近共同祖先**里，坐标按绝对盒换算。取消编组时子节点
 * 只能回到 frame 的父级（文档里没有记录它们各自的原父级）。
 */
export function planGroup(
  document: DesignDocument,
  selectedIds: string[],
  boxes: Record<string, ComputedBox>,
  options: { id: string; name?: string },
): GroupPlan | undefined {
  const nodeIds = copyNodeTrees(document, selectedIds).roots;
  if (nodeIds.length < 2) return undefined;
  // frame 落在最近共同祖先里：同父级时就是原来的父级，跨父级时是它们的公共容器。
  const parentId = nearestCommonAncestor(document, nodeIds);
  if (!parentId) return undefined;
  const origin = contentOrigin(document, boxes, parentId);
  if (!origin) return undefined;

  const childBoxes = nodeIds.map(id => boxes[id]);
  if (childBoxes.some(box => !box)) return undefined;
  const minX = Math.min(...childBoxes.map(box => box!.x));
  const minY = Math.min(...childBoxes.map(box => box!.y));
  const maxX = Math.max(...childBoxes.map(box => box!.x + box!.width));
  const maxY = Math.max(...childBoxes.map(box => box!.y + box!.height));

  const ordered = documentOrder(document, nodeIds);
  const insertAt = insertIndexFor(document, parentId, ordered);

  const frame: DesignNode = {
    id: options.id,
    type: "frame",
    name: options.name?.trim() || "编组",
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: {
      ...defaultLayout(),
      x: minX - origin.x,
      y: minY - origin.y,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      widthMode: "fixed",
      heightMode: "fixed",
    },
    appearance: defaultAppearance(),
  };

  const commands: DesignCommand[] = [
    { type: "node.create", payload: { node: frame, index: insertAt } },
  ];
  for (const childId of ordered) {
    const child = document.nodes[childId]!;
    const box = boxes[childId]!;
    commands.push({ type: "node.reparent", payload: { id: childId, parentId: frame.id } });
    // 编组之后子节点坐标相对 frame，而不是页面。frame 没有 padding，内容盒原点就是它自己。
    commands.push({
      type: "node.patch",
      payload: { id: childId, patch: { layout: { ...child.layout, x: box.x - minX, y: box.y - minY } } },
    });
  }
  return { frameId: frame.id, nodeIds: ordered, parentId, commands };
}

/**
 * 取消编组：把子节点放回 frame 原来的位置，并删掉空 frame。
 *
 * 限制：子节点会回到 **frame 的父级**，而不是各自原来的父级——文档里没有记录
 * 「这个节点原来在谁下面」，要还原得改文档结构（超出本次范围）。
 */
export function planUngroup(
  document: DesignDocument,
  frameId: string,
  boxes: Record<string, ComputedBox>,
): UngroupPlan | undefined {
  const frame = document.nodes[frameId];
  if (!frame || frame.type !== "frame" || frame.childIds.length === 0) return undefined;
  const parentId = frame.parentId;
  const parent = document.nodes[parentId] ?? document.pages[parentId];
  if (!parent) return undefined;
  const parentBox = document.nodes[parentId] ? boxes[parentId] : undefined;
  if (document.nodes[parentId] && !parentBox) return undefined;
  const originX = parentBox?.x ?? 0;
  const originY = parentBox?.y ?? 0;

  const childIds = [...frame.childIds];
  const startIndex = parent.childIds.indexOf(frameId);
  const commands: DesignCommand[] = [];
  let index = startIndex >= 0 ? startIndex : undefined;
  for (const childId of childIds) {
    const child = document.nodes[childId];
    const box = boxes[childId];
    if (!child || !box) return undefined;
    commands.push({
      type: "node.patch",
      payload: { id: childId, patch: { layout: { ...child.layout, x: box.x - originX, y: box.y - originY } } },
    });
    commands.push({ type: "node.reparent", payload: index === undefined ? { id: childId, parentId } : { id: childId, parentId, index } });
    if (index !== undefined) index += 1;
  }
  // frame 现在是空的，删掉它不会连带删除刚放出来的子节点。
  commands.push({ type: "node.delete", payload: { id: frameId } });
  return { childIds, commands };
}
