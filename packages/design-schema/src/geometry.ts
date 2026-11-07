/**
 * 矢量路径几何。
 *
 * 这是 `vector` 节点的唯一几何表达：一段**归一化路径**——坐标落在 `[0,1]`，
 * 相对节点自己的布局盒。三个决定：
 *
 * 1. 归一化而不是绝对像素：改宽高就是缩放图形（和 Figma 里拉多边形一致），
 *    否则每次 resize 都要重写 `d`，撤销粒度也会碎成一片。
 * 2. 只允许 `M` / `L` / `Z`：贝塞尔（C/Q）与圆弧（A）留给钢笔工具那一轮，
 *    它们需要手柄编辑和拟合算法，先做完多边形比半成品曲线有价值。
 * 3. 解析结果按 `d` 缓存：命中测试每帧都要问「点在不在图形里」，重复解析
 *    一条同样的字符串是纯浪费。
 */

export interface PathPoint {
  x: number;
  y: number;
}

export type PathCommand =
  | { command: "M" | "L"; point: PathPoint }
  | { command: "Z" };

export interface VectorGeometry {
  kind: "path";
  /** 归一化路径数据，坐标必须落在 [0,1]。 */
  d: string;
}

/** 归一化坐标允许的误差（浮点写出来常常是 0.30000000000000004）。 */
const COORDINATE_EPSILON = 1e-6;

const CACHE_LIMIT = 256;
const cache = new Map<string, PathCommand[]>();

/**
 * 严格解析：不合法返回 `undefined`。
 *
 * 语法是 `M x y (L x y)* Z?`，可重复 `M` 开新的子路径。数字支持小数与科学计数法，
 * 分隔符用逗号或空白。任何不认识的字母（C、Q、A、H、V…）都会让整条路径作废，
 * 而不是被悄悄忽略——静默丢命令会画出和原意完全不同的图形。
 */
export function parseVectorPath(d: string): PathCommand[] | undefined {
  if (typeof d !== "string" || !d.trim()) return undefined;
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || tokens.join("").length !== d.replace(/[\s,]+/g, "").length) return undefined;

  const commands: PathCommand[] = [];
  let index = 0;
  let sawPoint = false;
  // 关闭之后只能再开新的子路径：`Z` 后面直接跟 `L` 会从"上一个点"继续画，
  // 语义含糊，各实现也不一致，索性不认。
  let closed = false;

  const readNumber = (): number | undefined => {
    const token = tokens[index];
    if (token === undefined || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token)) return undefined;
    index += 1;
    const value = Number(token);
    return Number.isFinite(value) ? value : undefined;
  };
  const readPoint = (): PathPoint | undefined => {
    const x = readNumber();
    if (x === undefined) return undefined;
    const y = readNumber();
    if (y === undefined) return undefined;
    if (!inUnitRange(x) || !inUnitRange(y)) return undefined;
    return { x, y };
  };

  while (index < tokens.length) {
    const command = tokens[index]!;
    index += 1;
    if (command === "Z") {
      if (!sawPoint || closed) return undefined;
      commands.push({ command: "Z" });
      closed = true;
      continue;
    }
    if (command === "M") {
      const point = readPoint();
      if (!point) return undefined;
      commands.push({ command: "M", point });
      sawPoint = true;
      closed = false;
      continue;
    }
    if (command === "L") {
      // 没有起点就无法画线；宁可整条作废，也不猜一个原点。
      if (!sawPoint || closed) return undefined;
      const point = readPoint();
      if (!point) return undefined;
      commands.push({ command: "L", point });
      continue;
    }
    return undefined;
  }

  return commands.length ? commands : undefined;
}

/** 校验入口，供 schema 的 zod refinement 使用。 */
export function isValidVectorPath(d: string): boolean {
  return parseVectorPath(d) !== undefined;
}

/** 解析并缓存；非法路径返回空数组（渲染层不该因为坏数据整页崩掉）。 */
export function vectorPathCommands(d: string): PathCommand[] {
  const cached = cache.get(d);
  if (cached) return cached;
  const parsed = parseVectorPath(d) ?? [];
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(d, parsed);
  return parsed;
}

/** 是否是一条闭合路径（最后一个命令是 Z）。 */
export function isClosedPath(commands: PathCommand[]): boolean {
  return commands.length > 0 && commands[commands.length - 1]!.command === "Z";
}

/** 归一化坐标 → 节点盒内的绝对坐标。 */
export function absolutePath(commands: PathCommand[], box: { x: number; y: number; width: number; height: number }): PathCommand[] {
  return commands.map(command => command.command === "Z"
    ? command
    : { command: command.command, point: { x: box.x + command.point.x * box.width, y: box.y + command.point.y * box.height } });
}

