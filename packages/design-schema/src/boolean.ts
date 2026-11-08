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

/**
 * 曲线级布尔引擎。
 *
 * 引擎由**上层注入**（见 `studio-application/src/boolean-engine.ts`）：
 * schema 层不依赖任何几何库，核心包保持零依赖；装了引擎就走曲线级布尔，
 * 没装就退回多边形近似（结果仍然是正确的形状，只是曲线被离散成折线）。
 */
export interface BooleanEngine {
  /**
   * 把多个操作数的绝对坐标路径合成一条结果路径。
   *
   * 返回 `undefined` 表示算不出来——调用方据此退回多边形近似。
   */
  combine(operands: readonly PathCommand[][], operation: BooleanOperation): PathCommand[] | undefined;
}

let engine: BooleanEngine | undefined;

/** 安装（或卸下）曲线级布尔引擎。 */
export function setBooleanEngine(next: BooleanEngine | undefined): void {
  engine = next;
}

/** 当前引擎；没装就是 `undefined`（退回多边形近似）。 */
export function getBooleanEngine(): BooleanEngine | undefined {
  return engine;
}

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

  // 优先走曲线级引擎（上层注入）：结果保留贝塞尔曲线，而不是折线近似。
  const paths: PathCommand[][] = [];
  for (const operand of operands) {
    const path = operandPath(document, operand, boxes);
    if (path?.length) paths.push(path);
  }
  if (paths.length < 2) return undefined;
  const active = getBooleanEngine();
  if (active) {
    const result = active.combine(paths, node.operation);
    if (result?.length) return result;
  }

  // 没装引擎（或引擎算不出来）：退回多边形近似。
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
 * 操作数 → 绝对坐标路径（保留曲线）。
 *
 * 矩形是四条直线，椭圆是四段三次贝塞尔（不用折线近似——那正是要消灭的近似）。
 */
function operandPath(document: DesignDocument, node: DesignNode, boxes: Record<NodeId, Box | undefined>): PathCommand[] | undefined {
  const box = boxes[node.id] ?? node.layout;
  switch (node.type) {
    case "rectangle":
      return rectanglePath(box);
    case "ellipse":
      return ellipsePath(box);
    case "vector": {
      if (!node.geometry) return undefined;
      return absolutePath(vectorPathCommands(node.geometry.d), box);
    }
    case "boolean":
      return computeBooleanPath(document, node, boxes);
    default:
      return undefined;
  }
}

/** 矩形的绝对坐标路径。 */
function rectanglePath(box: Box): PathCommand[] {
  return [
    { command: "M", point: { x: box.x, y: box.y } },
    { command: "L", point: { x: box.x + box.width, y: box.y } },
    { command: "L", point: { x: box.x + box.width, y: box.y + box.height } },
    { command: "L", point: { x: box.x, y: box.y + box.height } },
    { command: "Z" },
  ];
}

/** 用三次贝塞尔表示的圆弧系数（0.5522847498 ≈ 4/3·(√2−1)）。 */
const ELLIPSE_KAPPA = 0.5522847498307936;

/**
 * 椭圆的绝对坐标路径：四段三次贝塞尔。
 *
 * 一段 32 边的折线近似在视觉上几乎一样，但布尔运算的输入是曲线时，
 * 折线近似会把曲线边界变成锯齿——这正是本轮要消灭的问题。
 */
function ellipsePath(box: Box): PathCommand[] {
  const radiusX = box.width / 2;
  const radiusY = box.height / 2;
  const centerX = box.x + radiusX;
  const centerY = box.y + radiusY;
  const control = radiusX * ELLIPSE_KAPPA;
  const controlY = radiusY * ELLIPSE_KAPPA;
  return [
    { command: "M", point: { x: centerX + radiusX, y: centerY } },
    {
      command: "C",
      control1: { x: centerX + radiusX, y: centerY + controlY },
      control2: { x: centerX + control, y: centerY + radiusY },
      point: { x: centerX, y: centerY + radiusY },
    },
    {
      command: "C",
      control1: { x: centerX - control, y: centerY + radiusY },
      control2: { x: centerX - radiusX, y: centerY + controlY },
      point: { x: centerX - radiusX, y: centerY },
    },
    {
      command: "C",
      control1: { x: centerX - radiusX, y: centerY - controlY },
      control2: { x: centerX - control, y: centerY - radiusY },
      point: { x: centerX, y: centerY - radiusY },
    },
    {
      command: "C",
      control1: { x: centerX + control, y: centerY - radiusY },
      control2: { x: centerX + radiusX, y: centerY - controlY },
      point: { x: centerX + radiusX, y: centerY },
    },
    { command: "Z" },
  ];
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
