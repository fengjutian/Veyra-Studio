/**
 * Grid 轨道的编辑期模型。
 *
 * 规格见 `docs/grid-layout.md`。
 *
 * 这里**只有纯函数**：没有 DOM、没有 React、没有全局状态。
 * 组件（`grid-track-editor.tsx`）负责把指针事件翻译成这里的调用，
 * 属性面板（`property-panel.tsx`）负责把结果写回 `GridSpec`。
 *
 * 轨道声明沿用文档模型 `GridTrack`（`@ufira/design-schema`）——
 * 编辑器不发明第三套轨道表示；宽度怎么算则复用布局包
 * （`@ufira/design-layout`）里的 `resolveGridTrackWidths`，
 * 保证编辑器看到的轨道与画布求解出的轨道是同一套语义。
 */

import type { GridTrack } from "@ufira/design-schema";
import {
  MIN_GRID_TRACK_WIDTH,
  applyGridTrackWidths,
  gridTrackBaseWidths,
  isContentGridTrack,
  isResizableGridTrack,
  resolveGridTrackWidths,
} from "@ufira/design-layout";

/** 轨道数的上限——再多就没法看了，也没法在属性面板里操作。 */
export const MAX_GRID_TRACK_COUNT = 24;

/** 编辑期诊断码。 */
export type GridTrackDiagnosticCode =
  /** 轨道被最小宽度夹住了。 */
  | "min-width-clamped"
  /** 间隙总和超过容器可用宽，被夹住。 */
  | "gutter-clamped"
  /** 留白超过容器宽度的一半，被夹住。 */
  | "margin-clamped"
  /** 容器放不下这些轨道。 */
  | "container-overflow"
  /** 这条轨道不能直接拖拽调整（内容轨道 / 没有可调节的余量）。 */
  | "track-not-resizable"
  /** 轨道数量被夹到允许范围内。 */
  | "track-count-clamped";

/** 一条诊断信息。 */
export interface GridTrackDiagnostic {
  code: GridTrackDiagnosticCode;
  message: string;
  /** 相关轨道下标（0-based）。 */
  index?: number;
}

/** 编辑期模型。 */
export interface GridTrackModel {
  /** 轨道声明（与文档模型同构）。 */
  tracks: GridTrack[];
  /** 轨道之间的间隙（对应 `GridSpec.columnGap`）。 */
  gutter: number;
  /** 网格四周留白（视图层概念，不写回文档）。 */
  margin: number;
  /** 容器内容区宽度——轨道宽度的换算基准。 */
  containerWidth: number;
  /** 内容轨道的实测宽度（与轨道顺序对齐）；缺项按最小宽度估算。 */
  contentWidths?: (number | undefined)[];
}

/** 一次布局计算的结果。 */
export interface GridTrackLayout {
  /** 规范化后的模型（间隙与留白已夹紧）。 */
  model: GridTrackModel;
  /** 轨道声明（= `model.tracks`，可直接写回文档）。 */
  tracks: GridTrack[];
  /** 每条轨道的像素宽度。 */
  widths: number[];
  /** 每条轨道的起始偏移（相对内容区起点）。 */
  offsets: number[];
  /** 轨道总宽 + 间隙总和。 */
  totalWidth: number;
  /** 容器内容区宽度（已扣掉两侧留白）。 */
  availableWidth: number;
  /** 轨道没占满的剩余空间。 */
  slack: number;
  /** 放不下时的溢出量。 */
  overflow: number;
  diagnostics: GridTrackDiagnostic[];
}

/**
 * 间隙上限。
 *
 * 间隙总和不能挤掉轨道的最小宽度——否则轨道会窄到看不见。
 */
export function maxGridGutter(trackCount: number, availableWidth: number, minWidth: number = MIN_GRID_TRACK_WIDTH): number {
  if (trackCount <= 1) return 0;
  const room = availableWidth - trackCount * minWidth;
  if (room <= 0) return 0;
  return Math.floor(room / (trackCount - 1));
}