/** 序列化回 SVG path data；坐标只保留 4 位小数，避免浮点噪声进基线。 */
export function pathDataFromCommands(commands: PathCommand[]): string {
  return commands
    .map(command => command.command === "Z" ? "Z" : `${command.command} ${num(command.point.x)} ${num(command.point.y)}`)
    .join(" ");
}

/** 绝对坐标下的顶点列表（Z 不产生新点，闭合关系由 isClosedPath 表达）。 */
export function pathPoints(commands: PathCommand[]): PathPoint[] {
  const points: PathPoint[] = [];
  for (const command of commands) if (command.command !== "Z") points.push(command.point);
  return points;
}

/**
 * 命中测试。
 *
 * 闭合路径按「点在多边形内」判定（射线法，奇偶规则），开放路径按「到折线的距离」
 * 判定——否则一条对角线会把它整个包围盒都变成可点击区域。
 */
export function hitTestVectorPath(
  commands: PathCommand[],
  box: { x: number; y: number; width: number; height: number },
  point: PathPoint,
  options: { tolerance?: number } = {},
): boolean {
  if (!commands.length || box.width <= 0 || box.height <= 0) return false;
  const tolerance = options.tolerance ?? 6;
  // 包围盒快速排除：命中测试每个指针事件都会对整页节点跑一遍。
  if (point.x < box.x - tolerance || point.x > box.x + box.width + tolerance) return false;
  if (point.y < box.y - tolerance || point.y > box.y + box.height + tolerance) return false;

  const absolute = absolutePath(commands, box);
  const points = pathPoints(absolute);
  if (!points.length) return false;
  if (isClosedPath(commands) && points.length >= 3 && pointInPolygon(points, point)) return true;
  return distanceToPolyline(points, isClosedPath(commands), point) <= tolerance;
}

/** 正多边形路径（内接于单位盒的椭圆，默认一个顶点朝上）。 */
export function regularPolygonPathData(sides: number, rotation = -Math.PI / 2): string {
  const count = Math.max(3, Math.floor(sides));
  const points: PathPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = rotation + (index * Math.PI * 2) / count;
    points.push({ x: 0.5 + Math.cos(angle) * 0.5, y: 0.5 + Math.sin(angle) * 0.5 });
  }
  return closedPolygonPath(points);
}

/** 星形路径：外顶点与内顶点交替，`innerRatio` 是内半径占外半径的比例。 */
export function starPathData(pointCount: number, innerRatio = 0.382, rotation = -Math.PI / 2): string {
  const count = Math.max(3, Math.floor(pointCount));
  const inner = Math.min(1, Math.max(0.05, innerRatio));
  const points: PathPoint[] = [];
  for (let index = 0; index < count * 2; index += 1) {
    const angle = rotation + (index * Math.PI) / count;
    const radius = index % 2 === 0 ? 0.5 : 0.5 * inner;
    points.push({ x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius });
  }
  return closedPolygonPath(points);
}

/** 把一组归一化顶点变成闭环路径。 */
export function closedPolygonPath(points: PathPoint[]): string {
  if (!points.length) return "";
  const commands: PathCommand[] = points.map((point, index) => ({
    command: index === 0 ? "M" : "L",
    point: { x: clamp01(point.x), y: clamp01(point.y) },
  }));
  commands.push({ command: "Z" });
  return pathDataFromCommands(commands);
}

function pointInPolygon(points: PathPoint[], point: PathPoint): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const current = points[index]!;
    const last = points[previous]!;
    const crosses = (current.y > point.y) !== (last.y > point.y);
    if (!crosses) continue;
    const x = ((last.x - current.x) * (point.y - current.y)) / (last.y - current.y) + current.x;
    if (point.x < x) inside = !inside;
  }
  return inside;
}

function distanceToPolyline(points: PathPoint[], closed: boolean, point: PathPoint): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    best = Math.min(best, distanceToSegment(points[index - 1]!, points[index]!, point));
  }
  if (closed && points.length > 2) best = Math.min(best, distanceToSegment(points[points.length - 1]!, points[0]!, point));
  return best;
}

function distanceToSegment(start: PathPoint, end: PathPoint, point: PathPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function inUnitRange(value: number): boolean {
  return value >= -COORDINATE_EPSILON && value <= 1 + COORDINATE_EPSILON;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function num(value: number): number {
  return Number(value.toFixed(4));
}
