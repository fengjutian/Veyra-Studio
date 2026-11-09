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

/* ------------------------------------------------------------------------ *
 * 轨道编辑（Track editing）
 *
 * 上面的求解器回答的是「按声明怎么排」；这里回答的是「编辑期怎么算宽度、
 * 怎么改声明」。两者共用同一套轨道语义（`GridTrack` 的五种类型、
 * `fixed` / `fraction` 的分配口径），差别只在**放不下时怎么办**：
 *
 * - 求解器**不夹紧**，如实上报 `overflowWidth` / `overflowHeight`——画布上看到
 *   溢出是**事实**，不能被善意改写。
 * - 轨道编辑**夹紧**，把宽度收到最小宽度为止——编辑器要始终放得下，
 *   让用户看见结果。
 *
 * 规格见 `docs/grid-layout.md`。
 * ------------------------------------------------------------------------ */

/**
 * 轨道最小宽度（px）。
 *
 * 再窄的轨道既点不中也画不清——24px 是「还能看见、还能拖」的底线。
 */
export const MIN_GRID_TRACK_WIDTH = 24;

/**
 * 内容轨道：宽度由内容决定（`auto` / `min-content` / `max-content`）。
 *
 * 内容轨道**不能直接拖拽改宽度**——它没有可写回的像素尺寸，
 * 宽度是内容与剩余空间共同决定的。
 */
export function isContentGridTrack(track: GridTrack): boolean {
  return track.type === "auto" || track.type === "min-content" || track.type === "max-content";
}

/**
 * 轨道类型能否被直接拖拽调整宽度。
 *
 * `fixed` 有像素、`fraction` 有权重，两者都能反解出目标宽度；
 * 内容轨道不行。
 */
export function isResizableGridTrack(track: GridTrack): boolean {
  return track.type === "fixed" || track.type === "fraction";
}

/** 轨道基准宽度（固有尺寸）的计算参数。 */
export interface GridTrackBaseOptions {
  /** 轨道最小宽度；缺省 {@link MIN_GRID_TRACK_WIDTH}。 */
  minWidth?: number;
  /** 内容轨道的实测宽度（与轨道顺序对齐）；缺项按 minWidth 估算。 */
  contentWidths?: (number | undefined)[];
}

/**
 * 每条轨道的基准宽度（固有尺寸）。
 *
 * - `fixed` → 声明的像素尺寸；
 * - `fraction` → 0（弹性轨道，先不占位，稍后按权重瓜分剩余空间）；
 * - 内容轨道 → 实测宽度；没有实测值时按最小宽度估算。
 */
export function gridTrackBaseWidths(tracks: GridTrack[], options: GridTrackBaseOptions = {}): number[] {
  const minWidth = Math.max(0, options.minWidth ?? MIN_GRID_TRACK_WIDTH);
  return tracks.map((track, index) => {
    if (track.type === "fixed") return Math.max(0, track.size);
    if (track.type === "fraction") return 0;
    // 自动重复轨道在编辑期只显示一条最小宽度的占位：真实条数由容器宽度决定，
    // 展开由求解器在布局时完成（`expandRepeatTracks`）。
    if (track.type === "repeat") return Math.max(minWidth, track.min);
    return Math.max(minWidth, options.contentWidths?.[index] ?? minWidth);
  });
}

/** 轨道宽度解析的参数。 */
export interface GridTrackWidthOptions extends GridTrackBaseOptions {
  /** 轨道之间的间隙（px）。 */
  gap: number;
  /**
   * 容器内容区宽度（**含**间隙占位，与 `solveTracks` 的 `available` 同义）。
   */
  availableWidth: number;
  /**
   * 被钉住的轨道下标：收缩时不会低于它当前的基准宽度。
   *
   * 用于「用户正在拖的那条轨道」——它必须守住用户给的尺寸，
   * 差额由其它轨道承担。
   */
  pinnedIndex?: number;
}

