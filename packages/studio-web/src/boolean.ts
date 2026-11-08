import {
  absolutePath,
  flattenRings,
  normalizePath,
  pathBounds,
  pathDataFromCommands,
  vectorPathCommands,
  type DesignDocument,
  type DesignNode,
  type PathCommand,
  type VectorGeometry,
} from "@ufira/design-schema";
import type { IconName } from "./icons";
import type { Rect } from "./renderer/selection";
import { clipDifference, clipIntersection, clipUnion, clipXor, type ClipMultiPolygon, type ClipPolygon } from "./boolean-clip";

/**
 * 布尔运算（P4）。
 *
 * 设计文档里存的是**结果**，不是运算树：应用时把操作数烘焙成一条路径，操作数删除。
 * 这样撤销、导出、AI 编辑都不需要理解布尔语义，也不用处理「子节点移动后结果失效」。
 *
 * 代价写在规格里：输入先离散成折线（每段曲线 16 份），所以结果不含曲线——放大看圆角
 * 会看到折线。这是烘焙方案的固有代价，不是渲染 bug。
 */
export type BooleanOperation = "union" | "subtract" | "intersect" | "exclude";

export interface BooleanOperationSpec {
  id: BooleanOperation;
  label: string;
  icon: IconName;
  /** 事务历史里的一句人话。 */
  summary: string;
}

export const BOOLEAN_OPERATIONS: readonly BooleanOperationSpec[] = [
  { id: "union", label: "合并", icon: "booleanUnion", summary: "合并形状" },
  { id: "subtract", label: "减去", icon: "booleanSubtract", summary: "减去形状" },
  { id: "intersect", label: "交集", icon: "booleanIntersect", summary: "形状交集" },
  { id: "exclude", label: "排除", icon: "booleanExclude", summary: "排除重叠" },
];

export interface BooleanOperand {
  node: DesignNode;
  box: Rect;
}

const BOOLEAN_TYPES = new Set(["vector", "rectangle", "ellipse"]);

/** 单个节点能不能参与布尔：只有形状和路径，文本/图片/容器不行。 */
export function supportsBoolean(node: DesignNode): boolean {
  return BOOLEAN_TYPES.has(node.type);
}

/**
 * 选区 → 布尔操作数（按 z 序从下到上）。
 *
 * 基准层是**最下面**的那一层：Figma 的减去/交集以它为被减数与交集基准。
 * 选区顺序是点击顺序，不能拿来当基准，所以这里按父级 `childIds` 排序。
 */
export function booleanOperands(ids: string[], document: DesignDocument, boxes: Record<string, Rect | undefined>): BooleanOperand[] | undefined {
  const nodes = ids.map(id => document.nodes[id]).filter((node): node is DesignNode => Boolean(node));
  if (nodes.length < 2) return undefined;
  if (!nodes.every(node => supportsBoolean(node) && node.visible !== false && !node.locked)) return undefined;
  const parentId = nodes[0]!.parentId;
  if (!nodes.every(node => node.parentId === parentId)) return undefined;
  const parent = document.pages[parentId] ?? document.nodes[parentId];
  const order = parent?.childIds ?? [];
  const operands: BooleanOperand[] = [];
  for (const node of [...nodes].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))) {
    const box = boxes[node.id];
    if (!box) return undefined;
    operands.push({ node, box });
  }
  return operands;
}

/**
 * 执行运算并返回烘焙后的几何。
 *
 * 返回 `undefined` 表示结果为空（例如完全不相交的交集）——调用方应提示而不是提交空节点。
 */
export function applyBoolean(operands: BooleanOperand[], operation: BooleanOperation): { box: Rect; geometry: VectorGeometry } | undefined {
  const polygons = operands.map(operand => shapePolygon(operand.node, operand.box)).filter((polygon): polygon is ClipPolygon => Boolean(polygon));
  if (polygons.length < 2) return undefined;
  const [base, ...rest] = polygons;
  const result = operation === "union" ? clipUnion(base!, ...rest)
    : operation === "subtract" ? clipDifference(base!, ...rest)
    : operation === "intersect" ? clipIntersection(base!, ...rest)
    : clipXor(base!, ...rest);
  const commands = multiPolygonToCommands(result);
  if (!commands.length) return undefined;
  const bounds = pathBounds(commands);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return undefined;
  // 和钢笔一样：退化方向撑到 1px，否则盒子没有面积、命中测试直接判空。
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const box: Rect = { x: bounds.x - (width - bounds.width) / 2, y: bounds.y - (height - bounds.height) / 2, width, height };
  return { box, geometry: { kind: "path", d: pathDataFromCommands(normalizePath(commands, box)) } };
}

/** 把任意参与布尔的结构转成多边形（绝对坐标，环首尾闭合）。 */
function shapePolygon(node: DesignNode, box: Rect): ClipPolygon | undefined {
  if (node.type === "rectangle") {
    return [[[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height], [box.x, box.y]]];
  }
  if (node.type === "ellipse") {
    const ring: Array<[number, number]> = [];
    const steps = 32;
    for (let index = 0; index < steps; index += 1) {
      const angle = (index / steps) * Math.PI * 2;
      ring.push([box.x + box.width / 2 + Math.cos(angle) * (box.width / 2), box.y + box.height / 2 + Math.sin(angle) * (box.height / 2)]);
    }
    ring.push(ring[0]!);
    return [ring];
  }
  if (node.type === "vector") {
    if (!node.geometry) return undefined;
    const rings = flattenRings(absolutePath(vectorPathCommands(node.geometry.d), box));
    if (!rings.length) return undefined;
    return rings.map(ring => {
      const pairs = ring.map(point => [point.x, point.y] as [number, number]);
      // 开放子路径按隐式闭合处理：布尔运算的输入必须是闭合环。
      if (pairs.length && (pairs[0]![0] !== pairs.at(-1)![0] || pairs[0]![1] !== pairs.at(-1)![1])) pairs.push(pairs[0]!);
      return pairs;
    });
  }
  return undefined;
}

/** 多环结果 → 路径命令；每个环一个 M…Z 子路径。 */
function multiPolygonToCommands(multi: ClipMultiPolygon): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const polygon of multi) {
    for (const ring of polygon) {
      // 少于 4 个点的环（首尾闭合后 3 个点）没有面积。
      if (ring.length < 4) continue;
      commands.push({ command: "M", point: { x: ring[0]![0], y: ring[0]![1] } });
      for (let index = 1; index < ring.length - 1; index += 1) {
        commands.push({ command: "L", point: { x: ring[index]![0], y: ring[index]![1] } });
      }
      commands.push({ command: "Z" });
    }
  }
  return commands;
}