/**
 * 计算轨道布局。
 *
 * 这是**只读**的：它不会改动轨道声明，也不会写回文档。
 * 打开属性面板不会动用户的文档。
 *
 * @param pinnedIndex 被「钉住」的轨道下标——收缩时守住它当前的基准宽度
 *                    （用户正在拖的那条轨道必须保住用户给的尺寸）。
 */
export function layoutGridTracks(model: GridTrackModel, pinnedIndex?: number): GridTrackLayout {
  const diagnostics: GridTrackDiagnostic[] = [];

  const containerWidth = Math.max(0, model.containerWidth);
  const margin = clamp(model.margin, 0, containerWidth / 2);
  if (margin !== model.margin) {
    diagnostics.push({ code: "margin-clamped", message: `留白不能超过容器宽度的一半，已夹到 ${round2(margin)}px` });
  }
  const availableWidth = Math.max(0, containerWidth - margin * 2);

  const count = model.tracks.length;
  const gutterLimit = maxGridGutter(count, availableWidth);
  const gutter = clamp(model.gutter, 0, gutterLimit);
  if (gutter !== model.gutter) {
    diagnostics.push({ code: "gutter-clamped", message: `间隙总和不能挤掉轨道的最小宽度，已夹到 ${gutter}px` });
  }

  const resolved = resolveGridTrackWidths(model.tracks, {
    gap: gutter,
    availableWidth,
    contentWidths: model.contentWidths,
    pinnedIndex,
  });
  if (resolved.overflow > 0) {
    diagnostics.push({ code: "container-overflow", message: `容器放不下这些轨道，超出 ${round2(resolved.overflow)}px` });
  }

  const offsets: number[] = [];
  let cursor = 0;
  for (const width of resolved.widths) {
    offsets.push(cursor);
    cursor += width + gutter;
  }
  const totalWidth = Math.max(0, cursor - (count ? gutter : 0));

  return {
    model: { ...model, tracks: model.tracks, gutter, margin, containerWidth },
    tracks: model.tracks,
    widths: resolved.widths,
    offsets,
    totalWidth,
    availableWidth,
    slack: resolved.slack,
    overflow: resolved.overflow,
    diagnostics,
  };
}

/**
 * 加一条轨道。
 *
 * 新轨道以最小宽度起步（可用 `type` 指定类型），其余轨道等比收缩补足差额——
 * 容器总宽守恒，不产生溢出。
 */
export function addGridTrack(model: GridTrackModel, type: GridTrack["type"] = "fixed"): GridTrackLayout {
  const tracks = [...model.tracks, createGridTrack(type)];
  // 新轨道被钉住：它守住刚给定的宽度，空间由其余轨道让出来。
  return commit({ ...model, tracks }, tracks.length - 1);
}

/**
 * 删一条轨道。
 *
 * 至少保留一条——没有轨道的 Grid 容器无法排版。
 * 被删轨道让出的空间按同样规则给其余轨道（总宽守恒）。
 */
export function removeGridTrack(model: GridTrackModel, index: number): GridTrackLayout {
  if (model.tracks.length <= 1) {
    return withDiagnostic(layoutGridTracks(model), { code: "track-count-clamped", message: "至少要保留一条轨道" });
  }
  if (index < 0 || index >= model.tracks.length) return layoutGridTracks(model);
  const tracks = model.tracks.filter((_, position) => position !== index);
  return commit({ ...model, tracks });
}

/**
 * 设置轨道数量。
 *
 * 多了就删最后几条，少了就补到最后一条。
 */
export function setGridTrackCount(model: GridTrackModel, count: number): GridTrackLayout {
  const target = clamp(Math.round(count), 1, MAX_GRID_TRACK_COUNT);
  let tracks = model.tracks.slice();
  while (tracks.length < target) tracks = [...tracks, createGridTrack("fixed")];
  while (tracks.length > target) tracks = tracks.slice(0, -1);
  const layout = commit({ ...model, tracks });
  if (target !== count) {
    return withDiagnostic(layout, { code: "track-count-clamped", message: `轨道数量已夹到 ${target} 条` });
  }
  return layout;
}

