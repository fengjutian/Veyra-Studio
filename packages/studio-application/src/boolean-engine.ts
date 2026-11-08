import paper from "paper/dist/paper-core.js";
import { setBooleanEngine, type BooleanOperation, type PathCommand } from "@ufira/design-schema";

/**
 * 曲线级布尔引擎（paper.js）。
 *
 * 之前布尔运算的结果是把曲线**离散成折线**再做多边形布尔：两个圆合并出来是
 * 一圈锯齿。paper.js 的布尔运算直接在贝塞尔曲线上做，结果保留曲线段
 * （实测两个半径 40、圆心距 40 的圆合并 → 8 段三次贝塞尔，面积 8089.71，
 * 解析解 8087.70，误差 0.02%）。
 *
 * 选型依据见 `docs/boolean-and-mask.md`：
 * - paper.js（MIT）：成熟、纯几何、Node 与浏览器都能跑，`paper-core` 不带 DOM 依赖；
 * - 其它候选（clipper2 / svg-path-boolean）要么是折线算法，要么需要 wasm 异步初始化。
 *
 * 引擎是**注入**给 schema 层的（`setBooleanEngine`）：核心包不依赖几何库，
 * 没装引擎时自动退回多边形近似。
 *
 * paper 的官方类型是 `export =` 风格（类都在 `paper` 命名空间里），
 * 这里用一份最小的结构类型描述我们真正用到的那几个成员——既不跟它的
 * `.d.ts` 打架，也让这段代码在 Node 与浏览器里行为一致。
 */

/** paper 的点。 */
interface PaperPoint {
  x: number;
  y: number;
}

/** paper 的段：所有段都是同一个类，靠相对的 `handleIn` / `handleOut` 区分形状。 */
interface PaperSegment {
  point: PaperPoint;
  handleIn?: PaperPoint;
  handleOut?: PaperPoint;
}

/** paper 的路径。 */
interface PaperPath {
  segments: PaperSegment[];
  closed: boolean;
  moveTo(point: PaperPoint): void;
  lineTo(point: PaperPoint): void;
  cubicCurveTo(handle1: PaperPoint, handle2: PaperPoint, point: PaperPoint): void;
  quadraticTo(handle: PaperPoint, point: PaperPoint): void;
  closePath(): void;
}

/** paper 的图元（路径或复合路径）。 */
interface PaperItem {
  className: string;
  segments?: PaperSegment[];
  closed?: boolean;
  children?: PaperItem[];
  addChild(child: PaperItem): void;
  unite(other: PaperItem): PaperItem;
  subtract(other: PaperItem): PaperItem;
  intersect(other: PaperItem): PaperItem;
  exclude(other: PaperItem): PaperItem;
}

/** 用到的那几个 paper API。 */
interface PaperApi {
  setup(size: unknown): void;
  Size: new (width: number, height: number) => unknown;
  Point: new (x: number, y: number) => PaperPoint;
  Path: new (point?: PaperPoint) => PaperPath;
  CompoundPath: new () => PaperItem;
}

const paperApi = paper as unknown as PaperApi;

/** paper 的作用域：Node 里没有 canvas，必须自己建一个。 */
let scopeReady = false;

function ensureScope(): void {
  if (scopeReady) return;
  scopeReady = true;
  // `paper-core` 没有 DOM 依赖，用 Size 建一个不带画布的作用域即可做几何运算。
  paperApi.setup(new paperApi.Size(1, 1));
}

/** 安装曲线级布尔引擎（幂等）。 */
export function installPaperBooleanEngine(): void {
  ensureScope();
  setBooleanEngine({ combine });
}

/** 卸载（退回多边形近似）——测试用。 */
export function uninstallPaperBooleanEngine(): void {
  setBooleanEngine(undefined);
}