/** 轨道宽度解析的结果。 */
export interface GridTrackWidthResult {
  /** 每条轨道的像素宽度。 */
  widths: number[];
  /** 轨道占位之外的剩余空间（正数表示容器还有空余）。 */
  slack: number;
  /** 放不下时的溢出量（正数表示超出）。 */
  overflow: number;
}

/**
 * 把轨道声明解析成像素宽度。
 *
 * 规则（与 `solveTracks` 同源，多了「放不下就夹紧」）：
 *
 * 1. 基准宽度：`fixed` 取尺寸、`fraction` 取 0、内容轨道取实测宽度（缺省按最小宽估算）。
 * 2. 剩余空间 ≥ 0 → `fraction` 按权重瓜分；没有 `fraction` 时内容轨道平分
 *    （CSS `auto` 轨道的拉伸行为）；全是 `fixed` 时剩余空间成为空余。
 * 3. 剩余空间 < 0 → 按「内容轨道 → 固定轨道」的顺序等比收缩，每条最多收到最小宽度。
 */
export function resolveGridTrackWidths(tracks: GridTrack[], options: GridTrackWidthOptions): GridTrackWidthResult {
  const count = tracks.length;
  const gap = Math.max(0, options.gap);
  const minWidth = Math.max(0, options.minWidth ?? MIN_GRID_TRACK_WIDTH);
  if (!count) return { widths: [], slack: Math.max(0, options.availableWidth), overflow: 0 };

  const gaps = (count - 1) * gap;
  const space = Math.max(0, options.availableWidth - gaps);
  const widths = gridTrackBaseWidths(tracks, { minWidth, contentWidths: options.contentWidths });

  // 收缩下限：默认是最小宽度；被钉住的轨道以它自己的基准宽度为下限。
  const floors = widths.map((width, index) => (index === options.pinnedIndex ? width : minWidth));

  const fractionIndexes: number[] = [];
  const contentIndexes: number[] = [];
  const fixedIndexes: number[] = [];
  tracks.forEach((track, index) => {
    if (track.type === "fraction") fractionIndexes.push(index);
    else if (isContentGridTrack(track)) contentIndexes.push(index);
    else fixedIndexes.push(index);
  });

  const baseTotal = widths.reduce((sum, size) => sum + size, 0);
  const free = space - baseTotal;

  if (free >= 0) {
    if (fractionIndexes.length) {
      const weights = fractionIndexes.map(index => {
        const track = tracks[index];
        return track && track.type === "fraction" ? Math.max(0, track.weight) : 0;
      });
      const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
      let handed = 0;
      fractionIndexes.forEach((index, order) => {
        // 最后一条 fraction 轨道吃掉舍入误差，避免几条轨道加起来比可用空间少 1px。
        const share = order === fractionIndexes.length - 1 || weightTotal <= 0
          ? Math.max(0, free - handed)
          : (free * weights[order]) / weightTotal;
        widths[index] = share;
        handed += share;
      });
    } else if (contentIndexes.length) {
      // 没有 fraction 时内容轨道平分剩余空间（CSS `auto` 轨道的拉伸行为）。
      const each = free / contentIndexes.length;
      contentIndexes.forEach(index => { widths[index] += each; });
    }
  } else {
    // 放不下：内容轨道先让，固定轨道后让，每条最多收到下限。
    const remaining = shrinkGridTracks(widths, contentIndexes, -free, floors);
    shrinkGridTracks(widths, fixedIndexes, remaining, floors);
  }

  const total = widths.reduce((sum, size) => sum + size, 0);
  return { widths, slack: Math.max(0, space - total), overflow: Math.max(0, total - space) };
}

/**
 * 等比收缩一组轨道，返回没能收掉的差额。
 *
 * 每条轨道最多收到自己的下限；触底的轨道退出本轮，
 * 剩下的差额由还站得住的轨道继续承担（water-filling）。
 */