/**
 * 设置轨道间隙。
 *
 * 间隙总和不能挤掉轨道的最小宽度，超出时夹紧并给出诊断。
 */
export function setGridGutter(model: GridTrackModel, gutter: number): GridTrackLayout {
  return commit({ ...model, gutter });
}

/**
 * 设置网格四周留白。
 *
 * 留白是视图层概念，不写回文档；它会改变轨道的可用宽度。
 */
export function setGridMargin(model: GridTrackModel, margin: number): GridTrackLayout {
  return commit({ ...model, margin });
}

/**
 * 调整单条轨道的宽度。
 *
 * - `fixed` 轨道直接改 `size`（先按最小宽度夹紧），差额由其余轨道吸收；
 * - `fraction` 轨道反解权重（`w = 目标宽度 × 其余权重和 ÷ (可用空间 − 目标宽度)`），
 *   于是只有被拖的那条轨道宽度变化，其余 `fraction` 轨道等比让位；
 * - 内容轨道不能直接调整——它的宽度由内容决定。
 */
export function resizeGridTrack(model: GridTrackModel, index: number, width: number): GridTrackLayout {
  const layout = layoutGridTracks(model);
  const track = layout.tracks[index];
  if (!track) return layout;

  if (track.type === "fixed") {
    const target = Math.max(MIN_GRID_TRACK_WIDTH, width);
    const tracks = layout.tracks.map((item, position) => (position === index ? { type: "fixed" as const, size: target } : item));
    const next = commit({ ...layout.model, tracks }, index);
    if (target === width) return next;
    return withDiagnostic(next, {
      code: "min-width-clamped",
      index,
      message: `轨道最小宽度是 ${MIN_GRID_TRACK_WIDTH}px，已夹紧`,
    });
  }

  if (track.type === "fraction") {
    const gap = layout.model.gutter;
    const space = layout.availableWidth - Math.max(0, layout.tracks.length - 1) * gap;
    const bases = gridTrackBaseWidths(layout.tracks, { contentWidths: layout.model.contentWidths });
    // fraction 轨道不占基准宽度，可用空间 = 空间 − 其它轨道的基准宽度。
    let baseTotal = 0;
    layout.tracks.forEach((item, position) => {
      if (item.type !== "fraction") baseTotal += bases[position] ?? 0;
    });
    const freeSpace = space - baseTotal;
    const others = layout.tracks.filter((item, position) => position !== index && item.type === "fraction");
    const othersWeight = others.reduce((sum, item) => sum + (item.type === "fraction" ? Math.max(0, item.weight) : 0), 0);
    if (othersWeight <= 0) {
      return withDiagnostic(layout, { code: "track-not-resizable", index, message: "这条轨道之外没有可调节的余量" });
    }
    // 其它 fraction 轨道至少要留住最小宽度。
    const upper = Math.max(MIN_GRID_TRACK_WIDTH, freeSpace - others.length * MIN_GRID_TRACK_WIDTH);
    const target = clamp(width, MIN_GRID_TRACK_WIDTH, upper);
    const denominator = freeSpace - target;
    const weight = denominator > 1e-6 ? (target * othersWeight) / denominator : othersWeight * 1e4;
    const tracks = layout.tracks.map((item, position) => (position === index ? { type: "fraction" as const, weight: Math.max(0.001, round3(weight)) } : item));
    const next = commit({ ...layout.model, tracks }, index);
    if (target === width) return next;
    return withDiagnostic(next, { code: "min-width-clamped", index, message: `轨道宽度已夹到 ${round2(target)}px` });
  }

  return withDiagnostic(layout, {
    code: "track-not-resizable",
    index,
    message: "内容轨道的宽度由内容决定，不能直接调整",
  });
}

/**
 * 拖拽轨道边界。
 *
 * 边界在第 `index` 条轨道与它后面那条之间；`delta` 为正表示边界右移。
 * 左边那条能调就调左边，调不了就调右边（右边的宽度相应减少）。
 */
