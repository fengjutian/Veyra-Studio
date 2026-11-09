/**
 * Grid 命名区域的编辑期模型。
 *
 * 规格见 `docs/grid-layout.md`。
 *
 * 与 `grid-track-model.ts` 一样，这里**只有纯函数**：没有 DOM、没有 React。
 * 解析与矩形判定复用 `@ufira/design-schema` 的 `parseGridAreaTemplate()`，
 * 因此属性面板看到的区域、文档校验接受的区域、画布排出的区域是同一份结果。
 *
 * 编辑期只多做两件事：
 *
 * 1. 把文本域里的多行模板翻译成 `GridSpec.areas`，并把引用了已删除区域的
 *    `cells` 条目退回顺序填充——否则保存会撞上文档校验，或者子节点直接不排版。
 * 2. 轨道数变化时把模板「固化」成行列号再丢掉模板：区域画在第 3 列、
 *    轨道只剩 2 条时没有确定语义，与其静默错位，不如把当时的位置固定下来。
 */

import {
  parseGridAreaTemplate,
  resolveGridCellRect,
  type GridCell,
  type GridCellPlacement,
  type GridSpec,
  type NodeId,
} from "@ufira/design-schema";

/** 一条模板诊断。 */
export interface GridAreaIssue {
  code: string;
  message: string;
}

/** 把模板文本应用回 Grid 配置的结果。 */
export interface GridAreaDraftResult {
  /** 模板是否可提交。 */
  ok: boolean;
  /** 规范化后的模板；`undefined` 表示清空模板（不写这个字段）。 */
  areas: string[] | undefined;
  /** 处理过失效区域之后的 cells。 */
  cells: Record<NodeId, GridCell>;
  issues: GridAreaIssue[];
  /** 因为引用的区域被删除、或原本没有格子而退回顺序填充的子节点。 */
  reassigned: NodeId[];
}

/** 轨道数变化后的区域处理结果。 */
export interface GridAreaReconcileResult {
  /** 保留（或清空）的模板；`undefined` 表示没有模板。 */
  areas: string[] | undefined;
  cells: Record<NodeId, GridCell>;
  /** 是否因为模板与新轨道数对不上而丢掉了模板。 */
  dropped: boolean;
}

/**
 * 模板文本 → 行数组。
 *
 * 末尾的空行是「多敲了一个回车」，不算错；行内多余空白由解析器处理。
 */
