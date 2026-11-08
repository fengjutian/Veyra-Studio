import assert from "node:assert/strict";
import test from "node:test";
import type { PathCommand } from "@ufira/design-schema";
import {
  anchorsFromPath,
  commandsFromAnchors,
  handlesOf,
  hitTestAnchor,
  hitTestHandle,
  moveAnchor,
  moveHandle,
  removeAnchor,
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
