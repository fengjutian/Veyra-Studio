/**
 * 字体集指纹的采集。
 *
 * 像素基线比的是「这台机器上这个浏览器渲染出来的画面」。字体一换，画面就变——
 * 这时候像素差异**不是**渲染回归。指纹的作用就是先把这件事说清楚。
 *
 * 测量走**编辑器同一条路径**（`createBrowserTextMeasurer()`，canvas
 * `measureText`），测出来的才是画布实际会用的度量；用估算器测，任何机器结果
 * 都一样，等于没测。
 */
import { DEFAULT_BASELINE_LINE_HEIGHT, fontBaselineCases, fontSetDigest, type FontBaselineEntry } from "@ufira/design-layout";
import { defaultAppearance, defaultLayout, type TextNode } from "@ufira/design-schema";
import { createBrowserTextMeasurer } from "./browser-text-measurer";

/** 字体集指纹。 */
export interface FontFingerprint {
  /** 样例度量的摘要；与基线里的摘要不同即代表字体集变了。 */
  digest: string;
  /** 逐样例的实测值（便于人工核对差异出在哪个维度）。 */
  samples: FontBaselineEntry[];
}

/** 量到小数点后三位：再往下就是浮点噪声，不是度量差异。 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toTextNode(entry: {
  id: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  letterSpacing?: number;
  lineHeight?: number;
}): TextNode {
  return {
    id: entry.id,
    type: "text",
    name: entry.id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    text: entry.text,
    fontFamily: entry.fontFamily,
    fontSize: entry.fontSize,
    lineHeight: entry.lineHeight ?? DEFAULT_BASELINE_LINE_HEIGHT,
    fontWeight: entry.fontWeight ?? 400,
    fontStyle: entry.fontStyle ?? "normal",
    letterSpacing: entry.letterSpacing ?? 0,
  };
}

/**
 * 量一遍固定样例，算出字体集指纹。
 *
 * 样例集与 `fontBaselineCases()` 一致：覆盖中英混排、字重、斜体、字距与换行
 * 点——这些是跨平台差异最大的维度。
 */
export function measureFontFingerprint(): FontFingerprint {
  const measurer = createBrowserTextMeasurer();
  const samples: FontBaselineEntry[] = fontBaselineCases().map(entry => {
    const size = measurer.measure(toTextNode(entry), entry.availableWidth);
    return {
      ...entry,
      width: round(size.width),
      height: round(size.height),
      lines: Math.round(size.height / (entry.lineHeight ?? DEFAULT_BASELINE_LINE_HEIGHT)),
    };
  });
  return { digest: fontSetDigest(samples), samples };
}
