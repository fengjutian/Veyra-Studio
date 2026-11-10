import { applyThemeForPage, applyTypographyToken, parseGridAreaTemplate, resolveGap, resolveGridCellRect, validateDocument, type DesignDocument, type DesignNode, type GridCell, type GridTrack, type NodeId } from "@ufira/design-schema";
import type { ComputedBox, LayoutOptions, LayoutResult, LayoutWarning, Size, TextMeasurer } from "./types";
import { createEstimateTextMeasurer } from "./text-measurement";
import { assignCellsByOrder, ensureTracks, expandRepeatTracks, solveGrid, type GridCellInput, type GridTrackInput } from "./grid";

const ZERO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

const defaultTextMeasurer: TextMeasurer = createEstimateTextMeasurer();

/**
 * 轨道声明 → 求解输入。
 *
 * 自动重复轨道应当在求解前由 `expandRepeatTracks` 展开；万一漏网，
 * 按内容轨道处理（至少不会让整篇文档排不出来）。
 */
function toGridTrackInput(track: GridTrack, contentSizes: { width: number; height: number }[] | undefined): GridTrackInput {
  return {
    type: track.type === "repeat" ? "auto" : track.type,
    size: track.type === "fixed" ? track.size : undefined,
    weight: track.type === "fraction" ? track.weight : undefined,
    contentSizes,
  };
}

