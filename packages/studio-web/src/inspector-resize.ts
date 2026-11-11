export const MIN_INSPECTOR_WIDTH = 256;
export const MAX_INSPECTOR_WIDTH = 640;

/** Keep enough room for the canvas while still allowing a useful inspector width. */
export function clampInspectorWidth(width: number, viewportWidth: number): number {
  const viewportMaximum = Math.max(MIN_INSPECTOR_WIDTH, viewportWidth - 360);
  return Math.round(Math.min(MAX_INSPECTOR_WIDTH, viewportMaximum, Math.max(MIN_INSPECTOR_WIDTH, width)));
}

export function defaultInspectorWidth(viewportWidth: number): number {
  if (viewportWidth <= 1180) return MIN_INSPECTOR_WIDTH;
  if (viewportWidth <= 1440) return 304;
  return 320;
}
