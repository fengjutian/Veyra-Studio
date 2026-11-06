import type { LayoutSpec } from "@ufira/design-schema";

const ZERO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

export type LayoutMode = "absolute" | "stack";

/**
 * Switches a layout between absolute and stack mode.
 *
 * A stack layout requires a direction, so switching into stack keeps the current
 * direction when there is one and falls back to vertical otherwise. Switching
 * back to absolute clears the direction so the node no longer claims to be a stack.
 */
export function switchLayoutMode(layout: LayoutSpec, mode: LayoutMode): LayoutSpec {
  if (mode === "stack") return { ...layout, mode: "stack", direction: layout.direction ?? "vertical" };
  return { ...layout, mode: "absolute", direction: undefined };
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