export function resizeGridTrackBoundary(model: GridTrackModel, index: number, delta: number): GridTrackLayout {
  const layout = layoutGridTracks(model);
  const left = layout.tracks[index];
  const right = layout.tracks[index + 1];
  if (!left || !right) return layout;
  if (isResizableGridTrack(left)) return resizeGridTrack(layout.model, index, layout.widths[index] + delta);
  if (isResizableGridTrack(right)) return resizeGridTrack(layout.model, index + 1, layout.widths[index + 1] - delta);
  return withDiagnostic(layout, { code: "track-not-resizable", index, message: "相邻两条都是内容轨道，无法调整" });
}

/**
 * 提交一次几何编辑。
 *
 * 重新分配之后的宽度会**写回轨道声明**——这样属性面板看到的、
 * 文档里存的、画布上画的是同一份数据（总宽守恒）。
 */
function commit(next: GridTrackModel, pinnedIndex?: number): GridTrackLayout {
  const layout = layoutGridTracks(next, pinnedIndex);
  const widths = layout.widths.slice();
  // 轨道没占满容器时，把空余按「fraction → 内容轨道 → fixed」的顺序给出去。
  // 被钉住的轨道不参与——用户给它的尺寸必须保住。
  if (layout.slack > 1e-9) growGridTracks(widths, layout.tracks, layout.slack, pinnedIndex);

  const gutter = layout.model.gutter;
  const offsets: number[] = [];
  let cursor = 0;
  for (const width of widths) {
    offsets.push(cursor);
    cursor += width + gutter;
  }
  const totalWidth = Math.max(0, cursor - (widths.length ? gutter : 0));
  const used = widths.reduce((sum, width) => sum + width, 0) + (widths.length ? Math.max(0, widths.length - 1) * gutter : 0);

  const tracks = applyGridTrackWidths(layout.tracks, widths, {
    gap: gutter,
    availableWidth: layout.availableWidth,
    contentWidths: layout.model.contentWidths,
  });
  return {
    ...layout,
    tracks,
    widths,
    offsets,
    totalWidth,
    slack: Math.max(0, layout.availableWidth - used),
    overflow: Math.max(0, used - layout.availableWidth),
    model: { ...layout.model, tracks },
  };
}

/**
 * 把空余空间分给轨道。
 *
 * 顺序与收缩相反：先给弹性轨道（`fraction`），再给内容轨道，最后给固定轨道。
 * 每一层内部按当前宽度等比分配。
 */
function growGridTracks(widths: number[], tracks: GridTrack[], amount: number, pinnedIndex?: number): void {
  const tiers: number[][] = [[], [], []];
  tracks.forEach((track, index) => {
    if (index === pinnedIndex) return;
    if (track.type === "fraction") tiers[0].push(index);
    else if (isContentGridTrack(track)) tiers[1].push(index);
    else tiers[2].push(index);
  });
  for (const tier of tiers) {
    if (!tier.length) continue;
    const total = tier.reduce((sum, index) => sum + widths[index], 0);
    if (total <= 1e-9) continue;
    let handed = 0;
    tier.forEach((index, order) => {
      const share = order === tier.length - 1 ? amount - handed : (amount * widths[index]) / total;
      widths[index] += share;
      handed += share;
    });
    return;
  }
}

/** 新建一条轨道时的缺省参数。 */
function createGridTrack(type: GridTrack["type"]): GridTrack {
  switch (type) {
    case "fixed": return { type: "fixed", size: MIN_GRID_TRACK_WIDTH };
    case "fraction": return { type: "fraction", weight: 1 };
    case "auto": return { type: "auto" };
    case "min-content": return { type: "min-content" };
    case "max-content": return { type: "max-content" };
    // 自动重复轨道的默认值取「能放两列就打底」的常见宽度。
    case "repeat": return { type: "repeat", mode: "auto-fill", min: 120, grow: true };
  }
}

/** 追加一条诊断。 */
function withDiagnostic(layout: GridTrackLayout, diagnostic: GridTrackDiagnostic): GridTrackLayout {
  return { ...layout, diagnostics: [...layout.diagnostics, diagnostic] };
}

/** 把数值夹到区间内。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** 保留两位小数。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 保留三位小数。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
