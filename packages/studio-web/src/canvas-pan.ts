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

/**
 * Decides whether a pointer press should begin viewport panning.
 *
 * The hand tool and middle mouse button work everywhere. A normal left drag is
 * also accepted on the workspace around the page, while presses on the page
 * remain available to selection, marquee and drawing tools.
 */
export function canStartCanvasPan(button: number, handTool: boolean, overCanvas: boolean): boolean {
  if (handTool) return button === 0 || button === 1;
  if (button === 1) return true;
  return button === 0 && !overCanvas;
}

/** Centers a scrollable infinite-canvas stage inside its viewport. */
export function centeredCanvasScroll(scrollWidth: number, scrollHeight: number, clientWidth: number, clientHeight: number): PanScroll {
  return {
    scrollLeft: Math.max(0, (scrollWidth - clientWidth) / 2),
    scrollTop: Math.max(0, (scrollHeight - clientHeight) / 2),
  };
}

/** Keeps a scroll offset inside the scrollable range. */
export function clampScroll(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), Math.max(0, max));
}
