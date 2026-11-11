import type { FontStyle } from "./types";

/**
 * 段内样式覆盖。
 *
 * 只放「一段文字里能变的东西」：字重、字形、颜色、字号。
 *
 * `lineHeight`（px）是唯一的例外：它不进这里做排版参数，而是作为**行盒高度下限**
 * 参与行高计算——行盒高度 = max(节点级 lineHeight, 该行所有 run 的 lineHeight,
 * 该行最大字号)。它不改换行位置（换行只看字号与宽度），只把所在的行撑高。
 */
export interface TextRunStyle {
  fontWeight?: number;
  fontStyle?: FontStyle;
  /** 字号（px）；缺省沿用节点级字号。会同时影响换行与行高。 */
  fontSize?: number;
  color?: string;
  /** 行高（px）；缺省沿用节点级行高。只抬高所在行的行盒，不影响换行位置。 */
  lineHeight?: number;
}

/**
 * 一段样式区间。
 *
 * `from` / `to` 是 **UTF-16 字符下标**，也就是 `textarea.selectionStart/End` 的取值口径——
 * 选区换算是这个功能最频繁的入口，换一套坐标系（码点数、字节）只会制造 off-by-one。
 */
export interface TextRun {
  from: number;
  to: number;
  style: TextRunStyle;
}

export interface TextRunSegment {
  text: string;
  style: TextRunStyle;
}

/** 段内样式的字段名；UI 与校验共用，避免两处各写一份。 */
export const TEXT_RUN_STYLE_FIELDS = ["fontWeight", "fontStyle", "fontSize", "color", "lineHeight"] as const;

export function isEmptyRunStyle(style: TextRunStyle): boolean {
  return style.fontWeight === undefined && style.fontStyle === undefined && style.fontSize === undefined && style.color === undefined && style.lineHeight === undefined;
}

export function sameRunStyle(a: TextRunStyle, b: TextRunStyle): boolean {
  return a.fontWeight === b.fontWeight
    && a.fontStyle === b.fontStyle
    && a.fontSize === b.fontSize
    && a.color === b.color
    && a.lineHeight === b.lineHeight;
}

/** 该下标是否落在代理对中间。UTF-16 下标可以切在 emoji 中间，那样切出来的两半都不是合法字符。 */
export function isCodePointBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  const isHigh = before >= 0xd800 && before <= 0xdbff;
  const isLow = at >= 0xdc00 && at <= 0xdfff;
  return !(isHigh && isLow);
}

function validateRunStyle(style: TextRunStyle, index: number): string | undefined {
  if (!style || typeof style !== "object") return `runs.${index}.style is required`;
  if (isEmptyRunStyle(style)) return `runs.${index}.style must set at least one field`;
  if (style.fontWeight !== undefined
    && (!Number.isInteger(style.fontWeight) || style.fontWeight < 100 || style.fontWeight > 900)) {
    return `runs.${index}.style.fontWeight must be an integer between 100 and 900`;
  }
  if (style.fontStyle !== undefined && style.fontStyle !== "normal" && style.fontStyle !== "italic") {
    return `runs.${index}.style.fontStyle must be normal or italic`;
  }
  if (style.fontSize !== undefined && (!Number.isFinite(style.fontSize) || style.fontSize <= 0)) {
    return `runs.${index}.style.fontSize must be a positive number`;
  }
  if (style.color !== undefined && (typeof style.color !== "string" || !style.color.trim())) {
    return `runs.${index}.style.color must be a non-empty string`;
  }
  if (style.lineHeight !== undefined && (!Number.isFinite(style.lineHeight) || style.lineHeight <= 0)) {
    return `runs.${index}.style.lineHeight must be a positive number`;
  }
  return undefined;
}

/**
 * 校验一段 runs 是否与 text 自洽：区间在文本内、按顺序、互不重叠、不切断代理对、样式合法。
 *
 * 返回错误信息而不是抛异常，因为 schema 的 zod refine 和运行时命令都要用它，
 * 前者只能把错误塞进 issue，后者要包成 CommandError。
 */
export function validateTextRuns(text: string, runs: readonly TextRun[] | undefined): string | undefined {
  if (!runs || !runs.length) return undefined;
  let previousTo = 0;
  for (const [index, run] of runs.entries()) {
    if (!Number.isInteger(run.from) || !Number.isInteger(run.to)) return `runs.${index}.from/to must be integers`;
    if (run.from < 0 || run.to > text.length) return `runs.${index} must fall inside the text (0-${text.length})`;
    if (run.from >= run.to) return `runs.${index}.from must be smaller than runs.${index}.to`;
    if (run.from < previousTo) return `runs.${index} overlaps the previous run`;
    if (!isCodePointBoundary(text, run.from) || !isCodePointBoundary(text, run.to)) {
      return `runs.${index} splits a surrogate pair`;
    }
    const styleError = validateRunStyle(run.style, index);
    if (styleError) return styleError;
    previousTo = run.to;
  }
  return undefined;
}

/** 排序并把相邻同款样式的区间合并；重叠区间按输入顺序后者截断（调用方应先用 validate 拒绝重叠）。 */
export function mergeTextRuns(runs: readonly TextRun[]): TextRun[] {
  const sorted = runs
    .filter(run => run.to > run.from)
    .map(run => ({ from: run.from, to: run.to, style: { ...run.style } }))
    .sort((a, b) => a.from - b.from);
  const merged: TextRun[] = [];
  for (const run of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.to === run.from && sameRunStyle(last.style, run.style)) last.to = run.to;
    else merged.push(run);
  }
  return merged;
}

