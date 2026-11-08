import * as raw from "polygon-clipping";

/**
 * `polygon-clipping` 的模块形状适配。
 *
 * 它的类型声明（`declare module`）写的是具名导出，但实际产物（ESM 与 CJS 两个构建）
 * 都只导出**默认对象** `{ union, intersection, xor, difference }`。直接 `import { union }`
 * 在 Node 里会拿到 undefined、在别的打包器里也可能拿到不同的 interop 形状，
 * 所以这里两种形状都兼容一次，业务代码只看到稳定的一份。
 */
export type ClipPair = [number, number];
export type ClipRing = ClipPair[];
export type ClipPolygon = ClipRing[];
export type ClipMultiPolygon = ClipPolygon[];

interface Clipping {
  union(geom: ClipPolygon, ...geoms: ClipPolygon[]): ClipMultiPolygon;
  intersection(geom: ClipPolygon, ...geoms: ClipPolygon[]): ClipMultiPolygon;
  xor(geom: ClipPolygon, ...geoms: ClipPolygon[]): ClipMultiPolygon;
  difference(geom: ClipPolygon, ...geoms: ClipPolygon[]): ClipMultiPolygon;
}

const clipping = ((raw as unknown as { default?: Clipping }).default ?? raw) as unknown as Clipping;

export const clipUnion = clipping.union;
export const clipIntersection = clipping.intersection;
export const clipXor = clipping.xor;
export const clipDifference = clipping.difference;
