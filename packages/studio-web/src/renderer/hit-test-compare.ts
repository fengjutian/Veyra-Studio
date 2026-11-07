import type { HitPoint } from "./hit-test";

/**
 * 命中测试的双跑对比。
 *
 * Phase C 的目标是移除透明的 DOM 节点副本；在那之前，让 Canvas 命中与 DOM 的
 * `closest("[data-node-id]")` 同时跑一遍，不一致时只记录、不改变行为。等对比数据
 * 干净了再切换选择层。
 */
export interface HitComparison {
  canvasId: string | undefined;
  domId: string | undefined;
  matches: boolean;
}

export function compareHits(canvasId: string | undefined, domId: string | undefined): HitComparison {
  return { canvasId, domId, matches: canvasId === domId };
}

/**
 * 把指针事件换算成场景坐标。
 *
 * `rect` 是画布元素的布局矩形（已被 CSS zoom 放大），所以除以 zoom 得到 960×680
 * 场景里的坐标。
 */
export function pointFromEvent(rect: { left: number; top: number }, clientX: number, clientY: number, zoom: number): HitPoint {
  const scale = zoom > 0 ? zoom : 1;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}
