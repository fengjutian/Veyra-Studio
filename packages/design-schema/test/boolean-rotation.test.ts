import assert from "node:assert/strict";
import test from "node:test";
import {
  absolutePath,
  computeBooleanBounds,
  computeBooleanGeometry,
  computeBooleanPath,
  createDocument,
  defaultAppearance,
  defaultLayout,
  pathBounds,
  rotatedBoxBounds,
  type BooleanOperation,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

/**
 * 布尔组支持旋转的操作数。
 *
 * 旋转在「造路径」这一步就做掉：曲线级引擎与多边形近似两条路径拿到的是
 * 同一份旋转后的几何，结果因此不会因为换了引擎而变样。
 */

function shape(id: string, x: number, y: number, width: number, height: number, rotation = 0): DesignNode {
  return {
    id,
    type: "rectangle",
    name: id,
    parentId: "bool",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height, ...(rotation ? { rotation } : {}) },
    appearance: defaultAppearance(),
  } as DesignNode;
}

function booleanDocument(operation: BooleanOperation, operands: DesignNode[]) {
  const document = createDocument("doc:bool", "Bool", "page:1");
  const bool: DesignNode = {
    id: "bool",
    type: "boolean",
    name: "bool",
    parentId: "page:1",
    childIds: operands.map(operand => operand.id),
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 1, height: 1 },
    appearance: defaultAppearance(),
    operation,
  } as DesignNode;
  document.nodes["bool"] = bool;
  for (const operand of operands) document.nodes[operand.id] = operand;
  document.pages["page:1"]!.childIds = ["bool"];
  const boxes = Object.fromEntries(operands.map(operand => [operand.id, {
    x: operand.layout.x,
    y: operand.layout.y,
    width: operand.layout.width,
    height: operand.layout.height,
  }]));
  return { document, boxes };
}

test("旋转过的操作数在路径里被转过去（绕自身中心）", () => {
  // 两个同样的、旋转 90° 的长方形：合并结果就是那个转过去的形状（宽高互换）。
  const { document, boxes } = booleanDocument("union", [shape("a", 0, 0, 100, 50, 90), shape("b", 0, 0, 100, 50, 90)]);
  const commands = computeBooleanPath(document, document.nodes["bool"]!, boxes)!;
  const bounds = pathBounds(commands)!;
  assert.ok(Math.abs(bounds.width - 50) < 1e-6, `宽度 ${bounds.width}`);
  assert.ok(Math.abs(bounds.height - 100) < 1e-6, `高度 ${bounds.height}`);
  // 中心不动：(25, 50)。
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 50) < 1e-6, `中心 x ${bounds.x + bounds.width / 2}`);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - 25) < 1e-6, `中心 y ${bounds.y + bounds.height / 2}`);
});

test("转 45° 的正方形外接盒变大", () => {
  const { document, boxes } = booleanDocument("union", [shape("a", 0, 0, 100, 100, 45), shape("b", 0, 0, 100, 100, 45)]);
  const commands = computeBooleanPath(document, document.nodes["bool"]!, boxes)!;
  const bounds = pathBounds(commands)!;
  const expected = Math.SQRT2 * 100;
  assert.ok(Math.abs(bounds.width - expected) < 1e-6, `宽度 ${bounds.width}，期望 ${expected}`);
  assert.ok(Math.abs(bounds.height - expected) < 1e-6, `高度 ${bounds.height}`);
});

test("布尔组的参考框是操作数并集（含旋转）", () => {
  const { document, boxes } = booleanDocument("union", [shape("a", 0, 0, 100, 100), shape("b", 100, 0, 100, 100, 45)]);
  const bounds = computeBooleanBounds(document, document.nodes["bool"]!, boxes)!;
  // 第二个操作数转 45° 后伸到右边 100 + 100/√2 ≈ 170.7。
  assert.ok(Math.abs(bounds.x - 0) < 1e-6);
  assert.ok(bounds.width > 165, `宽度 ${bounds.width}`);
});

test("归一化按并集框做，旋转的操作数不会被拉变形", () => {
  const { document, boxes } = booleanDocument("union", [shape("a", 0, 0, 100, 100, 45), shape("b", 0, 0, 100, 100, 45)]);
  const bounds = computeBooleanBounds(document, document.nodes["bool"]!, boxes)!;
  const normalized = computeBooleanGeometry(document, document.nodes["bool"]!, boxes, bounds)!;
  // 归一化后再按同一个框还原，包围盒必须与参考框一致（否则形状被拉变形了）。
  const restored = pathBounds(absolutePath(normalized, bounds))!;
  assert.ok(Math.abs(restored.width - bounds.width) < 1e-6, `宽度 ${restored.width}，参考框 ${bounds.width}`);
  assert.ok(Math.abs(restored.height - bounds.height) < 1e-6, `高度 ${restored.height}，参考框 ${bounds.height}`);
});

test("旋转盒子的轴对齐包围盒", () => {
  const bounds = rotatedBoxBounds({ x: 0, y: 0, width: 100, height: 100 }, 45);
  const expected = Math.SQRT2 * 100;
  assert.ok(Math.abs(bounds.width - expected) < 1e-6);
  assert.ok(Math.abs(bounds.x - (50 - expected / 2)) < 1e-6);
  // 没旋转时原样返回。
  assert.deepEqual(rotatedBoxBounds({ x: 1, y: 2, width: 3, height: 4 }, 0), { x: 1, y: 2, width: 3, height: 4 });
});