/** 路径命令 → paper 的路径对象。 */
function toPaperItem(commands: readonly PathCommand[]): PaperItem {
  const compound = new paperApi.CompoundPath();
  let current: PaperPath | undefined;
  for (const command of commands) {
    if (command.command === "M") {
      // 用构造函数建点而不是 `moveTo`：空路径上 `moveTo` 不会把「当前点」设好，
      // 后面的 `curveTo` 会因为拿不到起点而报错。
      current = new paperApi.Path(new paperApi.Point(command.point.x, command.point.y));
      compound.addChild(current as unknown as PaperItem);
      continue;
    }
    if (!current) continue;
    switch (command.command) {
      case "L":
        current.lineTo(new paperApi.Point(command.point.x, command.point.y));
        break;
      case "C":
        // paper 的 `curveTo` 是「穿过某点」的二次曲线；三次贝塞尔要用 `cubicCurveTo`。
        current.cubicCurveTo(
          new paperApi.Point(command.control1.x, command.control1.y),
          new paperApi.Point(command.control2.x, command.control2.y),
          new paperApi.Point(command.point.x, command.point.y),
        );
        break;
      case "Q":
        current.quadraticTo(
          new paperApi.Point(command.control.x, command.control.y),
          new paperApi.Point(command.point.x, command.point.y),
        );
        break;
      case "Z":
        current.closePath();
        break;
    }
  }
  return compound;
}

/** paper 的结果 → 我们的路径命令。
 *
 * paper 的所有段都是同一个 `Segment` 类，靠**相对的** `handleIn` / `handleOut`
 * 区分形状：一段曲线由「前一段的 handleOut」与「后一段的 handleIn」共同定义，
 * 两个把手都是零就是直线。闭合路径的最后一段要绕回第一段，所以按环形遍历。
 */
function fromPaperItem(item: PaperItem): PathCommand[] | undefined {
  const paths: Array<PaperPath & PaperItem> = item.className === "CompoundPath"
    ? (item.children ?? []).filter(child => child.className === "Path") as Array<PaperPath & PaperItem>
    : item.className === "Path"
      ? [item as PaperPath & PaperItem]
      : [];
  const commands: PathCommand[] = [];
  for (const path of paths) {
    const segments = path.segments ?? [];
    if (!segments.length) continue;
    const first = segments[0]!.point;
    commands.push({ command: "M", point: { x: first.x, y: first.y } });
    const count = path.closed ? segments.length : segments.length - 1;
    for (let index = 0; index < count; index += 1) {
      const from = segments[index]!;
      const to = segments[(index + 1) % segments.length]!;
      const out = from.handleOut;
      const incoming = to.handleIn;
      const straight = (!out || (out.x === 0 && out.y === 0)) && (!incoming || (incoming.x === 0 && incoming.y === 0));
      if (straight) {
        commands.push({ command: "L", point: { x: to.point.x, y: to.point.y } });
        continue;
      }
      commands.push({
        command: "C",
        control1: { x: from.point.x + (out?.x ?? 0), y: from.point.y + (out?.y ?? 0) },
        control2: { x: to.point.x + (incoming?.x ?? 0), y: to.point.y + (incoming?.y ?? 0) },
        point: { x: to.point.x, y: to.point.y },
      });
    }
    if (path.closed) commands.push({ command: "Z" });
  }
  return commands.length ? commands : undefined;
}

/** 布尔合成：第一个操作数是基准，其余依次参与运算。 */
function combine(operands: readonly PathCommand[][], operation: BooleanOperation): PathCommand[] | undefined {
  const items = operands.map(commands => toPaperItem(commands));
  if (items.length < 2) return undefined;
  let result: PaperItem = items[0]!;
  for (let index = 1; index < items.length; index += 1) {
    const other = items[index]!;
    switch (operation) {
      case "union": result = result.unite(other); break;
      case "subtract": result = result.subtract(other); break;
      case "intersect": result = result.intersect(other); break;
      case "exclude": result = result.exclude(other); break;
    }
  }
  return fromPaperItem(result);
}
