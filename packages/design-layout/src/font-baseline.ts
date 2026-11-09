/**
 * 跨平台字体度量基线。 *
 * 文本宽度取决于宿主字体引擎：同一段文字在 Windows 的 Chrome 与 macOS 的 Safari
 * 上宽度不同，hug 文本节点的尺寸与换行点随之改变，画布与导出物就对不上。已有
 * 的像素回归基线绑定本机字体，换台机器就会红——但那是**结论**，不是**原因**。
 *
 * 这个模块把「字体度量」单独拆出来做基线：
 *
 * - 样例集固定（`fontBaselineCases()`），覆盖中英文混排、纯中文、字重、斜体、
 *   字距与固定宽度下的换行——这些是差异最大的维度；
 * - 采集与比较走**与编辑器完全相同**的测量代码（浏览器侧用
 *   `createBrowserTextMeasurer()`），否则测的不是画布用的那条路；
 * - 基线文件记录**平台指纹**（系统、浏览器、字体），换机器时差异是「可解释」的：
 *   能说清"基线来自 Windows/Chrome，当前是 macOS/Safari"，而不是含糊的"不一致"。
 *
 * 本模块只管数据结构、样例集与比较逻辑；采集脚本在 `studio-web/visual/font-baseline.ts`。
 */

/** 一个测量样例。 */
export interface FontBaselineCase {
  /** 稳定标识；基线与实测靠它对齐。 */
  id: string;
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: number;
  fontStyle?: "normal" | "italic";
  letterSpacing?: number;
  /** 固定可用宽度：用来测换行点。 */
  availableWidth?: number;
  /** 行高；缺省用 `DEFAULT_BASELINE_LINE_HEIGHT`。 */
  lineHeight?: number;
}

/** 样例的实测结果。 */
export interface FontBaselineEntry extends FontBaselineCase {
  /** 实测宽度（px）。 */
  width: number;
  /** 实测高度（px）＝行数 × 行高。 */
  height: number;
  /** 行数；换行点变了它就会变。 */
  lines: number;
}

/** 基线文件里的平台指纹。 */
export interface FontBaselineEnvironment {
  /** 操作系统（`win32` / `darwin` / `linux`）。 */
  os: string;
  /** 系统版本。 */
  osRelease?: string;
  /** 浏览器与版本（从 user agent 解析）。 */
  browser?: string;
  /** 原始 user agent。 */
  userAgent?: string;
  /** 采样时间（ISO）。 */
  generatedAt: string;
}

/** 一份字体度量基线。 */
export interface FontBaseline {
  environment: FontBaselineEnvironment;
  cases: FontBaselineEntry[];
}

/**
 * 默认容差。
 *
 * 宽度容差 0.5px：同一台机器上不同 GPU / 光栅化后端会让 canvas 度量有零点几
 * 像素的抖动，0.5px 以内不算漂移。高度容差取 0：行数变了就是换行点变了，
 * 那不是"漂移"，是行为改变，必须让人看见。
 */
export const FONT_BASELINE_TOLERANCE = { width: 0.5, height: 0 } as const;

/**
 * 固定样例集。
 *
 * 挑样例的原则是**差异最大**：中英混排（全宽与半宽混排）、纯中文、字重变化
 * （同一族名的粗体宽 6% 左右）、斜体、字距、以及固定宽度下的换行点。
 * 少了任何一个维度，基线都会漏掉一类跨平台漂移。
 */
