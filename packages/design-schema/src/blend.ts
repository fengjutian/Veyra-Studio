/**
 * 混合模式在 Canvas / CSS / SVG 三处的名字映射。
 *
 * 取值集合与 CSS `mix-blend-mode` 对齐，Canvas 的 `globalCompositeOperation`
 * 里也有同名的一整套混合模式——**名字相同，语义也相同**。
 *
 * 这不是查文档得出的，是实测的：`packages/studio-web/visual/blend-probe.ts`
 * 让浏览器在同一张图里用 CSS 和 Canvas 各画一遍，逐像素比对，16/16 一致
 * （包括 `hue` / `saturation` / `color` / `luminosity` 这四种颜色类混合）。
 * 初版曾断言「Canvas 没有颜色类混合」，是错的，已按实测改正。
 *
 * 真正的差别不在名字，而在**作用域**：Canvas 的合成操作是「就地」的，
 * 它把正在画的内容与画布上已有内容混合，没有「把一个图层组整体混合」的概念。
 * 图层级语义要靠离屏合成实现，那是渲染层的事，不在本文件的范围内。
 */

import type { BlendMode } from "./types";

/**
 * Canvas 2D 的合成操作名。
 *
 * 本包不引入 DOM lib，所以这里自己声明一份与 `GlobalCompositeOperation` 同名的子集——
 * 值与浏览器一致，赋值给 `context.globalCompositeOperation` 时类型也兼容。
 */
export type CanvasCompositeOperation =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

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
 * 混合模式 → Canvas 的合成操作。
 *
 * Canvas 的合成操作名与 CSS 的混合模式名**逐字相同**，所以这张表只是
 * 「类型 + 缺省值」两件事：名字一一对应，`normal` 对应 `source-over`。
 */
const CANVAS_COMPOSITE: Record<BlendMode, CanvasCompositeOperation> = {
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
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/**
 * 混合模式 → Canvas 的合成操作。
 *
 * `normal`（以及没设混合模式）返回 `undefined`——那是缺省行为，
 * 调用方不需要动 `globalCompositeOperation`。
 */
export function canvasCompositeFor(blendMode: BlendMode | undefined): CanvasCompositeOperation | undefined {
  if (!blendMode || blendMode === "normal") return undefined;
  return CANVAS_COMPOSITE[blendMode];
}

/**
 * 混合模式是否能在 Canvas 2D 上表达。
 *
 * 16 种全部可以（见文件头的实测结论）。保留这个函数是为了让调用方
 * 仍然有一处显式的判据，而不是各自 `switch` 一遍。
 */
export function isBlendModeSupportedOnCanvas(blendMode: BlendMode | undefined): boolean {
  if (!blendMode || blendMode === "normal") return true;
  return CANVAS_COMPOSITE[blendMode] !== undefined;
}

/** 混合模式 → CSS `mix-blend-mode` 的值；`normal` 返回 undefined（不写进 CSS）。 */
export function cssBlendMode(blendMode: BlendMode | undefined): string | undefined {
  if (!blendMode || blendMode === "normal") return undefined;
  return blendMode;
}
