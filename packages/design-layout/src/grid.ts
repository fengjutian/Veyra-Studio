/**
 * Grid 布局求解。
 *
 * 语义对齐 Penpot 的 `common/src/app/common/geom/shapes/grid_layout/`，
 * 但**只借算法**：Penpot 的形状模型（`:points` + `:content` + `:position-data`）
 * 与本项目的归一化布局盒模型完全不同，见 `docs/figma-gap-roadmap.md`。
 *
 * 求解分四步：
 *
 * 1. **测轨道固有尺寸**：`fixed` 直接取；`auto` / `min-content` / `max-content`
 *    按落在该轨道上的子节点内容尺寸算；`fraction` 先不占固定空间。
 * 2. **分配剩余空间**：`fraction` 按权重分掉「可用尺寸 - 固定轨道总和 - gap 总和」。
 * 3. **定位子节点**：按单元格区间找到起点轨道与跨度轨道，累加得到原点与尺寸。
 * 4. **对齐**：子节点在格子里按 `align` 调整（`stretch` 时填满格子）。
 *
 * 一个刻意的简化：**不做自动轨道**（`auto-fill` / `auto-fit`）。
 * 它们依赖内容测量与反复迭代，收益低于复杂度；轨道由用户显式定义。
 */

import type { GridTrack } from "@ufira/design-schema";

/** 单条轨道的求解结果。 */
export interface ResolvedTrack {
  /** 轨道的起点偏移（相对容器内容区起点）。 */
  offset: number;
  /** 轨道的尺寸。 */
  size: number;
}

export interface GridSolveInput {
  /** 列轨道定义。 */
  columns: GridTrackInput[];
  /** 行轨道定义。 */
  rows: GridTrackInput[];
  columnGap: number;
  rowGap: number;
  /** 内容区可用宽高（已扣掉 padding）。 */
  availableWidth: number;
  availableHeight: number;
  /** 子节点占用的单元格。 */
  cells: GridCellInput[];
  /** 子节点在格子内的对齐。 */
  align: "start" | "center" | "end" | "stretch";
}

export interface GridTrackInput {
  type: "fixed" | "fraction" | "auto" | "min-content" | "max-content";
  size?: number;
  weight?: number;
  /**
   * 这条轨道上所有子节点的内容尺寸。
   *
   * 只有 `auto` / `min-content` / `max-content` 轨道用得上；
   * `fraction` 与 `fixed` 不看内容。
   */
  contentSizes?: { width: number; height: number }[];
}

export interface GridCellInput {
  /** 子节点 id。 */
  nodeId: string;
  /** 起始行（1-based）。 */
  row: number;
  /** 起始列（1-based）。 */
  column: number;
  rowSpan: number;
  columnSpan: number;
  /** 子节点自身声明的尺寸。 */
  width: number;
  height: number;
  /** 子节点在格子内的对齐；缺省用容器的 align。 */
  align?: "start" | "center" | "end" | "stretch";
}

