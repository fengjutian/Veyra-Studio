import assert from "node:assert/strict";
import test from "node:test";
import { anchorPoints, snapNode } from "../src/renderer/anchor-snapping";
import { snapBox, type SnapTarget } from "../src/renderer/snapping";

/**
 * 智能锚点吸附：锚点对齐 + 等间距。
 *
 * 规格见 `docs/snapping.md`。
 */

function target(nodeId: string, x: number, y: number, width: number, height: number): SnapTarget {
  return { nodeId, box: { x, y, width, height } };
}

test("a box has nine anchors", () => {
  const anchors = anchorPoints({ x: 0, y: 0, width: 100, height: 50 });
  assert.equal(anchors.length, 9);
  assert.equal(anchors.filter(anchor => anchor.kind === "corner").length, 4);
  assert.equal(anchors.filter(anchor => anchor.kind === "edge").length, 4);
  assert.equal(anchors.filter(anchor => anchor.kind === "center").length, 1);
  // 竖边中点只参与水平对齐，横边中点只参与竖直对齐。
  const left = anchors.find(anchor => anchor.x === 0 && anchor.y === 25)!;
  assert.equal(left.axis, "x");
  const top = anchors.find(anchor => anchor.x === 50 && anchor.y === 0)!;
  assert.equal(top.axis, "y");
});

test("snaps a corner onto the corner of another box", () => {
  const result = snapNode(
    { x: 195, y: 10, width: 40, height: 40 },
    [target("a", 100, 0, 100, 50)],
    { threshold: 8 },
  );
  // 移动框的左上角离目标的右上角差 5px → 吸过去。
  assert.equal(result.deltaX, 5);
  assert.equal(result.guides[0]?.kind, "corner");
  assert.equal(result.guides[0]?.position, 200);
  assert.equal(result.guides[0]?.targetNodeId, "a");
});

test("snaps to the center line of another box", () => {
  const result = snapNode(
    { x: 105, y: 0, width: 40, height: 20 },
    [target("a", 0, 0, 200, 50)],
    { threshold: 8 },
  );
  // 移动框中心 125，目标中心 100 → 往回吸 25px 超出阈值；
  // 移动框左边 105 对目标中心 100 只差 5px。
  assert.equal(result.deltaX, -5);
  assert.equal(result.guides[0]?.position, 100);
});

test("detects the equal spacing between two targets", () => {
  const result = snapNode(
    { x: 85, y: 200, width: 40, height: 40 },
    [target("left", 0, 0, 50, 50), target("right", 150, 0, 50, 50)],
    { threshold: 8 },
  );
  // 左侧间距 35、右侧间距 25 → 居中后两侧都是 30。
  assert.equal(result.deltaX, -5);
  const spacing = result.guides.find(guide => guide.kind === "spacing");
  assert.ok(spacing);
  assert.equal(spacing.spacing, 30);
  assert.deepEqual(spacing.segments, [{ from: 50, to: 80 }, { from: 120, to: 150 }]);
  assert.deepEqual(spacing.targetNodeIds, ["left", "right"]);
});

test("keeps the equal spacing of a run of targets", () => {
  const result = snapNode(
    { x: 185, y: 200, width: 40, height: 40 },
    [
      target("a", 0, 0, 40, 40),
      target("b", 60, 0, 40, 40),
      target("c", 120, 0, 40, 40),
    ],
    { threshold: 8 },
  );
  // 三个目标已经是 20px 等距：第四个接上去时保持 20px。
  assert.equal(result.deltaX, -5);
  const spacing = result.guides.find(guide => guide.kind === "spacing");
  assert.ok(spacing);
  assert.equal(spacing.spacing, 20);
});

test("does not snap beyond the threshold", () => {
  const result = snapNode(
    { x: 85, y: 200, width: 40, height: 40 },
    [target("left", 0, 0, 50, 50), target("right", 150, 0, 50, 50)],
    { threshold: 2 },
  );
  // 居中要移动 5px，超出 2px 的阈值 → 不吸。
  assert.equal(result.deltaX, 0);
});

test("does not snap at all when it is turned off", () => {
  const result = snapNode(
    { x: 195, y: 10, width: 40, height: 40 },
    [target("a", 100, 0, 100, 50)],
    { threshold: 8, enabled: false },
  );
  assert.equal(result.deltaX, 0);
  assert.equal(result.deltaY, 0);
  assert.deepEqual(result.guides, []);
});

test("the basic box snapping still works", () => {
  // 旧入口的行为不能变：左边缘对齐到目标的右边缘。
  const result = snapBox(
    { x: 95, y: 0, width: 40, height: 20 },
    [target("a", 0, 0, 100, 50)],
    { threshold: 8 },
  );
  assert.equal(result.deltaX, 5);
  assert.ok(result.guides.length >= 1);
  assert.equal(result.guides[0]?.position, 100);
});