export function fontBaselineCases(): FontBaselineCase[] {
  return [
    { id: "latin-400-14", text: "The quick brown fox jumps over the lazy dog", fontFamily: "Inter", fontSize: 14, fontWeight: 400 },
    { id: "latin-700-14", text: "The quick brown fox jumps over the lazy dog", fontFamily: "Inter", fontSize: 14, fontWeight: 700 },
    { id: "cjk-400-14", text: "设计系统里的排版基线", fontFamily: "Inter", fontSize: 14, fontWeight: 400 },
    { id: "mixed-400-16", text: "混合 Mixed 文本 123", fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
    { id: "italic-400-16", text: "Italic metrics differ", fontFamily: "Inter", fontSize: 16, fontWeight: 400, fontStyle: "italic" },
    { id: "spacing-05-16", text: "Letter spaced", fontFamily: "Inter", fontSize: 16, fontWeight: 400, letterSpacing: 0.5 },
    { id: "wrap-latin-200", text: "Wrapping at two hundred pixels decides where the line breaks and therefore the height of a hugging text node.", fontFamily: "Inter", fontSize: 14, fontWeight: 400, availableWidth: 200 },
    { id: "wrap-cjk-120", text: "中文换行的断点同样要稳定下来，否则画布和导出物会对不上。", fontFamily: "Inter", fontSize: 14, fontWeight: 400, availableWidth: 120 },
    { id: "serif-400-18", text: "Serif family metrics", fontFamily: "Georgia", fontSize: 18, fontWeight: 400 },
    { id: "mono-400-13", text: "monospace 0123456789", fontFamily: "monospace", fontSize: 13, fontWeight: 400 },
  ];
}

/** 一个样例的差异。 */
export interface FontBaselineDiff {
  id: string;
  expectedWidth: number;
  actualWidth: number;
  widthDelta: number;
  expectedHeight: number;
  actualHeight: number;
  heightDelta: number;
  expectedLines: number;
  actualLines: number;
  /** 断行点变了：比宽度漂移更致命，导出物的行数会跟着变。 */
  lineBreakChanged: boolean;
}

/** 缺失的样例：基线里有、实测里没有（或反过来）。 */
export interface FontBaselineMissing {
  id: string;
  where: "baseline" | "actual";
}

/**
 * 比较两份基线。
 *
 * 按 id 对齐（不按顺序）——样例集调整顺序时不该报差异。
 */
export function compareFontBaseline(
  expected: FontBaseline,
  actual: FontBaseline,
  tolerance: { width?: number; height?: number } = {},
): { diffs: FontBaselineDiff[]; missing: FontBaselineMissing[] } {
  const widthTolerance = tolerance.width ?? FONT_BASELINE_TOLERANCE.width;
  const heightTolerance = tolerance.height ?? FONT_BASELINE_TOLERANCE.height;
  const expectedById = new Map(expected.cases.map(entry => [entry.id, entry]));
  const actualById = new Map(actual.cases.map(entry => [entry.id, entry]));

  const diffs: FontBaselineDiff[] = [];
  const missing: FontBaselineMissing[] = [];
  for (const [id, base] of expectedById) {
    const current = actualById.get(id);
    if (!current) {
      missing.push({ id, where: "actual" });
      continue;
    }
    const widthDelta = current.width - base.width;
    const heightDelta = current.height - base.height;
    const lineBreakChanged = current.lines !== base.lines;
    // 非有限值（NaN / null）一律算差异：一份含 NaN 的基线不是"一致"，是"没测到"。
    const usable = Number.isFinite(current.width) && Number.isFinite(base.width)
      && Number.isFinite(current.height) && Number.isFinite(base.height)
      && Number.isFinite(current.lines) && Number.isFinite(base.lines);
    const widthOff = !usable || Math.abs(widthDelta) > widthTolerance;
    const heightOff = !usable || Math.abs(heightDelta) > heightTolerance;
    if (widthOff || heightOff || lineBreakChanged) {
      diffs.push({
        id,
        expectedWidth: base.width,
        actualWidth: current.width,
        widthDelta,
        expectedHeight: base.height,
        actualHeight: current.height,
        heightDelta,
        expectedLines: base.lines,
        actualLines: current.lines,
        lineBreakChanged,
      });
    }
  }
  for (const id of actualById.keys()) {
    if (!expectedById.has(id)) missing.push({ id, where: "baseline" });
  }
  return { diffs, missing };
}

/**
 * 描述两份基线的平台差异。
 *
 * 换机器跑 check 时，这句话比"差异超标"有用得多：它说明差异是**预期的**
 * （平台不同）还是**可疑的**（同一台机器上突然变了）。
 */
export function describeEnvironmentDifference(expected: FontBaseline, actual: FontBaseline): string | undefined {
  const parts: string[] = [];
  if (expected.environment.os !== actual.environment.os) {
    parts.push(`系统 ${expected.environment.os} → ${actual.environment.os}`);
  } else if (expected.environment.osRelease && actual.environment.osRelease && expected.environment.osRelease !== actual.environment.osRelease) {
    parts.push(`系统版本 ${expected.environment.osRelease} → ${actual.environment.osRelease}`);
  }
  if (expected.environment.browser && actual.environment.browser && expected.environment.browser !== actual.environment.browser) {
    parts.push(`浏览器 ${expected.environment.browser} → ${actual.environment.browser}`);
  }
  return parts.length ? parts.join("；") : undefined;
}

/**
 * 缺省行高。
 *
 * `TextNode.lineHeight` 在 schema 里是必填的（没有缺省值），但基线样例需要一份
 * 统一的缺省：行数换算成高度时用它。
 */
export const DEFAULT_BASELINE_LINE_HEIGHT = 20;