function shrinkGridTracks(widths: number[], indexes: number[], deficit: number, floors: number[]): number {
  let remaining = deficit;
  for (let pass = 0; pass < indexes.length && remaining > 1e-9; pass++) {
    const active = indexes.filter(index => widths[index] - floors[index] > 1e-9);
    if (!active.length) break;
    const weightTotal = active.reduce((sum, index) => sum + widths[index], 0);
    if (weightTotal <= 1e-9) break;
    let handed = 0;
    for (const index of active) {
      // 份额按本轮开始时的剩余缺口算：谁触底谁退出，缺口由下一轮补上。
      const share = (remaining * widths[index]) / weightTotal;
      const take = Math.min(share, widths[index] - floors[index]);
      widths[index] -= take;
      handed += take;
    }
    remaining -= handed;
    if (handed <= 1e-9) break;
  }
  return remaining;
}

/** 把像素宽度写回轨道声明时的参数。 */
export interface GridTrackApplyOptions extends GridTrackBaseOptions {
  /** 轨道之间的间隙（px）。 */
  gap: number;
  /** 容器内容区宽度（含间隙占位）。 */
  availableWidth: number;
}

/**
 * 把解析出来的像素宽度写回轨道声明。
 *
 * - `fixed` → `size` = 宽度；
 * - `fraction` → 权重与目标宽度成正比（`fraction` 轨道只有比例关系有意义）；
 * - 内容轨道 → **原样保留**：它的宽度由内容决定，没有可写回的尺寸。
 *
 * 只有当 `fraction` 轨道正好吃掉了全部剩余空间时宽度才能反解成权重；
 * 否则（空间不够、轨道被压到 0）保留原权重。
 */
export function applyGridTrackWidths(tracks: GridTrack[], widths: number[], options: GridTrackApplyOptions): GridTrack[] {
  const count = tracks.length;
  if (!count) return [];
  const gap = Math.max(0, options.gap);
  const gaps = (count - 1) * gap;
  const space = Math.max(0, options.availableWidth - gaps);
  const bases = gridTrackBaseWidths(tracks, { minWidth: options.minWidth, contentWidths: options.contentWidths });
  const baseTotal = bases.reduce((sum, size) => sum + size, 0);
  const freeSpace = space - baseTotal;

  const fractionIndexes: number[] = [];
  tracks.forEach((track, index) => { if (track.type === "fraction") fractionIndexes.push(index); });
  const fractionWidth = fractionIndexes.reduce((sum, index) => sum + Math.max(0, widths[index] ?? 0), 0);
  const weightTotal = fractionIndexes.reduce((sum, index) => {
    const track = tracks[index];
    return sum + (track && track.type === "fraction" ? Math.max(0, track.weight) : 0);
  }, 0);
  const solvable = fractionIndexes.length > 0
    && fractionWidth > 1e-9
    && freeSpace > 1e-9
    && Math.abs(fractionWidth - freeSpace) <= 1e-6;

  return tracks.map((track, index) => {
    if (track.type === "fixed") return { type: "fixed", size: Math.max(0, round2(widths[index] ?? 0)) };
    if (track.type === "fraction") {
      if (!solvable) return track;
      const weight = ((widths[index] ?? 0) * weightTotal) / freeSpace;
      return { type: "fraction", weight: Math.max(0.001, round3(weight)) };
    }
    return track;
  });
}

/** 保留两位小数。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 保留三位小数。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
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

/* ------------------------------------------------------------------------ *
 * 自动重复轨道（`repeat(auto-fill|auto-fit, …)`）
 *
 * CSS 的 `repeat()` 在布局时才展开成具体条数，这里同样在求解前展开。
 * 展开放在求解器**之前**而不是求解器内部，是因为条数取决于「可用尺寸」，
 * 而求解器拿到的已经是轨道声明；让求解器认识 repeat 会把它变成两件事。
 *
 * 展开后的轨道只有 `fixed` 与 `fraction` 两种：
 * - `grow: false` → 每条 `fixed(min)`；
 * - `grow: true`  → 每条 `fraction(1)`，剩余空间在轨道之间均分
 *   （对应 `minmax(min, 1fr)`）。
 *
 * 已知退化：`hug` 容器的可用尺寸由内容决定，而内容又由轨道数决定——
 * 这个循环没有不动点。此时**只展开一条**并上报 `degraded`，由调用方给警告。
 * ------------------------------------------------------------------------ */

