import type { Constraints, ConstraintAxis, DesignDocument, DesignNode, LayoutSpec } from "@ufira/design-schema";

/**
 * 约束：父级尺寸变化时，子节点按规则重新定位/缩放。
 *
 * 放在运行时而不是 UI，是因为改父级尺寸的入口不止一个（属性面板、画布手柄、AI 计划、
 * 外部 MCP 集成）。只在 UI 里补子节点的话，AI 或集成改一次父级尺寸就会留下「子节点没跟着
 * 动」的文档，而且这种不一致会随调用方不同而变化。
 *
 * 这段逻辑只对**存储值**做算术，不依赖布局引擎：运行时因此不需要引入 `design-layout`。
 */

export interface ConstraintChange {
  id: string;
  layout: LayoutSpec;
}

/**
 * 父级尺寸变化后要写入的子节点布局补丁。
 *
 * 返回的是补丁而不是直接改文档，这样调用方可以把它们和父级的 patch 放在同一次变更里，
 * 撤销一次就整体还原。
 */
export function applyConstraints(document: DesignDocument, parent: DesignNode, previous: LayoutSpec, next: LayoutSpec): ConstraintChange[] {
  // 只有绝对布局容器里的子节点受约束；stack 的排布由布局引擎负责（与 Figma 一致）。
  if (parent.layout.mode !== "absolute") return [];
  // hug 的尺寸是「结果」不是输入：重排子节点会反过来影响父级尺寸，形成回路。
  const fromWidth = previous.width;
  const fromHeight = previous.height;
  const toWidth = next.widthMode === "hug" ? fromWidth : next.width;
  const toHeight = next.heightMode === "hug" ? fromHeight : next.height;
  if (fromWidth === toWidth && fromHeight === toHeight) return [];
  return constrainChildren(document, parent, fromWidth, fromHeight, toWidth, toHeight);
}

function constrainChildren(document: DesignDocument, parent: DesignNode, fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): ConstraintChange[] {
  const changes: ConstraintChange[] = [];
  for (const childId of parent.childIds) {
    const child = document.nodes[childId];
    if (!child || child.layout.mode !== "absolute") continue;
    const constrained = constrainNode(child, fromWidth, fromHeight, toWidth, toHeight);
    if (!constrained) continue;
    changes.push({ id: child.id, layout: constrained });
    // 子节点自己变宽/变高（stretch、scale）时，它内部的节点也要重排。
    if (constrained.width !== child.layout.width || constrained.height !== child.layout.height) {
      changes.push(...constrainChildren(document, child, child.layout.width, child.layout.height, constrained.width, constrained.height));
    }
  }
  return changes;
}

function constrainNode(node: DesignNode, fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): LayoutSpec | undefined {
  const constraints: Constraints | undefined = node.constraints;
  // 没写约束等于 start：父级变大时不动，和 Figma 的默认值一致。
  if (!constraints) return undefined;
  const horizontal = constrainAxis(constraints.horizontal, node.layout.x, node.layout.width, fromWidth, toWidth);
  const vertical = constrainAxis(constraints.vertical, node.layout.y, node.layout.height, fromHeight, toHeight);
  if (horizontal.position === node.layout.x && horizontal.size === node.layout.width
    && vertical.position === node.layout.y && vertical.size === node.layout.height) return undefined;
  return { ...node.layout, x: horizontal.position, y: vertical.position, width: horizontal.size, height: vertical.size };
}

/** 单轴约束。`from` 为 0 时 `scale` 退化成不动，避免除零。 */
function constrainAxis(mode: ConstraintAxis, position: number, size: number, from: number, to: number): { position: number; size: number } {
  const delta = to - from;
  if (delta === 0) return { position, size };
  switch (mode) {
    case "start": return { position, size };
    case "end": return { position: position + delta, size };
    case "center": return { position: position + delta / 2, size };
    case "stretch": return { position, size: Math.max(1, size + delta) };
    case "scale": {
      const ratio = from === 0 ? 1 : to / from;
      return { position: position * ratio, size: Math.max(1, size * ratio) };
    }
    default: return { position, size };
  }
}
