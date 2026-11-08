/**
 * SVG path data 导入解析器。
 *
 * 语义对齐自 Penpot 的 `common/src/app/common/svg/path/parser.js`（MPL-2.0）。
 * 这里**只借鉴算法与语法覆盖范围**，不复制其数据结构与代码表达——
 * Penpot 的解析器产出 ClojureScript 关键字 map，本项目产出 `PathCommand[]`，
 * 直接进既有渲染/命中/导出管线。详见 `docs/penpot-porting.md`。
 *
 * 覆盖 Penpot 支持的全部命令：`M/L/C/Q/A/H/V/S/T/Z` 及小写相对形式，
 * 以及隐式命令（`M` 后续坐标按 `L` 处理，`m` 按 `l` 处理）。
 *
 * 与既有 `parseVectorPath` 的分工：
 * - `parseVectorPath` 读的是**本项目自己写出来的**归一化路径，语法严格（只 M/L/C/Q/Z，
 *   在曲线上的点必须落在 [0,1]），是文档格式的一部分。
 * - `parseSvgPath` 读的是**外部来的**SVG path data，语法宽松（支持全部命令与相对形式），
 *   解析后统一展开成绝对坐标的 M/L/C/Q，再由调用方归一化。
 *
 * 一条铁律：**任何非法输入都让整条路径作废**（返回 `undefined`），不做「尽力而为」的
 * 部分解析。丢掉一半路径会画出和原意完全不同的图形——那比明确失败更危险。
 */

import { calculateArcBeziers } from "./arc-to-bezier";
import type { PathCommand, PathPoint } from "./geometry";

/** SVG 允许的所有 path 命令字母。 */
const VALID_COMMANDS = new Set([
  "M", "L", "C", "Q", "A", "H", "V", "S", "T", "Z",
  "m", "l", "c", "q", "a", "h", "v", "s", "t", "z",
]);

interface Cursor {
  readonly source: string;
  index: number;
}

/** 跳过空白与逗号分隔符。 */
function skipSeparators(cursor: Cursor): void {
  while (cursor.index < cursor.source.length) {
    const char = cursor.source[cursor.index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === ",") {
      cursor.index += 1;
      continue;
    }
    break;
  }
}

/**
 * 读一个数字。
 *
 * SVG 的数字语法允许 `+` / `-` 开头、小数点开头、指数。
 * 额外允许 `1.5.5` 这种「两个数字连写」的简写——SVG 规范允许省略分隔符，
 * 实际文件（尤其从设计工具导出的）里很常见。
 */
