/**
 * 矢量路径几何。
 *
 * 这是 `vector` 节点的唯一几何表达：一段**归一化路径**——在曲线上的点落在 `[0,1]`，
 * 相对节点自己的布局盒。四个决定：
 *
 * 1. 归一化而不是绝对像素：改宽高就是缩放图形（和 Figma 里拉多边形一致），
 *    否则每次 resize 都要重写 `d`。
 * 2. 支持 `M` / `L` / `C` / `Q` / `Z`，不支持 `A`：各实现对椭圆弧的参数化不一致，
 *    圆弧用贝塞尔近似即可，不值得为它引入拟合代码。
 * 3. **控制点允许越界**，在曲线上的点不允许。向外鼓的弧如果把盒子撑大再缩回去，
 *    来回插值会丢精度；盒子取「离散化后的紧包围盒」，鼓出去的弧自然在盒内。
 * 4. 解析结果按 `d` 缓存：命中测试每个指针事件都要问「点在不在图形里」，
 *    重复解析同一条字符串是纯浪费。
 */

export interface PathPoint {
  x: number;
  y: number;
}

export type PathCommand =
  | { command: "M" | "L"; point: PathPoint }
  | { command: "C"; control1: PathPoint; control2: PathPoint; point: PathPoint }
  | { command: "Q"; control: PathPoint; point: PathPoint }
  | { command: "Z" };

export interface VectorGeometry {
  kind: "path";
  /** 归一化路径数据；在曲线上的点落在 [0,1]，控制点可以越界。 */
  d: string;
}

/** 归一化坐标允许的误差（浮点写出来常常是 0.30000000000000004）。 */
const COORDINATE_EPSILON = 1e-6;

const CACHE_LIMIT = 256;
const cache = new Map<string, PathCommand[]>();

/** 每段曲线的离散段数：960×680 画板下误差 < 0.5px，视觉与命中都够用。 */
export const FLATTEN_SEGMENTS = 16;

