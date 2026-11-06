import type { ComputedBox } from "@ufira/design-layout";

/** 画布的固定尺寸。布局引擎按这个尺寸解析页面，导出也用同一套视口。 */
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 680;

/** 缩放系数的可用区间。 */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 4;

/** 画布在工作区里四周留的空白。 */
export const CANVAS_PADDING = 16;

/**
 * 画布边界，传给 Moveable 的 `bounds`。
 *
 * 这里必须用坐标语义：`right`/`bottom` 表示元素右上角允许到达的最大坐标。
 * 千万不要加 `position: "css"` —— 那个模式下 Moveable 会把 `right`/`bottom`
 * 当成 CSS 的 `right`/`bottom` 偏移去反算，960x680 的画布会被换算成 0x0 的
 * 退化边界，拖拽时节点直接被甩到 `-(width, height)`。
 */
export const CANVAS_BOUNDS = { left: 0, top: 0, right: CANVAS_WIDTH, bottom: CANVAS_HEIGHT };

/** 一档缩放的步长。 */
const ZOOM_STEP = 0.1;

export interface Size {
  width: number;
  height: number;
}

/**
 * Clamps a zoom factor into the supported range.
 *
 * The factor is rounded to two decimals so the percentage in the UI does not
 * wobble while the user keeps clicking the same button.
 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
}

/**
 * Returns the zoom factor after one step up or down.
 */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  const steps = Math.round(clampZoom(zoom) * 100);
  return clampZoom((steps + direction * ZOOM_STEP * 100) / 100);
}

/**
 * Returns the zoom factor that makes the content fit into the viewport.
 *
 * `viewport` is the area the content may use; `padding` is kept free around it.
 * The result never goes above 100%: "fit" is about seeing everything, not about
 * blowing a small design up to the size of the window.
 */
export function fitZoom(content: Size, viewport: Size, padding = 0): number {
  const width = Math.max(1, viewport.width - padding);
  const height = Math.max(1, viewport.height - padding);
  const zoom = Math.min(width / Math.max(1, content.width), height / Math.max(1, content.height));
  return Math.min(1, clampZoom(zoom));
}

/**
 * Returns the zoom factor as the percentage shown in the UI.
 */
export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}

/**
 * Returns the bounding box of the laid out nodes.
 *
 * This is what "fit to content" frames: the page canvas is 960x680, but the
 * interesting part of a design is usually much smaller than that.
 */
export function contentBounds(boxes: Record<string, ComputedBox>): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const box of Object.values(boxes)) {
    if (!box || box.width <= 0 || box.height <= 0) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Returns the bounding box of a selection.
 *
 * The layout engine reports absolute page coordinates, so the box can be used
 * directly as the viewport and origin of a selection export. Nodes without a
 * resolved box are ignored; when nothing is left the caller exports the page.
 */
export function selectionBounds(boxes: Record<string, ComputedBox>, nodeIds: readonly string[]): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of nodeIds) {
    const box = boxes[id];
    if (!box || box.width <= 0 || box.height <= 0) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
