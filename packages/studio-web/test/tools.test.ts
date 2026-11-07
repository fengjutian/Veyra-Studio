import assert from "node:assert/strict";
import test from "node:test";
import { clampRect, defaultRectFor, isClickDraw, isDrawTool, nextToolAfterDraw, rectFromDrag, shortcutTool, toolSpec, TOOLS } from "../src/tools";

const bounds = { width: 960, height: 680 };

test("every tool has a unique shortcut and the draw tools are exhaustive", () => {
  const shortcuts = TOOLS.map(spec => spec.shortcut);
  assert.equal(new Set(shortcuts).size, shortcuts.length);
  assert.deepEqual(TOOLS.filter(spec => isDrawTool(spec.id)).map(spec => spec.id), ["frame", "rectangle", "ellipse", "text"]);
  assert.equal(isDrawTool("select"), false);
  assert.equal(isDrawTool("hand"), false);
});

test("maps single keys to tools and ignores everything else", () => {
  assert.equal(shortcutTool("v"), "select");
  assert.equal(shortcutTool("R"), "rectangle");
  assert.equal(shortcutTool("o"), "ellipse");
  assert.equal(shortcutTool("t"), "text");
  assert.equal(shortcutTool("h"), "hand");
  assert.equal(shortcutTool("f"), "frame");
  assert.equal(shortcutTool("z"), undefined);
  assert.equal(shortcutTool("Shift"), undefined);
});

test("draws a rectangle from the drag corners", () => {
  assert.deepEqual(rectFromDrag({ x: 100, y: 100 }, { x: 220, y: 180 }), { x: 100, y: 100, width: 120, height: 80 });
});

test("normalizes a drag towards the top-left", () => {
  assert.deepEqual(rectFromDrag({ x: 200, y: 200 }, { x: 120, y: 140 }), { x: 120, y: 140, width: 80, height: 60 });
});

test("Shift forces a square and keeps the drag direction", () => {
  assert.deepEqual(rectFromDrag({ x: 100, y: 100 }, { x: 220, y: 160 }, { shift: true }), { x: 100, y: 100, width: 120, height: 120 });
  // 向左上拖动时正方形取较长的那条边，起点变成右下角。
  assert.deepEqual(rectFromDrag({ x: 200, y: 200 }, { x: 140, y: 120 }, { shift: true }), { x: 120, y: 120, width: 80, height: 80 });
});

test("Alt expands from the pressed point as the center", () => {
  assert.deepEqual(rectFromDrag({ x: 100, y: 100 }, { x: 140, y: 130 }, { alt: true }), { x: 60, y: 70, width: 80, height: 60 });
});

test("Shift and Alt together draw a centered square", () => {
  assert.deepEqual(rectFromDrag({ x: 100, y: 100 }, { x: 150, y: 120 }, { shift: true, alt: true }), { x: 50, y: 50, width: 100, height: 100 });
});

test("Shift with a zero-length axis still uses the longer side", () => {
  // 只横向拖动时不能退化成 0 宽；上/下方向按按下点的方向补足。
  assert.deepEqual(rectFromDrag({ x: 100, y: 100 }, { x: 160, y: 100 }, { shift: true }), { x: 100, y: 100, width: 60, height: 60 });
});

test("clamps a drawn rectangle into the canvas", () => {
  assert.deepEqual(clampRect({ x: -40, y: -10, width: 120, height: 60 }, bounds), { x: 0, y: 0, width: 80, height: 50 });
  assert.deepEqual(clampRect({ x: 900, y: 640, width: 200, height: 200 }, bounds), { x: 900, y: 640, width: 60, height: 40 });
  assert.deepEqual(clampRect({ x: 1200, y: 900, width: 100, height: 100 }, bounds), { x: 960, y: 680, width: 0, height: 0 });
});

test("treats tiny drags as clicks", () => {
  assert.equal(isClickDraw({ x: 10, y: 10, width: 0, height: 0 }), true);
  assert.equal(isClickDraw({ x: 10, y: 10, width: 1, height: 120 }), true);
  assert.equal(isClickDraw({ x: 10, y: 10, width: 40, height: 30 }), false);
});

test("a click draws the default size at the pointer", () => {
  assert.deepEqual(defaultRectFor("rectangle", { x: 30, y: 40 }), { x: 30, y: 40, width: 240, height: 140 });
  assert.deepEqual(defaultRectFor("text", { x: 30, y: 40 }), { x: 30, y: 40, width: 160, height: 48 });
});

test("returns to the select tool after drawing", () => {
  assert.equal(nextToolAfterDraw("rectangle"), "select");
  assert.equal(nextToolAfterDraw("text"), "select");
  // 选择与抓手本来就不创建节点，保持不变。
  assert.equal(nextToolAfterDraw("select"), "select");
  assert.equal(nextToolAfterDraw("hand"), "hand");
});

test("exposes a label for every tool, used by the status message", () => {
  for (const spec of TOOLS) {
    assert.equal(toolSpec(spec.id).label, spec.label);
    assert.ok(spec.label.length > 0);
  }
});