/**
 * 严格解析：不合法返回 `undefined`。
 *
 * 语法是 `M x y (L x y | C x1 y1 x2 y2 x y | Q x1 y1 x y)* Z?`。
 * 数字支持小数与科学计数法，分隔符用逗号或空白。任何不认识的字母（A、H、V、S…）
 * 都会让整条路径作废——静默丢命令会画出和原意完全不同的图形。
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
  /** 在曲线上的点：必须落在 [0,1]，否则「盒子包含图形」这个不变式就破了。 */
  const readPoint = (): PathPoint | undefined => {
    const x = readNumber();
    if (x === undefined) return undefined;
    const y = readNumber();
    if (y === undefined) return undefined;
    if (!inUnitRange(x) || !inUnitRange(y)) return undefined;
    return { x, y };
  };
  /** 控制点只要求有限：允许越界，见文件头注释第 3 条。 */
  const readControl = (): PathPoint | undefined => {
    const x = readNumber();
    if (x === undefined) return undefined;
    const y = readNumber();
    if (y === undefined) return undefined;
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
    if (command === "Q") {
      if (!sawPoint || closed) return undefined;
      const control = readControl();
      const point = control ? readPoint() : undefined;
      if (!control || !point) return undefined;
      commands.push({ command: "Q", control, point });
      continue;
    }
    if (command === "C") {
      if (!sawPoint || closed) return undefined;
      const control1 = readControl();
      const control2 = control1 ? readControl() : undefined;
      const point = control2 ? readPoint() : undefined;
      if (!control1 || !control2 || !point) return undefined;
      commands.push({ command: "C", control1, control2, point });
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

/** 归一化坐标 → 节点盒内的绝对坐标（控制点同样换算）。 */
export function absolutePath(commands: PathCommand[], box: { x: number; y: number; width: number; height: number }): PathCommand[] {
  const map = (point: PathPoint): PathPoint => ({ x: box.x + point.x * box.width, y: box.y + point.y * box.height });
  return commands.map((command): PathCommand => {
    switch (command.command) {
      case "Z": return command;
      case "M":
      case "L": return { command: command.command, point: map(command.point) };
      case "Q": return { command: "Q", control: map(command.control), point: map(command.point) };
      case "C": return { command: "C", control1: map(command.control1), control2: map(command.control2), point: map(command.point) };
    }
  });
}

/** 序列化回 SVG path data；坐标只保留 4 位小数，避免浮点噪声进基线。 */
export function pathDataFromCommands(commands: PathCommand[]): string {
  return commands.map(command => {
    switch (command.command) {
      case "Z": return "Z";
      case "M":
      case "L": return `${command.command} ${num(command.point.x)} ${num(command.point.y)}`;
      case "Q": return `Q ${num(command.control.x)} ${num(command.control.y)} ${num(command.point.x)} ${num(command.point.y)}`;
      case "C": return `C ${num(command.control1.x)} ${num(command.control1.y)} ${num(command.control2.x)} ${num(command.control2.y)} ${num(command.point.x)} ${num(command.point.y)}`;
    }
  }).join(" ");
}

/**
 * 绝对坐标 → 归一化坐标（`absolutePath` 的逆）。
 *
 * 钢笔提交时要先把草稿的绝对坐标算成紧包围盒，再把整条路径映射回 [0,1]；
 * 控制点因此可能落在 [0,1] 之外，这是允许的（见文件头注释第 3 条）。
 */
export function normalizePath(commands: PathCommand[], box: { x: number; y: number; width: number; height: number }): PathCommand[] {
  const width = box.width || 1;
  const height = box.height || 1;
  const map = (point: PathPoint): PathPoint => ({ x: (point.x - box.x) / width, y: (point.y - box.y) / height });
  return commands.map((command): PathCommand => {
    switch (command.command) {
      case "Z": return command;
      case "M":
      case "L": return { command: command.command, point: map(command.point) };
      case "Q": return { command: "Q", control: map(command.control), point: map(command.point) };
      case "C": return { command: "C", control1: map(command.control1), control2: map(command.control2), point: map(command.point) };
    }
  });
}

/**
 * 把路径离散成折线（绝对坐标由调用方先换算）。
 *
 * 命中测试与包围盒都基于它：曲线没法直接做点在多边形内判定，而折线可以。
 * `Z` 会把起点补回折线末尾，闭合关系因此由折线自身表达。
 */
export function flattenPath(commands: PathCommand[], segments = FLATTEN_SEGMENTS): PathPoint[] {
  const points: PathPoint[] = [];
  let current: PathPoint | undefined;
  let subpathStart: PathPoint | undefined;
  for (const command of commands) {
    if (command.command === "M") {
      current = command.point;
      subpathStart = command.point;
      points.push(command.point);
      continue;
    }
    if (command.command === "Z") {
      if (subpathStart) {
        points.push(subpathStart);
        current = subpathStart;
      }
      continue;
    }
    if (command.command === "L") {
      current = command.point;
      points.push(command.point);
      continue;
    }
    if (command.command === "Q") {
      const from = current ?? command.control;
      for (let step = 1; step <= segments; step += 1) {
        points.push(quadraticAt(from, command.control, command.point, step / segments));
      }
      current = command.point;
      continue;
    }
    if (command.command === "C") {
      const from = current ?? command.control1;
      for (let step = 1; step <= segments; step += 1) {
        points.push(cubicAt(from, command.control1, command.control2, command.point, step / segments));
      }
      current = command.point;
    }
  }
  return points;
}

/**
 * 按子路径离散化：每个 `M` 开一个新环，`Z` 把起点补到环尾。
 *
 * 布尔运算的结果是**多环**的（外轮廓 + 洞），命中测试必须按环算——把所有子路径
 * 首尾相连成一条折线的话，带洞形状的洞里也会命中。
 */
export function flattenRings(commands: PathCommand[], segments = FLATTEN_SEGMENTS): PathPoint[][] {
  const rings: PathPoint[][] = [];
  let ring: PathPoint[] | null = null;
  let current: PathPoint | undefined;
  const push = (points: PathPoint[]) => points.forEach(point => ring?.push(point));

  for (const command of commands) {
    if (command.command === "M") {
      if (ring && ring.length > 1) rings.push(ring);
      ring = [command.point];
      current = command.point;
      continue;
    }
    if (command.command === "Z") {
      if (ring && ring.length > 1) {
        ring.push(ring[0]!);
        rings.push(ring);
      }
      ring = null;
      current = undefined;
      continue;
    }
    if (!ring) {
      ring = [command.point];
      current = command.point;
      continue;
    }
    if (command.command === "L") {
      ring.push(command.point);
      current = command.point;
      continue;
    }
    const from = current ?? command.point;
    if (command.command === "Q") {
      for (let step = 1; step <= segments; step += 1) ring.push(quadraticAt(from, command.control, command.point, step / segments));
      current = command.point;
      continue;
    }
    if (command.command === "C") {
      for (let step = 1; step <= segments; step += 1) ring.push(cubicAt(from, command.control1, command.control2, command.point, step / segments));
      current = command.point;
    }
  }
  if (ring && ring.length > 1) rings.push(ring);
  return rings;
}

/** 离散化后的紧包围盒；空路径返回 undefined。 */
export function pathBounds(commands: PathCommand[]): { x: number; y: number; width: number; height: number } | undefined {
  const points = flattenPath(commands);
  if (!points.length) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 绝对坐标下的在曲线上的顶点（控制点不算顶点）。 */
export function pathPoints(commands: PathCommand[]): PathPoint[] {
  const points: PathPoint[] = [];
  for (const command of commands) if (command.command !== "Z") points.push(command.point);
  return points;
}

/**
 * 命中测试。
 *
 * 先把曲线离散成折线，再按**环**判定：
 *
 * - 全部环都闭合时用**非零环绕数**（与 Canvas / SVG 的默认填充规则一致，不是奇偶规则）。
 *   布尔运算的差集会产出「外轮廓 + 洞」，洞里的点环绕数为 0，因此不会被命中。
 * - 有开放子路径时退回「到折线的距离」，否则一条对角线会把它整个包围盒都变成可点击区域。
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

  const rings = flattenRings(absolutePath(commands, box));
  if (!rings.length) return false;
  const allClosed = rings.every(ring => ring.length > 2 && samePoint(ring[0]!, ring[ring.length - 1]!));
  if (allClosed && windingNumber(rings, point) !== 0) return true;
  let best = Number.POSITIVE_INFINITY;
  for (const ring of rings) best = Math.min(best, distanceToPolyline(ring, false, point));
  return best <= tolerance;
}

/** 非零环绕数：闭合环按方向累加，洞（反向环）会被抵消。 */
function windingNumber(rings: PathPoint[][], point: PathPoint): number {
  let winding = 0;
  for (const ring of rings) {
    for (let index = 1; index < ring.length; index += 1) {
      const start = ring[index - 1]!;
      const end = ring[index]!;
      const side = (end.x - start.x) * (point.y - start.y) - (point.x - start.x) * (end.y - start.y);
      if (start.y <= point.y) {
        if (end.y > point.y && side > 0) winding += 1;
      } else if (end.y <= point.y && side < 0) {
        winding -= 1;
      }
    }
  }
  return winding;
}

function samePoint(a: PathPoint, b: PathPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
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

function quadraticAt(from: PathPoint, control: PathPoint, to: PathPoint, t: number): PathPoint {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

function cubicAt(from: PathPoint, control1: PathPoint, control2: PathPoint, to: PathPoint, t: number): PathPoint {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * control1.x + c * control2.x + d * to.x,
    y: a * from.y + b * control1.y + c * control2.y + d * to.y,
  };
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
