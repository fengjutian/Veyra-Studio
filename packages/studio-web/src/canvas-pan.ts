/** 平移画布时的滚动位置。 */
export interface PanScroll {
  scrollLeft: number;
  scrollTop: number;
}

/**
 * Computes the scroll position after a pointer drag.
 *
 * The canvas follows the hand: dragging to the right moves the view to the left, so
 * the scroll offset is reduced by the pointer delta.
 */
export function panScroll(scroll: PanScroll, dx: number, dy: number): PanScroll {
  return { scrollLeft: scroll.scrollLeft - dx, scrollTop: scroll.scrollTop - dy };
}

/** Keeps a scroll offset inside the scrollable range. */
export function clampScroll(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(0, max));
}
