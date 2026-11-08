import type { GridTrack, LayoutSpec } from "@ufira/design-schema";

const ZERO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

export type LayoutMode = "absolute" | "stack" | "grid";

/**
 * Grid 容器的缺省轨道配置。
 *
 * 两条 `auto` 轨道 + 一条列——够放下几个卡片，且不需要用户先想清楚
 * 「这个网格该是几列」才能开始用。
 */
export function defaultGridSpec(): NonNullable<LayoutSpec["grid"]> {
  return {
    columns: [{ type: "auto" }, { type: "auto" }],
    rows: [{ type: "auto" }],
    columnGap: 0,
    rowGap: 0,
  };
}

/**
 * Switches a layout between absolute, stack and grid mode.
 *
 * A stack layout requires a direction, so switching into stack keeps the current
 * direction when there is one and falls back to vertical otherwise. Switching
 * back to absolute clears the direction so the node no longer claims to be a stack.
 *
 * Grid 需要自己的轨道配置——没有轨道就没有格子可放。切换走 grid 时补上缺省配置，
 * 从 grid 切走时清掉它，避免留下「这个容器到底怎么排版」含糊不清的状态
 * （schema 会拒绝 grid 配置出现在非 grid 容器上）。
 */
export function switchLayoutMode(layout: LayoutSpec, mode: LayoutMode): LayoutSpec {
  if (mode === "stack") {
    return { ...layout, mode: "stack", direction: layout.direction ?? "vertical", grid: undefined };
  }
  if (mode === "grid") {
    return { ...layout, mode: "grid", direction: undefined, grid: layout.grid ?? defaultGridSpec() };
  }
  return { ...layout, mode: "absolute", direction: undefined, grid: undefined };
}

/**
 * 新增一条轨道。
 *
 * `fraction` 轨道默认权重 1，`fixed` 默认 100px，其余类型没有尺寸参数。
 */
export function addGridTrack(tracks: GridTrack[], type: GridTrack["type"]): GridTrack[] {
  switch (type) {
    case "fixed":
      return [...tracks, { type: "fixed", size: 100 }];
    case "fraction":
      return [...tracks, { type: "fraction", weight: 1 }];
    case "auto":
      return [...tracks, { type: "auto" }];
    case "min-content":
      return [...tracks, { type: "min-content" }];
    case "max-content":
      return [...tracks, { type: "max-content" }];
  }
}

/**
 * 删除一条轨道。
 *
 * 至少保留一条——没有轨道的 Grid 容器无法排版。
 */
export function removeGridTrack(tracks: GridTrack[], index: number): GridTrack[] {
  if (tracks.length <= 1) return tracks;
  return tracks.filter((_, position) => position !== index);
}

/**
 * Returns the padding of a layout with the unset sides filled in.
 */
export function resolvePadding(layout: LayoutSpec): typeof ZERO_PADDING {
  return layout.padding ?? ZERO_PADDING;
}

/**
 * Clamps an opacity value into the range the schema accepts.
 */
export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Converts an opacity percentage shown in the inspector back into a ratio.
 */
export function opacityToPercent(opacity: number): number {
  return Math.round(opacity * 100);
}

/**
 * Converts an opacity percentage from the inspector into a clamped ratio.
 */
export function percentToOpacity(percent: number): number {
  return clampOpacity(percent / 100);
}
