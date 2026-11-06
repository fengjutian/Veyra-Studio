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
  commands: DesignCommand[];
}

export interface UngroupPlan {
  /** 从编组里放出来的子节点。 */
  childIds: string[];
  commands: DesignCommand[];
}

/** 编组要求至少两个同为兄弟的节点；其余情况返回 undefined，由界面解释原因。 */
export function planGroup(
  document: DesignDocument,
  selectedIds: string[],
  boxes: Record<string, ComputedBox>,
  options: { id: string; name?: string },
): GroupPlan | undefined {
  const nodeIds = copyNodeTrees(document, selectedIds).roots;
  if (nodeIds.length < 2) return undefined;
  const nodes = nodeIds.map(id => document.nodes[id]!);
  const parentId = nodes[0]!.parentId;
  // 跨父级编组要先算两套坐标系，容易把位置算错；先只支持同级编组。
  if (!nodes.every(node => node.parentId === parentId)) return undefined;
  const parentBox = boxes[parentId];
  if (document.nodes[parentId] && !parentBox) return undefined;

  const childBoxes = nodeIds.map(id => boxes[id]);
  if (childBoxes.some(box => !box)) return undefined;
  const minX = Math.min(...childBoxes.map(box => box!.x));
  const minY = Math.min(...childBoxes.map(box => box!.y));
  const maxX = Math.max(...childBoxes.map(box => box!.x + box!.width));
  const maxY = Math.max(...childBoxes.map(box => box!.y + box!.height));
  const originX = parentBox?.x ?? 0;
  const originY = parentBox?.y ?? 0;

  const siblings = document.pages[parentId]?.childIds ?? document.nodes[parentId]?.childIds ?? [];
  const ordered = siblings.filter(id => nodeIds.includes(id));
  // 不在兄弟列表里的节点（理论上不该出现）也要编进去，顺序排在后面。
  for (const id of nodeIds) if (!ordered.includes(id)) ordered.push(id);
  const insertAt = siblings.indexOf(ordered[0]!);

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
      x: minX - originX,
      y: minY - originY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
      widthMode: "fixed",
      heightMode: "fixed",
    },
    appearance: defaultAppearance(),
  };

  const commands: DesignCommand[] = [
    { type: "node.create", payload: insertAt >= 0 ? { node: frame, index: insertAt } : { node: frame } },
  ];
  for (const childId of ordered) {
    const child = document.nodes[childId]!;
    const box = boxes[childId]!;
    commands.push({ type: "node.reparent", payload: { id: childId, parentId: frame.id } });
    // 编组之后子节点坐标相对 frame，而不是页面。
    commands.push({
      type: "node.patch",
      payload: { id: childId, patch: { layout: { ...child.layout, x: box.x - minX, y: box.y - minY } } },
    });
  }
  return { frameId: frame.id, nodeIds: ordered, commands };
}

/** 取消编组：把子节点放回 frame 原来的位置，并删掉空 frame。 */
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
