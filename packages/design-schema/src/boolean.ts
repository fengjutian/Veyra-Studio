import { absolutePath, flattenRings, normalizePath, vectorPathCommands, type PathCommand } from "./geometry";
import { clipDifference, clipIntersection, clipUnion, clipXor, type ClipMultiPolygon, type ClipPolygon } from "./clipping";
import type { DesignDocument, DesignNode, NodeId } from "./types";

/**
 * 布尔组：文档里存**运算树**（子节点 + 运算类型），几何在读取时算出来。
 *
 * 与「烘焙成一条路径」相比，改一个操作数结果会跟着变；代价是每次渲染/导出都要算一次，
 * 因此这里只做纯计算、不缓存——缓存要跟着子树变化失效，那才是 bug 的温床。
 *
 * 参与运算的只有「形状」：矢量、矩形、椭圆，以及嵌套的布尔组。
 * 容器/文本/图片没有明确的闭合轮廓，放进布尔组语义不清，命令层会拒绝。
 */
export type BooleanOperation = "union" | "subtract" | "intersect" | "exclude";

export const BOOLEAN_OPERATIONS: readonly BooleanOperation[] = ["union", "subtract", "intersect", "exclude"];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 这个节点能不能当布尔操作数。 */
export function supportsBooleanOperand(node: DesignNode): boolean {
  return node.type === "boolean" || node.type === "vector" || node.type === "rectangle" || node.type === "ellipse";
}

/**
 * 计算布尔组的绝对坐标路径。
 *
 * 子节点顺序即 `childIds` 顺序（z 序）：**第一个是基准层**，其余参与减去/交集/合并。
 * 少于两个可用操作数、或结果为空时返回 `undefined`——调用方据此「什么都不画」。
 */
export function computeBooleanPath(
  document: DesignDocument,
  node: DesignNode,
  boxes: Record<NodeId, Box | undefined>,
): PathCommand[] | undefined {
  if (node.type !== "boolean") return undefined;
  const operands = node.childIds
    .map(id => document.nodes[id])
    .filter((child): child is DesignNode => Boolean(child) && child!.visible !== false);
  if (operands.length < 2) return undefined;

  const polygons: ClipPolygon[] = [];
  for (const operand of operands) {
    const polygon = operandPolygon(document, operand, boxes);
    if (polygon?.length) polygons.push(polygon);
  }
  if (polygons.length < 2) return undefined;

  const [base, ...rest] = polygons;
  const result: ClipMultiPolygon = node.operation === "union" ? clipUnion(base!, ...rest)
    : node.operation === "subtract" ? clipDifference(base!, ...rest)
    : node.operation === "intersect" ? clipIntersection(base!, ...rest)
    : clipXor(base!, ...rest);
  const commands = multiPolygonToCommands(result);
  return commands.length ? commands : undefined;
}

/**
 * 归一化几何：把运算结果映射到目标盒子（默认节点自己的盒子）的 [0,1] 空间。
 *
 * 画布、命中、导出都走这一份，因此布尔组可以和 vector 共用同一套路径管线。
 */
export function computeBooleanGeometry(
  document: DesignDocument,
  node: DesignNode,
  boxes: Record<NodeId, Box | undefined>,
  targetBox?: Box,
): PathCommand[] | undefined {
  const commands = computeBooleanPath(document, node, boxes);
  if (!commands?.length) return undefined;
  const box = targetBox ?? boxes[node.id] ?? node.layout;
  return normalizePath(commands, box);
}

/** 操作数 → 绝对坐标多边形（闭环保留首尾同点）。 */
function operandPolygon(document: DesignDocument, node: DesignNode, boxes: Record<NodeId, Box | undefined>): ClipPolygon | undefined {
  const box = boxes[node.id] ?? node.layout;
  switch (node.type) {
    case "rectangle":
      return [rectRing(box)];
    case "ellipse":
      return [ellipseRing(box)];
    case "vector": {
      if (!node.geometry) return undefined;
      return pathPolygon(absolutePath(vectorPathCommands(node.geometry.d), box));
    }
    case "boolean": {
      const commands = computeBooleanPath(document, node, boxes);
      return commands ? pathPolygon(commands) : undefined;
    }
    default:
      return undefined;
  }
}

function rectRing(box: Box): Array<[number, number]> {
  return [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
    [box.x, box.y],
  ];
}

/** 椭圆按 32 段折线近似；布尔运算的输入本来就是折线。 */
function ellipseRing(box: Box): Array<[number, number]> {
  const steps = 32;
  const ring: Array<[number, number]> = [];
  for (let index = 0; index < steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    ring.push([
      box.x + box.width / 2 + Math.cos(angle) * (box.width / 2),
      box.y + box.height / 2 + Math.sin(angle) * (box.height / 2),
    ]);
  }
  ring.push(ring[0]!);
  return ring;
}

function pathPolygon(commands: PathCommand[]): ClipPolygon | undefined {
  const rings = flattenRings(commands);
  if (!rings.length) return undefined;
  return rings.map(ring => {
    const pairs = ring.map(point => [point.x, point.y] as [number, number]);
    // 开放的子路径按隐式闭合处理：布尔运算的输入必须是闭合环。
    if (pairs.length && (pairs[0]![0] !== pairs.at(-1)![0] || pairs[0]![1] !== pairs.at(-1)![1])) pairs.push(pairs[0]!);
    return pairs;
  });
}

/** 多环结果 → 路径命令：每个环一个 `M … L … Z` 子路径。 */
function multiPolygonToCommands(multi: ClipMultiPolygon): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const polygon of multi) {
    for (const ring of polygon) {
      // 闭合后不足 3 个点的环没有面积（首尾同点，长度 < 4）。
      if (ring.length < 4) continue;
      commands.push({ command: "M", point: { x: ring[0]![0], y: ring[0]![1] } });
      for (let index = 1; index < ring.length - 1; index += 1) {
        commands.push({ command: "L", point: { x: ring[index]![0], y: ring[index]![1] } });
      }
      commands.push({ command: "Z" });
    }
  }
  return commands.length ? commands : [];
}
