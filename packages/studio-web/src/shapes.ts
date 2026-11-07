import { pathDataFromCommands, regularPolygonPathData, starPathData, type VectorGeometry } from "@ufira/design-schema";
import { rectFromPoints } from "./renderer/marquee";
import type { HitPoint } from "./renderer/hit-test";
import type { Rect } from "./renderer/selection";
import type { VectorToolId } from "./tools";

/**
 * 直线 / 多边形 / 星形的几何构建。
 *
 * 三者都是 `vector` 节点 + 一段归一化路径，不新增节点类型：形状数量不该让文档模型
 * 线性膨胀，否则复制粘贴、导出、命中每处都要多一个分支。
 *
 * 路径坐标是 [0,1] 的相对坐标，所以改节点宽高就等于缩放图形——不需要重写 `d`。
 */
export interface VectorShape {
  box: Rect;
  geometry: VectorGeometry;
}

/** 直线节点的最小厚度：水平/垂直线否则会得到 0 高度的盒子，命中测试直接判空。 */
export const LINE_MIN_THICKNESS = 1;

/** 多边形与星形的默认顶点数。 */
export const POLYGON_SIDES = 6;
export const STAR_POINTS = 5;

export function buildVectorShape(tool: VectorToolId, start: HitPoint, end: HitPoint): VectorShape {
  if (tool === "line") return lineShape(start, end);
  const box = rectFromPoints(start, end);
  return {
    box,
    geometry: { kind: "path", d: tool === "polygon" ? regularPolygonPathData(POLYGON_SIDES) : starPathData(STAR_POINTS) },
  };
}

/**
 * 直线：盒子取两点包围盒，任一边为 0 时撑到 1px 并以线段为中心。
 *
 * 撑厚度会把盒子稍微放大，归一化坐标因此要用放大后的盒子重新算，否则线会偏半个像素。
 */
function lineShape(start: HitPoint, end: HitPoint): VectorShape {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const width = Math.max(right - left, LINE_MIN_THICKNESS);
  const height = Math.max(bottom - top, LINE_MIN_THICKNESS);
  const box: Rect = {
    x: (left + right) / 2 - width / 2,
    y: (top + bottom) / 2 - height / 2,
    width,
    height,
  };
  const d = pathDataFromCommands([
    { command: "M", point: normalize(start, box) },
    { command: "L", point: normalize(end, box) },
  ]);
  return { box, geometry: { kind: "path", d } };
}

function normalize(point: HitPoint, box: Rect): HitPoint {
  return {
    x: clamp01((point.x - box.x) / box.width),
    y: clamp01((point.y - box.y) / box.height),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