function readNumber(cursor: Cursor): number | undefined {
  skipSeparators(cursor);
  const match = /^[+-]?(\d*\.\d+|\d+\.?)([eE][+-]?\d+)?/.exec(cursor.source.slice(cursor.index));
  if (!match) return undefined;
  cursor.index += match[0].length;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 读一个弧标志。
 *
 * SVG 规范里 `large-arc-flag` / `sweep-flag` 只能写单个 `0` 或 `1`；
 * 但也有文件写成 `01` 或 `10`（两个标志连写），这里按「逐位读取」处理。
 */
function readArcFlag(cursor: Cursor): number | undefined {
  skipSeparators(cursor);
  const char = cursor.source[cursor.index];
  if (char === "0") {
    cursor.index += 1;
    return 0;
  }
  if (char === "1") {
    cursor.index += 1;
    return 1;
  }
  return undefined;
}

/**
 * 读一个命令字母。
 *
 * 返回 `undefined` 有两种含义，必须区分：
 * - 当前字符不是字母 → 可能是**隐式命令**（省略命令字母重复坐标）；
 * - 当前字符是字母但不认识 → **非法路径**，整条作废。
 *
 * 这两种混为一谈会让 `M 0 0 X 10 10` 被当成 `M 0 0 L 10 10` 解析成功——
 * 画出来的东西和原意完全不同。
 */
function readCommand(cursor: Cursor): { command: string } | { invalid: true } | undefined {
  skipSeparators(cursor);
  const char = cursor.source[cursor.index];
  if (char === undefined) return undefined;
  // 数字/正负号/小数点开头 → 隐式命令，不是命令字母。
  if (/[0-9+\-.]/.test(char)) return undefined;
  if (!VALID_COMMANDS.has(char)) return { invalid: true };
  cursor.index += 1;
  return { command: char };
}

export interface SvgPathParseOptions {
  /**
   * 缩放系数。导入时常按目标尺寸缩放，解析阶段就乘进去比事后整体缩放更省事。
   */
  scale?: number;
  /**
   * 平移量（在缩放之后叠加）。
   */
  offset?: PathPoint;
}

/**
 * 解析 SVG path data，产出绝对坐标的 `PathCommand[]`。
 *
 * 返回的路径里只有 `M` / `L` / `C` / `Q` / `Z`：
 * - `H` / `V` 展开成 `L`；
 * - `S` 展开成 `C`（控制点按 SVG 规范镜像上一个曲线的控制点）；
 * - `T` 展开成 `Q`（控制点镜像上一个二次曲线的控制点）；
 * - `A` 展开成若干段 `C`（每段不超过 90°）。
 *
 * 相对命令在解析时就转成绝对坐标。
 *
 * 非法输入返回 `undefined`——不返回部分结果。
 */
export function parseSvgPath(d: string, options: SvgPathParseOptions = {}): PathCommand[] | undefined {
  if (typeof d !== "string" || !d.trim()) return undefined;

  const scale = options.scale ?? 1;
  const offsetX = options.offset?.x ?? 0;
  const offsetY = options.offset?.y ?? 0;

  const cursor: Cursor = { source: d, index: 0 };
  const commands: PathCommand[] = [];

  /** 当前子路径的起点，`Z` 之后回到这里。 */
  let current: PathPoint | undefined;
  /** 当前子路径的起点（`M` 落点），与 `current` 的区别是 `Z` 会重置 `current` 到它。 */
  let subpathStart: PathPoint | undefined;
  /** 上一个曲线的控制点，`S` / `T` 用来镜像。 */
  let lastCubicControl: PathPoint | undefined;
  let lastQuadraticControl: PathPoint | undefined;
  /** 上一个命令的字母，用于判断隐式命令。 */
  let previousCommand: string | undefined;

  const scalePoint = (x: number, y: number): PathPoint => ({ x: x * scale + offsetX, y: y * scale + offsetY });

  /**
   * 相对坐标转绝对。
   *
   * 相对量只缩放、**不平移**：平移已经体现在 `base` 里了。
   * （若这里也调 `scalePoint`，相对量会被二次缩放——这是最容易写错的一处。）
   */
  const resolve = (x: number, y: number, relative: boolean): PathPoint => {
    if (!relative) return scalePoint(x, y);
    const base = current ?? { x: 0, y: 0 };
    return { x: base.x + x * scale, y: base.y + y * scale };
  };

  while (true) {
    skipSeparators(cursor);
    if (cursor.index >= cursor.source.length) break;

    let command: string | undefined;
    const read = readCommand(cursor);
    if (read && "invalid" in read) return undefined;
    if (read) command = read.command;

    if (command === undefined) {
      // 隐式命令：上一个命令的坐标可以省略命令字母重复。
      // `M`/`m` 之后的重复坐标按 `L`/`l` 处理（SVG 规范如此）。
      if (previousCommand === undefined) return undefined;
      const upper = previousCommand.toUpperCase();
      if (upper === "Z") return undefined;
      if (upper === "M") command = previousCommand === "M" ? "L" : "l";
      else command = previousCommand;
    }

    const upper = command.toUpperCase();
    const relative = command !== upper;

    if (upper === "Z") {
      if (!subpathStart) return undefined;
      commands.push({ command: "Z" });
      current = subpathStart;
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "M") {
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;
      const point = resolve(x, y, relative);
      commands.push({ command: "M", point });
      current = point;
      subpathStart = point;
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "L") {
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;
      const point = resolve(x, y, relative);
      commands.push({ command: "L", point });
      current = point;
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "H") {
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const base = current ?? { x: 0, y: 0 };
      const point = { x: relative ? base.x + x * scale : x * scale + offsetX, y: base.y };
      commands.push({ command: "L", point });
      current = point;
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "V") {
      const y = readNumber(cursor);
      if (y === undefined) return undefined;
      const base = current ?? { x: 0, y: 0 };
      const point = { x: base.x, y: relative ? base.y + y * scale : y * scale + offsetY };
      commands.push({ command: "L", point });
      current = point;
      lastCubicControl = undefined;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "C") {
      const x1 = readNumber(cursor);
      if (x1 === undefined) return undefined;
      const y1 = readNumber(cursor);
      if (y1 === undefined) return undefined;
      const x2 = readNumber(cursor);
      if (x2 === undefined) return undefined;
      const y2 = readNumber(cursor);
      if (y2 === undefined) return undefined;
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;

      const control1 = resolve(x1, y1, relative);
      const control2 = resolve(x2, y2, relative);
      const point = resolve(x, y, relative);
      commands.push({ command: "C", control1, control2, point });
      current = point;
      lastCubicControl = control2;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "S") {
      const x2 = readNumber(cursor);
      if (x2 === undefined) return undefined;
      const y2 = readNumber(cursor);
      if (y2 === undefined) return undefined;
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;

      // SVG 规范：若上一命令不是 C/S，则第一个控制点与当前点重合。
      const previousUpper = previousCommand?.toUpperCase();
      const control1 =
        previousUpper === "C" || previousUpper === "S"
          ? { x: 2 * current!.x - lastCubicControl!.x, y: 2 * current!.y - lastCubicControl!.y }
          : { x: current!.x, y: current!.y };
      const control2 = resolve(x2, y2, relative);
      const point = resolve(x, y, relative);
      commands.push({ command: "C", control1, control2, point });
      current = point;
      lastCubicControl = control2;
      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "Q") {
      const x1 = readNumber(cursor);
      if (x1 === undefined) return undefined;
      const y1 = readNumber(cursor);
      if (y1 === undefined) return undefined;
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;

      const control = resolve(x1, y1, relative);
      const point = resolve(x, y, relative);
      commands.push({ command: "Q", control, point });
      current = point;
      lastQuadraticControl = control;
      lastCubicControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "T") {
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;

      const previousUpper = previousCommand?.toUpperCase();
      const control =
        previousUpper === "Q" || previousUpper === "T"
          ? { x: 2 * current!.x - lastQuadraticControl!.x, y: 2 * current!.y - lastQuadraticControl!.y }
          : { x: current!.x, y: current!.y };
      const point = resolve(x, y, relative);
      commands.push({ command: "Q", control, point });
      current = point;
      lastQuadraticControl = control;
      lastCubicControl = undefined;
      previousCommand = command;
      continue;
    }

    if (upper === "A") {
      const rx = readNumber(cursor);
      if (rx === undefined) return undefined;
      const ry = readNumber(cursor);
      if (ry === undefined) return undefined;
      const rotation = readNumber(cursor);
      if (rotation === undefined) return undefined;
      const largeArc = readArcFlag(cursor);
      if (largeArc === undefined) return undefined;
      const sweep = readArcFlag(cursor);
      if (sweep === undefined) return undefined;
      const x = readNumber(cursor);
      if (x === undefined) return undefined;
      const y = readNumber(cursor);
      if (y === undefined) return undefined;

      const from = current ?? { x: 0, y: 0 };
      const to = resolve(x, y, relative);

      // 半径为 0 时 SVG 规范规定当作直线。
      if (rx === 0 || ry === 0) {
        commands.push({ command: "L", point: to });
        current = to;
        lastCubicControl = undefined;
        lastQuadraticControl = undefined;
        previousCommand = command;
        continue;
      }

      // 圆弧用贝塞尔近似（语义对齐 Penpot 的 arc_to_bezier）。
      // 缩放与平移在这里一次性施加——近似是在单位圆上算的，先换算再算会引入额外误差。
      const beziers = calculateArcBeziers(
        from.x,
        from.y,
        to.x,
        to.y,
        largeArc,
        sweep,
        rx * scale,
        ry * scale,
        rotation,
      );

      for (const curve of beziers) {
        const control1 = { x: curve[0]!, y: curve[1]! };
        const control2 = { x: curve[2]!, y: curve[3]! };
        const point = { x: curve[4]!, y: curve[5]! };
        commands.push({ command: "C", control1, control2, point });
        current = point;
        lastCubicControl = control2;
      }

      lastQuadraticControl = undefined;
      previousCommand = command;
      continue;
    }

    return undefined;
  }

  return commands.length ? commands : undefined;
}