export function computePageLayout(documentInput: DesignDocument, pageId: string, options: LayoutOptions): LayoutResult {
  // 主题在入口合并进 token 表：字体 token 的字号/行高会直接影响测量与 hug 尺寸。
  const document = applyThemeForPage(validateDocument(documentInput), pageId, options.themeId);
  const page = document.pages[pageId];
  if (!page) throw new Error(`Page ${pageId} does not exist`);
  if (!Number.isFinite(options.viewport.width) || !Number.isFinite(options.viewport.height) || options.viewport.width < 0 || options.viewport.height < 0) {
    throw new Error("Viewport dimensions must be finite non-negative numbers");
  }

  const boxes: Record<NodeId, ComputedBox> = {};
  const warnings: LayoutWarning[] = [];
  const measurer = options.textMeasurer ?? defaultTextMeasurer;
  const intrinsicCache = new Map<NodeId, Size>();

  const intrinsic = (nodeId: NodeId): Size => {
    const cached = intrinsicCache.get(nodeId);
    if (cached) return cached;
    // 字体 token 在这一层生效：测量看到的已经是覆盖后的样式，
    // 因此 hug 宽高会跟着 token 走，而不是只看节点自身的字号。
    const node = document.nodes[nodeId] ? applyTypographyToken(document, document.nodes[nodeId]!) : undefined;
    if (!node) return { width: 0, height: 0 };
    let content: Size;
    if (node.type === "text") {
      // A fixed width constrains wrapping, so the height must be measured against it.
      const constraint = node.layout.widthMode === "fixed" ? node.layout.width : undefined;
      content = measurer.measure(node, constraint);
    } else if (node.childIds.length) content = intrinsicContainer(node);
    else content = { width: node.layout.width, height: node.layout.height };
    const result = {
      width: node.layout.widthMode === "hug" ? content.width : node.layout.width,
      height: node.layout.heightMode === "hug" ? content.height : node.layout.height,
    };
    intrinsicCache.set(nodeId, result);
    return result;
  };

  const intrinsicContainer = (node: DesignNode): Size => {
    const padding = node.layout.padding ?? ZERO_PADDING;
    const children = node.childIds.map(id => ({ node: document.nodes[id], size: intrinsic(id) }));
    for (const child of children) {
      if (child.node.layout.widthMode === "fill" || child.node.layout.heightMode === "fill") {
        warnings.push({ nodeId: child.node.id, code: "fill-in-hug", message: `Fill sizing inside hug container ${node.id} uses the child's fallback size` });
      }
    }
    if (node.layout.mode === "stack") {
      const horizontal = node.layout.direction === "horizontal";
      const gap = resolveGap(document, node);
      const main = children.reduce((sum, child) => sum + (horizontal ? child.size.width : child.size.height), 0)
        + Math.max(0, children.length - 1) * gap;
      const cross = children.reduce((max, child) => Math.max(max, horizontal ? child.size.height : child.size.width), 0);
      return horizontal
        ? { width: padding.left + main + padding.right, height: padding.top + cross + padding.bottom }
        : { width: padding.left + cross + padding.right, height: padding.top + main + padding.bottom };
    }
    if (node.layout.mode === "grid") {
      // Grid 容器的 hug 尺寸 = 轨道总尺寸 + gap + padding。
      // 轨道本身的尺寸依赖子节点内容，所以要先测内容再定轨道。
      const grid = node.layout.grid;
      if (!grid) return { width: padding.left + padding.right, height: padding.top + padding.bottom };
      const intrinsicSize = intrinsicGrid(node, grid.columns, grid.rows, grid.columnGap, grid.rowGap, children);
      return {
        width: padding.left + intrinsicSize.width + padding.right,
        height: padding.top + intrinsicSize.height + padding.bottom,
      };
    }
    const width = children.reduce((max, child) => Math.max(max, child.node.layout.x + child.size.width), 0);
    const height = children.reduce((max, child) => Math.max(max, child.node.layout.y + child.size.height), 0);
    return { width: padding.left + width + padding.right, height: padding.top + height + padding.bottom };
  };

  const resolveDimension = (node: DesignNode, axis: "width" | "height", available: number): number => {
    const mode = axis === "width" ? node.layout.widthMode : node.layout.heightMode;
    if (mode === "fill") return Math.max(0, available);
    if (mode === "hug") return intrinsic(node.id)[axis];
    return node.layout[axis];
  };

  /**
   * 收集落在每条轨道上的子节点内容尺寸。
   *
   * 只有 `auto` / `min-content` / `max-content` 轨道用得上这些尺寸；
   * `fixed` 与 `fraction` 不看内容。
   */
  const trackContentSizes = (
    cells: GridCellInput[],
    tracks: GridTrack[],
    axis: "columns" | "rows",
  ): Map<number, { width: number; height: number }[]> => {
    const map = new Map<number, { width: number; height: number }[]>();
    tracks.forEach((_, index) => map.set(index, []));
    for (const cell of cells) {
      const trackIndex = axis === "columns" ? cell.column - 1 : cell.row - 1;
      if (trackIndex < 0) continue;
      const bucket = map.get(trackIndex);
      if (!bucket) continue;
      bucket.push({ width: cell.width, height: cell.height });
    }
    return map;
  };

  /**
   * Grid 容器的固有尺寸（hug 时的尺寸）。
   *
   * 轨道尺寸依赖子节点内容，所以这里先按内容尺寸把 `auto` 轨道的尺寸算出来，
   * 再加上固定轨道与 gap。
   */
  const intrinsicGrid = (
    node: DesignNode,
    columns: GridTrack[],
    rows: GridTrack[],
    columnGap: number,
    rowGap: number,
    children: { node: DesignNode; size: Size }[],
  ): Size => {
    // hug 容器的可用尺寸由内容决定，而自动重复轨道的条数又依赖可用尺寸——
    // 这个循环没有不动点，因此这里退化成「每条 repeat 只展开一条」。
    const columnTracks = expandRepeatTracks(columns, { available: undefined, gap: columnGap, itemCount: children.length }).tracks;
    const rowTracks = expandRepeatTracks(rows, { available: undefined, gap: rowGap, itemCount: children.length }).tracks;
    const cells = gridCells(node, children, columnTracks);
    // 子节点超出已声明的轨道数时补出隐式轨道（CSS Grid 语义），
    // 否则它们会被钳到最后一格造成重叠。
    const resolvedColumns = ensureTracks(columnTracks, cells, "columns");
    const resolvedRows = ensureTracks(rowTracks, cells, "rows");
    const columnContents = trackContentSizes(cells, resolvedColumns, "columns");
    const rowContents = trackContentSizes(cells, resolvedRows, "rows");

    const toInput = (tracks: GridTrack[], contents: Map<number, { width: number; height: number }[]>): GridTrackInput[] =>
      tracks.map((track, index) => toGridTrackInput(track, contents.get(index)));

    const columnInput = toInput(resolvedColumns, columnContents);
    const rowInput = toInput(resolvedRows, rowContents);

    // 用「无限可用空间」求解：fraction 轨道此时分不到空间（remainder 为 0），
    // 这正是 hug 容器想要的——只按内容与固定轨道定尺寸。
    const solved = solveGrid({
      columns: columnInput,
      rows: rowInput,
      columnGap,
      rowGap,
      availableWidth: 0,
      availableHeight: 0,
      cells,
      align: node.layout.grid?.align ?? "start",
    });

    return { width: solved.totalWidth, height: solved.totalHeight };
  };

  /**
   * 解析 Grid 容器的子节点单元格。
   *
   * 有显式 `cells` 用显式的；没有就按顺序填格子。
   */
  const gridCells = (
    node: DesignNode,
    children: { node: DesignNode; size: Size }[],
    columns: GridTrack[],
  ): GridCellInput[] => {
    const grid = node.layout.grid;
    const explicit = grid?.cells;
    // 顺序填充要用**展开后**的列数：只有一条 repeat 轨道时按 1 列排会把
    // 所有子节点堆到第一列，与画布看到的网格对不上。
    const columnCount = columns.length || 1;

    if (!explicit || !Object.keys(explicit).length) {
      const ordered = assignCellsByOrder(
        children.map(child => child.node.id),
        columnCount,
      );
      return ordered.map(cell => {
        const child = children.find(item => item.node.id === cell.nodeId);
        return {
          ...cell,
          width: child?.size.width ?? 0,
          height: child?.size.height ?? 0,
        };
      });
    }

    // 显式 cells 的子节点按容器 childIds 的顺序处理，保证输出稳定。
    // 命名区域在这里解析成具体行列：求解器只认行列号，不认识区域名。
    const template = grid?.areas ? parseGridAreaTemplate(grid.areas) : undefined;
    const result: GridCellInput[] = [];
    for (const child of children) {
      const cell: GridCell | undefined = explicit[child.node.id];
      if (!cell) continue;
      const rect = resolveGridCellRect(cell, template);
      // 模板里没有这个区域（或模板本身有错）：跳过而不是猜一格，
      // 猜出来的位置会和导出对不上。
      if (!rect) continue;
      result.push({
        nodeId: child.node.id,
        row: rect.row,
        column: rect.column,
        rowSpan: rect.rowSpan,
        columnSpan: rect.columnSpan,
        width: child.size.width,
        height: child.size.height,
      });
    }
    return result;
  };

  const layoutNode = (nodeId: NodeId, x: number, y: number, availableWidth: number, availableHeight: number, forced?: Partial<Size>): void => {
    const node = applyTypographyToken(document, document.nodes[nodeId]!);
    const width = forced?.width ?? resolveDimension(node, "width", availableWidth);
    // A hugging text height depends on the width it actually got, which is only
    // known here — so measure against the resolved width instead of the cached intrinsic.
    const measured = node.type === "text" ? measurer.measure(node, width) : undefined;
    const height = forced?.height ?? (node.type === "text" && node.layout.heightMode === "hug"
      ? measured!.height
      : resolveDimension(node, "height", availableHeight));
    boxes[nodeId] = { x, y, width, height };
    // Text that needs more lines than the box allows is a layout problem the user
    // must see, otherwise the content is silently clipped on the canvas.
    if (measured && measured.height > height + 0.5) {
      warnings.push({
        nodeId: node.id,
        code: "text-overflow",
        message: `Text ${node.id} needs ${Math.round(measured.height)}px but the box is only ${Math.round(height)}px tall`,
      });
    }
    if (!node.childIds.length) return;

    const padding = node.layout.padding ?? ZERO_PADDING;
    const contentX = x + padding.left;
    const contentY = y + padding.top;
    const contentWidth = Math.max(0, width - padding.left - padding.right);
    const contentHeight = Math.max(0, height - padding.top - padding.bottom);

    if (node.layout.mode === "absolute") {
      for (const childId of node.childIds) {
        const child = document.nodes[childId];
        layoutNode(childId, contentX + child.layout.x, contentY + child.layout.y, contentWidth, contentHeight);
      }
      return;
    }

    if (node.layout.mode === "grid") {
      const grid = node.layout.grid;
      if (!grid) return;
      const gridChildren = node.childIds.map(id => ({ node: document.nodes[id]!, size: intrinsic(id) }));
      // 自动重复轨道的条数取决于容器可用尺寸。hug 容器的尺寸是**结果**，
      // 拿不到确定值，只能退化成一条并明确告诉用户。
      const columnExpansion = expandRepeatTracks(grid.columns, {
        available: node.layout.widthMode === "hug" ? undefined : contentWidth,
        gap: grid.columnGap,
        itemCount: node.childIds.length,
      });
      const rowExpansion = expandRepeatTracks(grid.rows, {
        available: node.layout.heightMode === "hug" ? undefined : contentHeight,
        gap: grid.rowGap,
        itemCount: Math.ceil(node.childIds.length / Math.max(1, columnExpansion.tracks.length)),
      });
      if (columnExpansion.degraded) {
        warnings.push({
          nodeId: node.id,
          code: "grid-auto-repeat",
          message: `Automatic columns on ${node.id} need a definite width; a hug container falls back to a single track`,
        });
      }
      if (rowExpansion.degraded) {
        warnings.push({
          nodeId: node.id,
          code: "grid-auto-repeat",
          message: `Automatic rows on ${node.id} need a definite height; a hug container falls back to a single track`,
        });
      }
      const cells = gridCells(node, gridChildren, columnExpansion.tracks);
      const resolvedColumns = ensureTracks(columnExpansion.tracks, cells, "columns");
      const resolvedRows = ensureTracks(rowExpansion.tracks, cells, "rows");
      const columnContents = trackContentSizes(cells, resolvedColumns, "columns");
      const rowContents = trackContentSizes(cells, resolvedRows, "rows");
      const toInput = (tracks: GridTrack[], contents: Map<number, { width: number; height: number }[]>): GridTrackInput[] =>
        tracks.map((track, index) => toGridTrackInput(track, contents.get(index)));

      const solved = solveGrid({
        columns: toInput(resolvedColumns, columnContents),
        rows: toInput(resolvedRows, rowContents),
        columnGap: grid.columnGap,
        rowGap: grid.rowGap,
        availableWidth: contentWidth,
        availableHeight: contentHeight,
        cells,
        align: grid.align ?? "start",
      });

      if (solved.overflowWidth > 0.5) {
        warnings.push({ nodeId: node.id, code: "overflow", message: `Grid columns exceed ${node.id}'s width by ${Math.round(solved.overflowWidth)}px` });
      }
      if (solved.overflowHeight > 0.5) {
        warnings.push({ nodeId: node.id, code: "overflow", message: `Grid rows exceed ${node.id}'s height by ${Math.round(solved.overflowHeight)}px` });
      }

      for (const child of solved.children) {
        layoutNode(child.nodeId, contentX + child.x, contentY + child.y, child.width, child.height, {
          width: child.width,
          height: child.height,
        });
      }
      return;
    }

    const horizontal = node.layout.direction === "horizontal";
    const mainAvailable = horizontal ? contentWidth : contentHeight;
    const crossAvailable = horizontal ? contentHeight : contentWidth;
    const gap = resolveGap(document, node);
    const children = node.childIds.map(id => document.nodes[id]);
    const fillChildren = children.filter(child => (horizontal ? child.layout.widthMode : child.layout.heightMode) === "fill");
    const fixedMain = children
      .filter(child => !fillChildren.includes(child))
      .reduce((sum, child) => sum + (horizontal ? resolveDimension(child, "width", mainAvailable) : resolveDimension(child, "height", mainAvailable)), 0);
    const gaps = Math.max(0, children.length - 1) * gap;
    const remainder = Math.max(0, mainAvailable - fixedMain - gaps);
    if (fixedMain + gaps > mainAvailable) {
      warnings.push({ nodeId: node.id, code: "overflow", message: `Children exceed ${node.id}'s ${horizontal ? "width" : "height"} by ${fixedMain + gaps - mainAvailable}px` });
    }
    const fillMain = fillChildren.length ? remainder / fillChildren.length : 0;
    let cursor = horizontal ? contentX : contentY;

    for (const child of children) {
      const mainMode = horizontal ? child.layout.widthMode : child.layout.heightMode;
      const main = mainMode === "fill" ? fillMain : horizontal
        ? resolveDimension(child, "width", mainAvailable)
        : resolveDimension(child, "height", mainAvailable);
      const crossMode = horizontal ? child.layout.heightMode : child.layout.widthMode;
      const cross = crossMode === "fill" || node.layout.align === "stretch" ? crossAvailable : horizontal
        ? resolveDimension(child, "height", crossAvailable)
        : resolveDimension(child, "width", crossAvailable);
      const crossOffset = alignmentOffset(node.layout.align ?? "start", crossAvailable, cross);
      const childX = horizontal ? cursor : contentX + crossOffset;
      const childY = horizontal ? contentY + crossOffset : cursor;
      layoutNode(child.id, childX, childY, crossAvailable, mainAvailable, horizontal
        ? { width: main, height: cross }
        : { width: cross, height: main });
      cursor += main + gap;
    }
  };

  for (const nodeId of page.childIds) {
    const node = document.nodes[nodeId];
    layoutNode(nodeId, node.layout.x, node.layout.y, options.viewport.width, options.viewport.height);
  }

  return { pageId, viewport: { ...options.viewport }, boxes, warnings: dedupeWarnings(warnings) };
}

function alignmentOffset(align: "start" | "center" | "end" | "stretch", available: number, size: number): number {
  if (align === "center") return (available - size) / 2;
  if (align === "end") return available - size;
  return 0;
}

function dedupeWarnings(warnings: LayoutWarning[]): LayoutWarning[] {
  const seen = new Set<string>();
  return warnings.filter(warning => {
    const key = `${warning.nodeId}:${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