export function splitGridAreaText(text: string): string[] {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

/** 行数组 → 模板文本（属性面板的文本域用）。 */
export function formatGridAreaText(rows: readonly string[] | undefined): string {
  return (rows ?? []).join("\n");
}

/** 模板行里的区域名（按首次出现顺序），供下拉框使用。 */
export function gridAreaTemplateNames(rows: readonly string[] | undefined): string[] {
  if (!rows?.length) return [];
  return [...parseGridAreaTemplate(rows).areas.keys()];
}

/**
 * 校验模板文本能否应用到当前网格。
 *
 * 除了模板本身的问题，还检查行列数与轨道数是否一致——模板画在轨道之外时
 * 「多出来的那一列」存不存在只能靠猜。
 */
export function checkGridAreaText(text: string, grid: Pick<GridSpec, "columns" | "rows">): GridAreaIssue[] {
  const lines = splitGridAreaText(text);
  if (!lines.length) return [];
  const template = parseGridAreaTemplate(lines);
  const issues: GridAreaIssue[] = template.issues.map(issue => ({ code: issue.code, message: issue.message }));
  if (template.columns && template.columns !== grid.columns.length) {
    issues.push({
      code: "column-mismatch",
      message: `模板有 ${template.columns} 列，但列轨道有 ${grid.columns.length} 条`,
    });
  }
  if (template.rows && template.rows !== grid.rows.length) {
    issues.push({
      code: "row-mismatch",
      message: `模板有 ${template.rows} 行，但行轨道有 ${grid.rows.length} 条`,
    });
  }
  return issues;
}

/**
 * 把模板文本应用回网格。
 *
 * 成功时返回规范化后的 `areas` 与处理过失效区域的 `cells`
 * （引用了不存在区域的子节点退回顺序填充，并记进 `reassigned`）；
 * 失败时原样返回，调用方不应提交——半套模板比没有模板更难排查。
 */
export function applyGridAreaText(
  text: string,
  grid: Pick<GridSpec, "columns" | "rows">,
  cells: Record<NodeId, GridCell> | undefined,
  childIds: readonly NodeId[] = [],
): GridAreaDraftResult {
  const lines = splitGridAreaText(text);
  const current = cells ?? {};

  if (!lines.length) {
    const { cells: next, reassigned } = reassignOrphans(current, undefined, childIds, grid.columns.length);
    return { ok: true, areas: undefined, cells: next, issues: [], reassigned };
  }

  const issues = checkGridAreaText(text, grid);
  if (issues.length) return { ok: false, areas: undefined, cells: current, issues, reassigned: [] };

  const template = parseGridAreaTemplate(lines);
  const { cells: resolved, reassigned } = reassignOrphans(current, template, childIds, grid.columns.length);
  // 有了模板之后，显式 cells 模式下「没有条目的子节点」完全不排版。
  // 模板刚生效时把漏掉的子节点按顺序放进去，避免它们凭空消失。
  const next = { ...resolved };
  childIds.forEach((nodeId, index) => {
    if (next[nodeId]) return;
    next[nodeId] = defaultGridCellForIndex(index, grid.columns.length);
    reassigned.push(nodeId);
  });
  return {
    ok: true,
    areas: lines.map(line => line.trim().split(/\s+/).filter(Boolean).join(" ")),
    cells: next,
    issues: [],
    reassigned,
  };
}

/**
 * 把引用了已删除（或从未存在）区域的子节点退回顺序填充。
 *
 * 直接删掉 cells 条目是不行的：显式 cells 模式下，没有条目的子节点**完全不排版**，
 * 用户会看到对象凭空消失。退回顺序填充至少还在画布上。
 */
function reassignOrphans(
  cells: Record<NodeId, GridCell>,
  template: ReturnType<typeof parseGridAreaTemplate> | undefined,
  childIds: readonly NodeId[],
  columnCount: number,
): { cells: Record<NodeId, GridCell>; reassigned: NodeId[] } {
  const next: Record<NodeId, GridCell> = {};
  const reassigned: NodeId[] = [];
  for (const [nodeId, cell] of Object.entries(cells)) {
    if (cell.area === undefined) {
      next[nodeId] = cell;
      continue;
    }
    if (template?.areas.has(cell.area)) {
      next[nodeId] = cell;
      continue;
    }
    const index = Math.max(0, childIds.indexOf(nodeId));
    next[nodeId] = defaultGridCellForIndex(index, columnCount);
    reassigned.push(nodeId);
  }
  return { cells: next, reassigned };
}

/**
 * 轨道数变化后，检查模板与轨道是否还能对上。
 *
 * 对不上时把模板**固化**成行列号再丢掉模板：子节点的位置保持原样，
 * 文档仍然合法。`dropped` 让面板能说明发生过什么。
 */
export function reconcileGridAreasWithTracks(grid: GridSpec): GridAreaReconcileResult {
  const cells = grid.cells ?? {};
  if (!grid.areas?.length) return { areas: undefined, cells, dropped: false };

  const template = parseGridAreaTemplate(grid.areas);
  if (template.columns === grid.columns.length && template.rows === grid.rows.length) {
    return { areas: grid.areas, cells, dropped: false };
  }

  const frozen: Record<NodeId, GridCell> = {};
  for (const [nodeId, cell] of Object.entries(cells)) {
    if (cell.area === undefined) {
      frozen[nodeId] = cell;
      continue;
    }
    const rect = resolveGridCellRect(cell, template);
    frozen[nodeId] = rect ? { ...rect } : { row: 1, column: 1 };
  }
  return { areas: undefined, cells: frozen, dropped: true };
}

/**
 * 顺序填充时第 `index` 个子节点落在哪一格。
 *
 * 用在「按顺序」这个下拉选项上：选中它会把节点写回显式行列号，
 * 而不是删掉 cells 条目。
 */
export function defaultGridCellForIndex(index: number, columnCount: number): GridCellPlacement {
  const columns = Math.max(1, columnCount);
  const safeIndex = Math.max(0, index);
  return {
    row: Math.floor(safeIndex / columns) + 1,
    column: (safeIndex % columns) + 1,
  };
}

/**
 * 给一个子节点设置区域（或退回顺序填充）。
 *
 * 返回新的 cells 记录；调用方负责和 `areas` 一起提交。
 */
export function setGridChildArea(
  cells: Record<NodeId, GridCell> | undefined,
  nodeId: NodeId,
  area: string | undefined,
  index: number,
  columnCount: number,
): Record<NodeId, GridCell> {
  const next = { ...(cells ?? {}) };
  next[nodeId] = area ? { area } : defaultGridCellForIndex(index, columnCount);
  return next;
}
