/**
 * 混合模式在 Canvas / CSS / SVG 三处的名字映射。
 *
 * 取值集合与 CSS `mix-blend-mode` 对齐，所以 HTML 与 SVG 导出**不需要翻译**——
 * 同一套名字直接写进 CSS 与 SVG 样式。Canvas 2D 的
 * `globalCompositeOperation` 是另一套语义（Porter-Duff 合成），
 * 只有一部分取值能对上，对不上的必须**显式退化**而不是猜。
 */

import type { BlendMode } from "./types";

/** 全部混合模式（与 CSS `mix-blend-mode` 一致）。 */
export const BLEND_MODES: BlendMode[] = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

/**
 * Canvas 2D 的 `globalCompositeOperation` 对应的混合模式。
 *
 * **只有 12 种**能对上——`hue` / `saturation` / `color` / `luminosity`
 * 在 Canvas 里没有等价物（Canvas 只有 Porter-Duff 与分离式混合的前 12 种，
 * 颜色类混合需要 HSL 空间运算，Canvas 不提供）。
 *
 * `overlay` / `darken` / `lighten` / `color-dodge` / `color-burn` /
 * `hard-light` / `soft-light` 在 Canvas 里的名字与 CSS **不同**，
 * 这里做一次翻译。
 */
const CANVAS_COMPOSITE: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color-dodge": "color-dodge",
  "color-burn": "color-burn",
  "hard-light": "hard-light",
  "soft-light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
};

/**
 * 混合模式 → Canvas 的合成操作。
 *
 * 没有对应值时返回 `undefined`——调用方应当**退回 normal 并给出警告**，
 * 不能随便挑一个近似的：画出一个「看起来差不多但其实错」的结果，
 * 比明确地说「这个模式画布上不支持」糟糕得多。
 */
export function canvasCompositeFor(blendMode: BlendMode | undefined): GlobalCompositeOperation | undefined {
  if (!blendMode || blendMode === "normal") return undefined;
  return CANVAS_COMPOSITE[blendMode];
}

/** 混合模式是否能在 Canvas 2D 上表达。 */
export function isBlendModeSupportedOnCanvas(blendMode: BlendMode | undefined): boolean {
  if (!blendMode || blendMode === "normal") return true;
  return CANVAS_COMPOSITE[blendMode] !== undefined;
}

/** 混合模式 → CSS `mix-blend-mode` 的值；`normal` 返回 undefined（不写进 CSS）。 */
export function cssBlendMode(blendMode: BlendMode | undefined): string | undefined {
  if (!blendMode || blendMode === "normal") return undefined;
  return blendMode;
}
