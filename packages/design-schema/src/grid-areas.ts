/**
 * 命名网格区域（CSS `grid-template-areas`）。
 *
 * 这里是**唯一**的解析入口：文档校验、布局求解、HTML 导出和属性面板都读同一份
 * 结果，因此「模板里有这个区域」「子节点落在哪一格」「导出写成什么」不会各算一套。
 *
 * 规则对齐 CSS Grid，但只保留能给出确定答案的部分：
 *
 * - 每个字符串是一行，以空白分列；所有行列数必须相同（ragged 模板没有确定语义）。
 * - `.` 表示空位；其余每个 token 是一个区域名。
 * - **同名单元格必须构成矩形**。CSS 遇到非矩形区域会整条声明作废，
 *   这里改成明确报错，免得用户以为「画出来了」。
 * - 区域名必须能安全地写进 CSS（`grid-area: 名字` 与带引号的模板字符串），
 *   所以拒绝引号、反斜杠、分号和点——它们在两种写法里都有特殊含义。
 *
 * 模板是可选字段，不参与文档格式版本：旧文档没有它，行为逐字不变。
 */

import type { GridCell, GridCellPlacement } from "./types";

/** 空位标记。 */
export const GRID_AREA_NULL = ".";

/** 解析后的一块命名区域。行列均为 1-based。 */
export interface GridAreaRect {
  name: string;
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

/** 模板问题的分类码。 */
export type GridAreaIssueCode =
  /** 模板一行都没有。 */
  | "empty-template"
  /** 某一行为空（只有空白）。 */
  | "empty-row"
  /** 各行列数不一致。 */
  | "ragged-rows"
  /** 区域名含 CSS 里有特殊含义的字符。 */
  | "invalid-name"
  /** 同名单元格没有构成矩形。 */
  | "non-rectangular";

/** 一条模板问题。 */
export interface GridAreaIssue {
  code: GridAreaIssueCode;
  message: string;
  /** 出错的行号（1-based）；模板整体问题没有行号。 */
  row?: number;
}

/** 模板解析结果。 */
export interface GridAreaTemplate {
  /** 列数；空模板为 0。 */
  columns: number;
  /** 行数。 */
  rows: number;
  /** 区域名 → 矩形；问题模板里只包含能确定矩形的区域。 */
  areas: Map<string, GridAreaRect>;
  issues: GridAreaIssue[];
}

/** 子节点最终落在的格子（行列 1-based，跨度为绝对数量）。 */
export interface GridCellRect {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
}

/** CSS 里不能当区域名的保留字。 */
const RESERVED_NAMES = new Set(["none", "span", "auto", "inherit", "initial", "unset", "revert", "revert-layer"]);

/**
 * 区域名能否安全地出现在 CSS 里。
 *
 * 允许非 ASCII（中文区域名设计上完全可用），只拦掉真正会破坏语法的字符。
 */
export function isValidGridAreaName(name: string): boolean {
  if (!name || name === GRID_AREA_NULL) return false;
  if (RESERVED_NAMES.has(name.toLowerCase())) return false;
  // eslint-disable-next-line no-control-regex
  return !/["'\\;{}.,\s\u0000-\u001f]/.test(name);
}

/** 把一行模板拆成 token。 */
function splitAreaRow(row: string): string[] {
  return row.trim().split(/\s+/).filter(Boolean);
}

/**
 * 解析命名区域模板。
 *
 * 解析是**总成功**的：问题写进 `issues`，调用方决定是拒绝（schema）还是提示（面板）。
 * 这样面板可以在用户打字打到一半时实时校验，而文档校验仍然是硬拒绝。
 */
export function parseGridAreaTemplate(rows: readonly string[]): GridAreaTemplate {
  const issues: GridAreaIssue[] = [];
  const areas = new Map<string, GridAreaRect>();

  if (!rows.length) {
    issues.push({ code: "empty-template", message: "Grid areas template is empty" });
    return { columns: 0, rows: 0, areas, issues };
  }

  const table: string[][] = [];
  rows.forEach((row, index) => {
    const tokens = splitAreaRow(row);
    if (!tokens.length) {
      issues.push({ code: "empty-row", message: `Grid areas row ${index + 1} is empty`, row: index + 1 });
    }
    table.push(tokens);
  });

  const columns = table[0]!.length;
  table.forEach((tokens, index) => {
    if (tokens.length && tokens.length !== columns) {
      issues.push({
        code: "ragged-rows",
        message: `Grid areas row ${index + 1} has ${tokens.length} columns, expected ${columns}`,
        row: index + 1,
      });
    }
    tokens.forEach(token => {
      if (token !== GRID_AREA_NULL && !isValidGridAreaName(token)) {
        issues.push({
          code: "invalid-name",
          message: `Grid area name "${token}" is not a valid CSS grid area name`,
          row: index + 1,
        });
      }
    });
  });
  if (issues.length && issues.some(issue => issue.code === "ragged-rows" || issue.code === "invalid-name")) {
    // 列数或名字都不确定时，矩形的边界同样不可信——不再往下推。
    return { columns, rows: rows.length, areas, issues };
  }

  // 先求每个名字的外接矩形。
  const bounds = new Map<string, { minRow: number; maxRow: number; minColumn: number; maxColumn: number; count: number }>();
  table.forEach((tokens, rowIndex) => {
    tokens.forEach((token, columnIndex) => {
      if (token === GRID_AREA_NULL) return;
      const current = bounds.get(token);
      if (!current) {
        bounds.set(token, {
          minRow: rowIndex,
          maxRow: rowIndex,
          minColumn: columnIndex,
          maxColumn: columnIndex,
          count: 1,
        });
        return;
      }
      current.minRow = Math.min(current.minRow, rowIndex);
      current.maxRow = Math.max(current.maxRow, rowIndex);
      current.minColumn = Math.min(current.minColumn, columnIndex);
      current.maxColumn = Math.max(current.maxColumn, columnIndex);
      current.count += 1;
    });
  });

  for (const [name, bound] of bounds) {
    const rowSpan = bound.maxRow - bound.minRow + 1;
    const columnSpan = bound.maxColumn - bound.minColumn + 1;
    // 矩形 = 外接矩形里的每一格都是它自己。
    if (bound.count !== rowSpan * columnSpan) {
      issues.push({
        code: "non-rectangular",
        message: `Grid area "${name}" does not form a rectangle`,
        row: bound.minRow + 1,
      });
      continue;
    }
    areas.set(name, {
      name,
      row: bound.minRow + 1,
      column: bound.minColumn + 1,
      rowSpan,
      columnSpan,
    });
  }

  issues.sort((left, right) => (left.row ?? 0) - (right.row ?? 0));
  return { columns, rows: rows.length, areas, issues };
}

/** 模板是否可以直接写进文档（没有阻断性问题）。 */
export function isUsableGridAreaTemplate(template: GridAreaTemplate): boolean {
  return template.issues.length === 0;
}

/**
 * 把「区域名 → 矩形」转回模板文本。
 *
 * 面板编辑用的是文本；从矩形反推只在需要生成默认模板时用到，
 * 因此这里按行还原成 `"a a"` 这样的字符串，空位补 `.`。
 */
export function gridAreaTemplateFromRects(rects: readonly GridAreaRect[], columns: number, rows: number): string[] {
  const table: string[][] = Array.from({ length: Math.max(0, rows) }, () =>
    Array.from({ length: Math.max(0, columns) }, () => GRID_AREA_NULL),
  );
  for (const rect of rects) {
    for (let row = rect.row; row < rect.row + rect.rowSpan; row++) {
      for (let column = rect.column; column < rect.column + rect.columnSpan; column++) {
        const line = table[row - 1];
        if (line) line[column - 1] = rect.name;
      }
    }
  }
  return table.map(line => line.join(" "));
}

/**
 * 解析子节点最终落在哪一格。
 *
 * - 直接给行列时原样返回（跨度缺省 1）。
 * - 给区域名时从模板里查；模板缺该区域或模板本身有错时返回 `undefined`——
 *   调用方要么跳过该子节点，要么退回顺序填充，**不会**猜一个格子出来。
 */
export function resolveGridCellRect(
  cell: GridCell,
  source?: readonly string[] | GridAreaTemplate,
): GridCellRect | undefined {
  if (cell.area !== undefined) {
    const template = source === undefined
      ? undefined
      : isGridAreaTemplate(source) ? source : parseGridAreaTemplate(source);
    const rect = template?.areas.get(cell.area);
    if (!rect) return undefined;
    return { row: rect.row, column: rect.column, rowSpan: rect.rowSpan, columnSpan: rect.columnSpan };
  }
  return {
    row: cell.row,
    column: cell.column,
    rowSpan: cell.rowSpan ?? 1,
    columnSpan: cell.columnSpan ?? 1,
  };
}

/** 判断一个值已经是解析结果还是原始模板行。 */
function isGridAreaTemplate(source: readonly string[] | GridAreaTemplate): source is GridAreaTemplate {
  return !Array.isArray(source) && "areas" in source && "issues" in source;
}

/** 子节点是否用命名区域定位（而不是行列号）。 */
export function isNamedGridCell(cell: GridCell): cell is Extract<GridCell, { area: string }> {
  return cell.area !== undefined;
}

/** 模板里所有区域名（按首次出现顺序）。 */
export function gridAreaNames(template: GridAreaTemplate): string[] {
  return [...template.areas.keys()];
}

/** 直接给行列的单元格（类型收窄的辅助）。 */
export function isPlacedGridCell(cell: GridCell): cell is GridCellPlacement {
  return cell.area === undefined;
}