/**
 * 自动重复轨道的条数上限。
 *
 * 与属性面板的轨道数上限一致：再多的轨道既画不清也没法编辑，
 * 而且 1px 级的容器宽度抖动会让条数在临界点反复跳变。
 */
export const MAX_AUTO_REPEAT_TRACKS = 24;

/** 展开自动重复轨道的参数。 */
export interface ExpandRepeatTrackOptions {
  /**
   * 该轴的可用尺寸（内容区，含间隙占位）。
   *
   * `undefined` 表示尺寸未知（hug 容器）：只能退化成一条。
   */
  available: number | undefined;
  /** 轨道之间的间隙。 */
  gap: number;
  /** 该轴上预计要放的子节点数；`auto-fit` 用它收起多余的空轨道。 */
  itemCount: number;
}

/** 展开结果。 */
export interface ExpandRepeatTrackResult {
  /** 展开后的轨道声明；没有 `repeat` 时原样返回。 */
  tracks: GridTrack[];
  /** 是否有 `repeat` 轨道因为可用尺寸未知而退化成一条。 */
  degraded: boolean;
}

/**
 * 把自动重复轨道展开成具体的固定/比例轨道。
 *
 * 条数公式与 CSS 一致：`n` 条轨道 + `n-1` 个间隙 ≤ 可用尺寸
 * → `n = ⌊(available + gap) ÷ (min + gap)⌋`，至少 1 条。
 */
export function expandRepeatTracks(tracks: GridTrack[], options: ExpandRepeatTrackOptions): ExpandRepeatTrackResult {
  if (!tracks.some(track => track.type === "repeat")) return { tracks, degraded: false };

  const gap = Math.max(0, options.gap);
  const expanded: GridTrack[] = [];
  let degraded = false;

  // 条数不是「整条容器 ÷ 最小宽度」，而是先扣掉同一轴上其它轨道占掉的尺寸
  // （与 CSS 一致）：`[fixed 200, repeat(min 100)]` 在 400px 里只能放 2 条。
  const others = tracks.filter(track => track.type !== "repeat");
  const othersBase = others.reduce((sum, track) => sum + (track.type === "fixed" ? Math.max(0, track.size) : 0), 0);
  const othersGaps = others.length * gap;

  for (const track of tracks) {
    if (track.type !== "repeat") {
      expanded.push(track);
      continue;
    }
    const min = Math.max(1, track.min);
    let count = 1;
    if (options.available === undefined) {
      degraded = true;
    } else {
      const room = Math.max(0, options.available - othersBase - othersGaps + gap);
      count = Math.floor(room / (min + gap));
      count = Math.min(Math.max(1, count), MAX_AUTO_REPEAT_TRACKS);
    }
    // auto-fit 把空轨道收起来：条数不超过这一轴上的子节点数，
    // 剩下的空间才会被现有轨道吃满（auto-fill 会留下空轨道）。
    if (track.mode === "auto-fit") count = Math.min(count, Math.max(1, Math.floor(options.itemCount)));

    // 尺寸未知时没有「剩余空间」可均分，退化成固定最小宽度；
    // 否则 hug 容器会因为 fraction 轨道分到 0 而塌成 0 宽。
    const grow = Boolean(track.grow) && options.available !== undefined;
    for (let index = 0; index < count; index++) {
      expanded.push(grow ? { type: "fraction", weight: 1 } : { type: "fixed", size: min });
    }
  }

  return { tracks: expanded, degraded };
}