export interface GridChildBox {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridSolveResult {
  /** 每个子节点的盒子，坐标相对容器内容区起点。 */
  children: GridChildBox[];
  /** 轨道总尺寸（不含 gap），用于 hug 容器的固有尺寸计算。 */
  columnsWidth: number;
  rowsHeight: number;
  /** 轨道总尺寸 + gap 总和。 */
  totalWidth: number;
  totalHeight: number;
  /** 轨道放不下时的溢出量（正数表示超出）。 */
  overflowWidth: number;
  overflowHeight: number;
}

/**
 * 求解一条轴上的轨道。
 *
 * @param axis "x" 表示列轨道（宽度方向），"y" 表示行轨道（高度方向）。
 */
function solveTracks(axis: "x" | "y", tracks: GridTrackInput[], gap: number, available: number): { tracks: ResolvedTrack[]; overflow: number } {
  const sizeOf = (content: { width: number; height: number } | undefined): number =>
    axis === "x" ? (content?.width ?? 0) : (content?.height ?? 0);

  // 第一步：固有尺寸。
  const intrinsic = tracks.map((track): number => {
    if (track.type === "fixed") return Math.max(0, track.size ?? 0);
    if (track.type === "fraction") return 0;
    const contents = (track.contentSizes ?? []).map(sizeOf);
    if (!contents.length) return 0;
    if (track.type === "min-content") return Math.min(...contents);
    if (track.type === "max-content") return Math.max(...contents);
    // auto：内容尺寸的加权平均不太有物理意义，取最大——否则子节点会被裁掉。
    return Math.max(...contents);
  });

  const gaps = Math.max(0, tracks.length - 1) * gap;
  const fixedTotal = intrinsic.reduce((sum, size) => sum + size, 0);

  // 第二步：分配剩余空间给 fraction 轨道。
  const fractionIndexes = tracks.map((track, index) => (track.type === "fraction" ? index : -1)).filter(index => index >= 0);
  const weightTotal = fractionIndexes.reduce((sum, index) => sum + Math.max(0, tracks[index]!.weight ?? 1), 0);
  const remainder = Math.max(0, available - fixedTotal - gaps);

  const sizes = intrinsic.slice();
  if (fractionIndexes.length) {
    if (weightTotal > 0) {
      let handed = 0;
      fractionIndexes.forEach((index, order) => {
        const weight = Math.max(0, tracks[index]!.weight ?? 1);
        // 最后一条 fraction 轨道吃掉舍入误差，避免几条轨道加起来比可用空间少 1px。
        const share = order === fractionIndexes.length - 1
          ? Math.max(0, remainder - handed)
          : (remainder * weight) / weightTotal;
        sizes[index] = share;
        handed += share;
      });
    } else {
      // 权重全为 0：均分，否则这些轨道永远分不到空间。
      const each = remainder / fractionIndexes.length;
      fractionIndexes.forEach(index => { sizes[index] = each; });
    }
  }

  // 第三步：算起点偏移。
  const resolved: ResolvedTrack[] = [];
  let cursor = 0;
  tracks.forEach((_, index) => {
    resolved.push({ offset: cursor, size: sizes[index]! });
    cursor += sizes[index]! + gap;
  });

  const total = resolved.reduce((sum, track) => sum + track.size, 0) + gaps;
  return { tracks: resolved, overflow: Math.max(0, total - available) };
}

/** 盒内对齐：把内容按对齐方式放进可用空间。 */
function alignOffset(align: "start" | "center" | "end" | "stretch", available: number, size: number): number {
  if (align === "center") return (available - size) / 2;
  if (align === "end") return available - size;
  return 0;
}

/**
 * 求解 Grid 布局。
 *
 * 返回的坐标相对**容器内容区起点**（已扣掉 padding）——
 * 调用方负责加上内容区原点。
 */
export function solveGrid(input: GridSolveInput): GridSolveResult {
  const columns = solveTracks("x", input.columns, input.columnGap, input.availableWidth);
  const rows = solveTracks("y", input.rows, input.rowGap, input.availableHeight);

  const children: GridChildBox[] = [];

  for (const cell of input.cells) {
    // 越界的单元格按最后一格处理：格子不存在时静默跳过会让子节点消失，
    // 落在最后至少还看得见。
    if (!input.columns.length || !input.rows.length) continue;
    const columnIndex = Math.min(Math.max(0, cell.column - 1), input.columns.length - 1);
    const rowIndex = Math.min(Math.max(0, cell.row - 1), input.rows.length - 1);

    const columnSpan = Math.max(1, cell.columnSpan);
    const rowSpan = Math.max(1, cell.rowSpan);

    const startColumn = columns.tracks[columnIndex]!;
    const startRow = rows.tracks[rowIndex]!;

    // 跨度区间的终点：越过轨道末尾时按末尾算。
    const endColumnIndex = Math.min(columnIndex + columnSpan - 1, input.columns.length - 1);
    const endRowIndex = Math.min(rowIndex + rowSpan - 1, input.rows.length - 1);
    const endColumn = columns.tracks[endColumnIndex]!;
    const endRow = rows.tracks[endRowIndex]!;

    const cellWidth = endColumn.offset + endColumn.size - startColumn.offset;
    const cellHeight = endRow.offset + endRow.size - startRow.offset;

    const align = cell.align ?? input.align;

    // 尺寸：stretch 时填满格子；否则用子节点自己的声明尺寸。
    const width = align === "stretch" ? cellWidth : cell.width;
    const height = align === "stretch" ? cellHeight : cell.height;

    children.push({
      nodeId: cell.nodeId,
      x: startColumn.offset + alignOffset(align, cellWidth, width),
      y: startRow.offset + alignOffset(align, cellHeight, height),
      width,
      height,
    });
  }

  const columnsWidth = columns.tracks.reduce((sum, track) => sum + track.size, 0);
  const rowsHeight = rows.tracks.reduce((sum, track) => sum + track.size, 0);

  return {
    children,
    columnsWidth,
    rowsHeight,
    totalWidth: columnsWidth + Math.max(0, input.columns.length - 1) * input.columnGap,
    totalHeight: rowsHeight + Math.max(0, input.rows.length - 1) * input.rowGap,
    overflowWidth: columns.overflow,
    overflowHeight: rows.overflow,
  };
}

/**
 * 按顺序把子节点填进格子（没有显式 `cells` 时的缺省行为）。
 *
 * 从左上开始，先按行填满——这是最符合直觉的缺省排布。
 *
 * 轨道不够时**不钳位**：多出来的子节点会落到后面的行/列，
 * 由 {@link ensureTracks} 补出隐式轨道（CSS Grid 的隐式行/列语义）。
 * 钳到最后一个格子会让两个子节点重叠——重叠比超出更难排查。
 */
export function assignCellsByOrder(nodeIds: string[], columns: number): GridCellInput[] {
  const cells: GridCellInput[] = [];
  const columnCount = Math.max(1, columns);
  nodeIds.forEach((nodeId, index) => {
    const row = Math.floor(index / columnCount) + 1;
    const column = (index % columnCount) + 1;
    cells.push({
      nodeId,
      row,
      column,
      rowSpan: 1,
      columnSpan: 1,
      width: 0,
      height: 0,
    });
  });
  return cells;
}

/**
 * 补出隐式轨道：子节点占用的行列超出已声明的轨道数时，在末尾追加 `auto` 轨道。
 *
 * 这与 CSS Grid 的隐式行/列一致——多出来的子节点撑出新的一行，
 * 而不是被钳回最后一格造成重叠。
 */
export function ensureTracks(tracks: GridTrack[], cells: GridCellInput[], axis: "columns" | "rows"): GridTrack[] {
  const limit = cells.reduce((max, cell) => {
    const span = axis === "columns" ? (cell.columnSpan ?? 1) : (cell.rowSpan ?? 1);
    const start = axis === "columns" ? cell.column : cell.row;
    return Math.max(max, start + span - 1);
  }, 0);

  if (limit <= tracks.length) return tracks;
  const extended = tracks.slice();
  while (extended.length < limit) extended.push({ type: "auto" });
  return extended;
}