/**
 * 把样式应用到一段区间（选区）。
 *
 * 会被这段区间切开的旧区间一分为二，因此样式支持部分重叠；传空样式表示**清除**该区间
 * 的覆盖（回到节点级样式）。
 */
export function applyTextRunStyle(
  text: string,
  runs: readonly TextRun[] | undefined,
  from: number,
  to: number,
  style: TextRunStyle,
): TextRun[] {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(0, Math.min(to, text.length));
  const next: TextRun[] = [];
  for (const run of runs ?? []) {
    if (run.to <= start || run.from >= end) {
      next.push({ from: run.from, to: run.to, style: { ...run.style } });
      continue;
    }
    if (run.from < start) next.push({ from: run.from, to: start, style: { ...run.style } });
    if (run.to > end) next.push({ from: end, to: run.to, style: { ...run.style } });
  }
  if (end > start && !isEmptyRunStyle(style)) next.push({ from: start, to: end, style: { ...style } });
  return mergeTextRuns(next);
}

/**
 * 文本被改写后把 runs 重新对齐到新文本。
 *
 * 用「最长公共前缀 + 最长公共后缀」定位改动区间：
 * - 改动点之前的区间原样保留；
 * - 改动点之后的区间整体平移（插入或删除带来的位移）；
 * - 跨在改动区间上的区间夹到新文本范围内。
 *
 * 不这么做的话，在段首插入一个字就会让「加粗的那一段」整体错位一个字。
 */
export function remapTextRuns(oldText: string, newText: string, runs: readonly TextRun[] | undefined): TextRun[] {
  if (!runs?.length) return [];
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < limit - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;
  const delta = newText.length - oldText.length;
  const tailStart = oldText.length - suffix;
  const remapped: TextRun[] = [];
  for (const run of runs) {
    if (run.to <= prefix) {
      remapped.push({ from: run.from, to: run.to, style: { ...run.style } });
      continue;
    }
    if (run.from >= tailStart) {
      remapped.push({ from: run.from + delta, to: run.to + delta, style: { ...run.style } });
      continue;
    }
    // 跨在改动区间上：起点若落在被替换区内部，就退到替换区起点；
    // 终点若在被替换区内部，说明尾部被删掉了，截断到替换区起点。
    const from = run.from < prefix ? run.from : prefix;
    const to = run.to > tailStart ? run.to + delta : prefix;
    if (to > from) remapped.push({ from, to, style: { ...run.style } });
  }
  return clampTextRuns(newText, remapped);
}

/**
 * 文本被改写后修剪 runs：越界部分裁掉，完全失效的区间丢弃。
 *
 * 这是有损的（缩到 0 长度就没了），但比「让偏移静默指向错位的文字」可接受——
 * 后者会让用户看到一段随机加粗的文字。需要保留相对位置时用 {@link remapTextRuns}。
 */
export function clampTextRuns(text: string, runs: readonly TextRun[] | undefined): TextRun[] {
  if (!runs?.length) return [];
  const clamped: TextRun[] = [];
  for (const run of runs) {
    const from = Math.max(0, Math.min(run.from, text.length));
    const to = Math.max(0, Math.min(run.to, text.length));
    if (to <= from) continue;
    if (!isCodePointBoundary(text, from) || !isCodePointBoundary(text, to)) continue;
    clamped.push({ from, to, style: { ...run.style } });
  }
  return mergeTextRuns(clamped);
}

/**
 * 把 text + runs 展开成覆盖全文的连续片段，空隙部分用空样式（继承节点级样式）。
 *
 * 渲染、导出、测量都从这里出发，避免三处各自实现「哪一段用什么样式」。
 */
export function textRunSegments(text: string, runs: readonly TextRun[] | undefined): TextRunSegment[] {
  if (!text) return [];
  const sorted = mergeTextRuns(runs ?? []);
  const segments: TextRunSegment[] = [];
  let cursor = 0;
  for (const run of sorted) {
    if (run.from > cursor) segments.push({ text: text.slice(cursor, run.from), style: {} });
    segments.push({ text: text.slice(run.from, run.to), style: { ...run.style } });
    cursor = run.to;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), style: {} });
  return segments;
}

/** 某个下标处的段内样式（用于面板回显选区当前样式）。 */
export function runStyleAt(text: string, runs: readonly TextRun[] | undefined, index: number): TextRunStyle {
  for (const run of runs ?? []) {
    if (index >= run.from && index < run.to) return { ...run.style };
  }
  return {};
}

/**
 * 取出一段字符区间内的段内样式片段。
 *
 * 段落级导出需要「按段切片」：每个段落单独成块，块内的 `<span>` / `<tspan>`
 * 只能覆盖本段的那部分文字。`textRunSegments` 给出的是全文切片，所以这里
 * 再按区间裁一次。
 *
 * 区间是 UTF-16 下标，与 `text.slice` 的口径一致，切代理对不会被劈开
 * （调用方给的 from/to 已经是合法边界）。
 */
export function textRunSegmentsInRange(
  text: string,
  runs: readonly TextRun[] | undefined,
  from: number,
  to: number,
): TextRunSegment[] {
  if (to <= from) return [];
  const segments = textRunSegments(text, runs);
  const output: TextRunSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    const start = offset;
    const end = offset + segment.text.length;
    offset = end;
    if (end <= from || start >= to) continue;
    const sliceStart = Math.max(from, start) - start;
    const sliceEnd = Math.min(to, end) - start;
    output.push({ text: segment.text.slice(sliceStart, sliceEnd), style: segment.style });
  }
  return output;
}
