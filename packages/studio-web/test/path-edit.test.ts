import assert from "node:assert/strict";
import test from "node:test";
import type { PathCommand } from "@ufira/design-schema";
import {
  anchorType,
  anchorsFromPath,
  commandsFromAnchors,
  handlesOf,
  hitTestAnchor,
  hitTestHandle,
  moveAnchor,
  moveAnchors,
  moveHandle,
  removeAnchor,
  removeAnchors,
  snapAnchorPoint,
} from "../src/path-edit";

/**
 * 编辑层的命令用**绝对场景坐标**，不是归一化坐标——所以这里直接构造命令对象，
 * 不走 `parseVectorPath`（那个解析器强制坐标落在 [0,1]，只用于读文档里存的 `d`）。
 */
const M = (x: number, y: number): PathCommand => ({ command: "M", point: { x, y } });
const L = (x: number, y: number): PathCommand => ({ command: "L", point: { x, y } });
const C = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): PathCommand => ({
  command: "C",
  control1: { x: c1x, y: c1y },
  control2: { x: c2x, y: c2y },
  point: { x, y },
});
const Z: PathCommand = { command: "Z" };

test("splits an L path into plain anchors", () => {
  const anchors = anchorsFromPath([M(0, 0), L(10, 0), L(10, 10), Z]);
  assert.deepEqual(anchors, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
});

test("attaches cubic control points to the right anchors", () => {
  const anchors = anchorsFromPath([M(0, 0), C(2, 4, 8, 4, 10, 0)]);
  assert.deepEqual(anchors[0]?.handleOut, { x: 2, y: 4 });
  assert.deepEqual(anchors[1]?.handleIn, { x: 8, y: 4 });
  // 起点没有入向手柄、终点没有出向手柄。
  assert.equal(anchors[0]?.handleIn, undefined);
  assert.equal(anchors[1]?.handleOut, undefined);
});

test("elevates Q exactly so editing does not change the shape", () => {
  // P0=(0,0) Q=(5,10) P1=(10,0)：等价控制点应为 P0+2/3(Q-P0) 与 P1+2/3(Q-P1)。
  const anchors = anchorsFromPath([M(0, 0), { command: "Q", control: { x: 5, y: 10 }, point: { x: 10, y: 0 } }]);
  assert.ok(Math.abs(anchors[0]!.handleOut!.x - 10 / 3) < 1e-9);
  assert.ok(Math.abs(anchors[0]!.handleOut!.y - 20 / 3) < 1e-9);
  assert.ok(Math.abs(anchors[1]!.handleIn!.x - (10 - 10 / 3)) < 1e-9);
  assert.ok(Math.abs(anchors[1]!.handleIn!.y - 20 / 3) < 1e-9);
});

test("rebuilding preserves the anchors of a closed path", () => {
  const original: PathCommand[] = [M(0, 0), C(2, 4, 8, 4, 10, 0), L(10, 10), Z];
  const rebuilt = commandsFromAnchors(anchorsFromPath(original), true);
  // 重建会把「最后一点回到起点」显式写成一段线，所以命令数比原路径多一条，
  // 但锚点集合与闭合状态保持一致——这才是编辑要保住的东西。
  assert.equal(rebuilt.at(-1)?.command, "Z");
  assert.deepEqual(anchorsFromPath(rebuilt), anchorsFromPath(original));
});

test("moving an anchor translates its handles with it", () => {
  const anchors = anchorsFromPath([M(0, 0), C(2, 4, 8, 4, 10, 0)]);
  const moved = moveAnchor(anchors, 0, { x: 1, y: 1 });
  assert.deepEqual(moved[0]?.handleOut, { x: 3, y: 5 });
  // 另一个锚点不受影响。
  assert.deepEqual(moved[1]?.handleIn, { x: 8, y: 4 });
});

test("moving a handle mirrors the opposite one unless Alt breaks symmetry", () => {
  const anchors = anchorsFromPath([M(0, 0), C(2, 4, 8, 4, 10, 0)]);
  const withIncoming = [{ ...anchors[0]!, handleIn: { x: -2, y: -4 } }, anchors[1]!];
  const mirrored = moveHandle(withIncoming, { anchorIndex: 0, role: "out" }, { x: 3, y: 6 }, true);
  assert.deepEqual(mirrored[0]?.handleIn, { x: -3, y: -6 });
  const broken = moveHandle(withIncoming, { anchorIndex: 0, role: "out" }, { x: 3, y: 6 }, false);
  assert.deepEqual(broken[0]?.handleIn, { x: -2, y: -4 });
});

test("hit testing finds handles and anchors", () => {
  const anchors = anchorsFromPath([M(0, 0), C(2, 4, 8, 4, 10, 0)]);
  const handle = hitTestHandle(anchors, { x: 2.5, y: 4 }, 3);
  assert.deepEqual(handle, { anchorIndex: 0, role: "out", point: { x: 2, y: 4 } });
  assert.equal(hitTestAnchor(anchors, { x: 0.5, y: 0.5 }, 3), 0);
  assert.equal(hitTestHandle(anchors, { x: 50, y: 50 }, 3), undefined);
});

test("lists handles with their owning anchor", () => {
  const handles = handlesOf(anchorsFromPath([M(0, 0), C(2, 4, 8, 4, 10, 0)]));
  assert.deepEqual(handles.map(handle => `${handle.anchorIndex}:${handle.role}`), ["0:out", "1:in"]);
});

test("deleting keeps the minimum number of anchors", () => {
  const open = anchorsFromPath([M(0, 0), L(10, 0), L(20, 0)]);
  assert.equal(removeAnchor(open, 1, false)?.length, 2);
  assert.equal(removeAnchor(open, 0, false)?.length, 2);
  // 删到只剩两个（开放）/三个（闭合）就不再有删除入口。
  assert.equal(removeAnchor(open.slice(0, 2), 0, false), undefined);
  const closed = anchorsFromPath([M(0, 0), L(10, 0), L(10, 10), Z]);
  assert.equal(removeAnchor(closed, 1, true), undefined);
});

test("deleting a middle anchor reconnects its neighbours", () => {
  const anchors = anchorsFromPath([M(0, 0), L(10, 0), L(20, 0), L(30, 0)]);
  const result = removeAnchor(anchors, 1, false)!;
  assert.deepEqual(result.map(anchor => anchor.x), [0, 20, 30]);
  assert.equal(commandsFromAnchors(result, false).length, 3);
});

// —— 多选锚点 ——

test("多选移动：整组一起平移，手柄跟着各自的锚点走", () => {
  const anchors = anchorsFromPath([M(0, 0), C(2, 4, 8, 4, 10, 0), L(10, 10)]);
  const moved = moveAnchors(anchors, [0, 1], { x: 5, y: -3 });
  assert.deepEqual(moved[0], { x: 5, y: -3, handleOut: { x: 7, y: 1 } });
  assert.deepEqual(moved[1], { x: 15, y: -3, handleIn: { x: 13, y: 1 } });
  // 没被选中的锚点原地不动。
  assert.deepEqual(moved[2], { x: 10, y: 10 });
});

test("多选移动：位移为零就原样返回", () => {
  const anchors = anchorsFromPath([M(0, 0), L(10, 0)]);
  assert.deepEqual(moveAnchors(anchors, [0], { x: 0, y: 0 }), anchors);
});

test("多选删除：一次删掉整组，并守住最少的锚点数", () => {
  const anchors = anchorsFromPath([M(0, 0), L(10, 0), L(20, 0), L(30, 0)]);
  const result = removeAnchors(anchors, [0, 2], false)!;
  assert.deepEqual(result.map(anchor => anchor.x), [10, 30]);
  // 删到不够点数就没有删除入口。
  assert.equal(removeAnchors(anchors.slice(0, 3), [0, 1], false), undefined);
  assert.equal(removeAnchors(anchors, [], false), undefined);
});

// —— 锚点吸附 ——

test("锚点吸附：够近就吸到最近的候选点上", () => {
  const candidates = [{ x: 100, y: 50 }, { x: 300, y: 50 }];
  assert.deepEqual(snapAnchorPoint({ x: 103, y: 52 }, candidates, 8), { x: 100, y: 50 });
  // 太远就不吸。
  assert.equal(snapAnchorPoint({ x: 120, y: 50 }, candidates, 8), undefined);
  // 正好在阈值上算命中。
  assert.deepEqual(snapAnchorPoint({ x: 108, y: 50 }, candidates, 8), { x: 100, y: 50 });
});

// —— 尖角：手柄各自独立 ——

test("锚点类型：没有手柄是角点，手柄互为镜像是平滑点", () => {
  assert.equal(anchorType({ x: 0, y: 0 }), "corner");
  assert.equal(anchorType({ x: 0, y: 0, handleIn: { x: -10, y: 0 }, handleOut: { x: 10, y: 0 } }), "smooth");
});

test("锚点类型：手柄不互为镜像就是尖角", () => {
  // 方向相反但长度不同：不是镜像关系。
  assert.equal(anchorType({ x: 0, y: 0, handleIn: { x: -10, y: 0 }, handleOut: { x: 6, y: 0 } }), "cusp");
  // 长度相同但不共线。
  assert.equal(anchorType({ x: 0, y: 0, handleIn: { x: -10, y: 0 }, handleOut: { x: 0, y: 10 } }), "cusp");
  // 只有一侧手柄（开放路径的首尾）：没有镜像关系可言。
  assert.equal(anchorType({ x: 0, y: 0, handleOut: { x: 10, y: 0 } }), "cusp");
});

test("尖角的手柄不再被镜像回去：拖一边另一边不动", () => {
  const cusp = { x: 0, y: 0, handleIn: { x: -10, y: 0 }, handleOut: { x: 6, y: 0 } };
  const moved = moveHandle([cusp], { anchorIndex: 0, role: "out" }, { x: 20, y: 0 }, true);
  assert.deepEqual(moved[0]?.handleOut, { x: 20, y: 0 });
  // 对侧手柄原地不动——这正是「独立」的含义。
  assert.deepEqual(moved[0]?.handleIn, { x: -10, y: 0 });
  assert.equal(anchorType(moved[0]!), "cusp");
});

test("平滑点拖手柄仍然镜像对侧", () => {
  const smooth = { x: 0, y: 0, handleIn: { x: -10, y: 0 }, handleOut: { x: 10, y: 0 } };
  const moved = moveHandle([smooth], { anchorIndex: 0, role: "out" }, { x: 20, y: 0 }, true);
  assert.deepEqual(moved[0]?.handleIn, { x: -20, y: 0 });
  assert.equal(anchorType(moved[0]!), "smooth");
});

test("Alt 拖平滑点的手柄会打破镜像，锚点变成尖角", () => {
  const smooth = { x: 0, y: 0, handleIn: { x: -10, y: 0 }, handleOut: { x: 10, y: 0 } };
  const moved = moveHandle([smooth], { anchorIndex: 0, role: "out" }, { x: 20, y: 5 }, false);
  assert.deepEqual(moved[0]?.handleIn, { x: -10, y: 0 });
  assert.equal(anchorType(moved[0]!), "cusp");
});
