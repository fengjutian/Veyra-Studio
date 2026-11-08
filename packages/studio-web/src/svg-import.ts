/**
 * SVG path data → 本项目的 `vector` 节点几何。
 *
 * 这一层做的是**格式转换**，不是几何计算：
 * `parseSvgPath` 产出绝对坐标的 `PathCommand[]`，这里把它归一化成
 * `[0,1]` 相对路径，让 `vector.geometry` 的不变式（改宽高即缩放图形）继续成立。
 *
 * 语义参考 Penpot 的 SVG 导入路径，见 `docs/penpot-porting.md`。
 */

import {
  normalizePath,
  parseSvgPath,
  pathBounds,
  pathDataFromCommands,
  type PathCommand,
  type VectorGeometry,
} from "@ufira/design-schema";

export interface SvgPathImportResult {
  /** 归一化路径数据，可直接作为 `vector.geometry.d`。 */
  d: string;
  /**
   * 路径包围盒的宽高，**单位与源坐标一致**（已按 `scale` 换算）。
   *
   * 注意这不是归一化值——归一化后的路径恒定占满整个盒子，
   * 原始尺寸要靠这两个字段才能还原成像素布局盒。
   */
  width: number;
  height: number;
}

export interface SvgPathImportOptions {
  /**
   * 缩放系数：SVG path data 常常带自己的 viewBox 尺度，导入时需要换算。
   * 不传则按原始坐标导入。
   */
  scale?: number;
  /**
   * 平移量（缩放之后叠加）。
   */
  offsetX?: number;
  offsetY?: number;
}

/**
 * 把 SVG path data 导入成归一化的 `vector.geometry`。
 *
 * 解析失败或路径为空时返回 `undefined`——**不做部分导入**：
 * 一条被截断的路径画出来的东西和原意完全不同，比明确失败更危险。
 */
export function importSvgPathGeometry(d: string, options: SvgPathImportOptions = {}): SvgPathImportResult | undefined {
  const commands = parseSvgPath(d, {
    scale: options.scale,
    offset: { x: options.offsetX ?? 0, y: options.offsetY ?? 0 },
  });
  if (!commands || !commands.length) return undefined;

  // 包围盒取离散化后的紧包围盒：向外鼓的弧因此落在盒内，
  // 不会因为「盒子不含图形」而在画布上被裁掉（与钢笔路径的处理一致）。
  const bounds = pathBounds(commands);
  if (!bounds) return undefined;

  const width = bounds.width || 1;
  const height = bounds.height || 1;

  const normalized = normalizePath(commands, {
    x: bounds.x,
    y: bounds.y,
    width,
    height,
  });

  const pathData = pathDataFromCommands(normalized);
  if (!pathData) return undefined;

  return { d: pathData, width, height };
}

/**
 * 把 SVG path data 导入成 `vector` 节点的几何与布局盒。
 *
 * 返回的 `box` 是**像素尺寸**的布局盒（`width`/`height` 是路径自身的包围盒，
 * 乘以 `scale` 后得到实际像素），`geometry` 里存归一化路径。
 */
export function importSvgPathVector(
  d: string,
  options: SvgPathImportOptions = {},
): { box: { width: number; height: number }; geometry: VectorGeometry } | undefined {
  // 缩放直接交给解析层：归一化与缩放无关（除以包围盒后抵消），
  // 而包围盒宽高已经是缩放后的像素值。
  const result = importSvgPathGeometry(d, options);
  if (!result) return undefined;

  return {
    box: { width: result.width, height: result.height },
    geometry: { kind: "path", d: result.d },
  };
}

/**
 * 判断一段 path data 是否可导入（用于 UI 的即时反馈）。
 */
export function canImportSvgPath(d: string): boolean {
  const commands: PathCommand[] | undefined = parseSvgPath(d);
  return Boolean(commands && commands.length);
}
