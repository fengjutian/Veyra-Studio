import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBooleanPath,
  createDocument,
  defaultAppearance,
  defaultLayout,
  getBooleanEngine,
  hitTestVectorPath,
  normalizePath,
  pathBounds,
  type BooleanOperation,
  type DesignDocument,
  type DesignNode,
} from "@ufira/design-schema";
import { installPaperBooleanEngine, uninstallPaperBooleanEngine } from "../src/boolean-engine";

/**
 * 曲线级布尔（paper.js 引擎）。
 *
 * 规格见 `docs/boolean-and-mask.md`。
 */

function shape(id: string, type: "rectangle" | "ellipse", x: number, y: number, width: number, height: number): DesignNode {
  return {
    id,
    type,
    name: id,
    parentId: "bool",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: defaultAppearance(),
  } as DesignNode;
}

function booleanDocument(operation: BooleanOperation, operands: DesignNode[]): { document: DesignDocument; boxes: Record<string, { x: number; y: number; width: number; height: number }> } {
  const document = createDocument("doc:bool", "Bool", "page:1");
  const boxes = Object.fromEntries(operands.map(operand => [operand.id, { x: operand.layout.x, y: operand.layout.y, width: operand.layout.width, height: operand.layout.height }]));
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
  return { document, boxes };
}

function commandsOf(operation: BooleanOperation, operands: DesignNode[]) {
  const { document, boxes } = booleanDocument(operation, operands);
  return computeBooleanPath(document, document.nodes["bool"]!, boxes);
}

/** 用网格采样估面积：与「环的绕向」无关，挖了洞的结果也能算对。 */
function areaOf(commands: NonNullable<ReturnType<typeof commandsOf>>): number {
  const bounds = pathBounds(commands)!;
  // 命中测试要的是归一化坐标的路径（与渲染器一致）。
  const normalized = normalizePath(commands, bounds);
  const step = 0.5;
  let inside = 0;
  for (let x = bounds.x + step / 2; x < bounds.x + bounds.width; x += step) {
    for (let y = bounds.y + step / 2; y < bounds.y + bounds.height; y += step) {
      // 容差必须给 0：命中测试默认会把「离轮廓 6px 以内」也算命中，
      // 采样算面积时那圈会把面积撑大。
      if (hitTestVectorPath(normalized, bounds, { x, y }, { tolerance: 0 })) inside += 1;
    }
  }
  return inside * step * step;
}

/** 两个半径 r、圆心距 d 的圆的并集面积。 */
function unionArea(r: number, d: number): number {
  const overlap = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
  return 2 * Math.PI * r * r - overlap;
}

test("installs and removes the engine", () => {
  assert.equal(getBooleanEngine(), undefined);
  installPaperBooleanEngine();
  assert.ok(getBooleanEngine());
  uninstallPaperBooleanEngine();
  assert.equal(getBooleanEngine(), undefined);
});

test("the union of two circles keeps the curves", () => {
  installPaperBooleanEngine();
  try {
    const commands = commandsOf("union", [
      shape("a", "ellipse", 10, 10, 80, 80),
      shape("b", "ellipse", 50, 10, 80, 80),
    ]);
    assert.ok(commands?.length);
    // 结果里有三次贝塞尔段——这正是「曲线级」与「折线近似」的区别。
    const curves = commands.filter(command => command.command === "C").length;
    assert.ok(curves >= 4, `只有 ${curves} 段曲线`);
    // 面积与解析解一致（容差 1%）。
    const expected = unionArea(40, 40);
    const actual = areaOf(commands!);
    assert.ok(Math.abs(actual - expected) / expected < 0.01, `面积 ${actual.toFixed(2)}，解析解 ${expected.toFixed(2)}`);
  } finally {
    uninstallPaperBooleanEngine();
  }
});

test("without the engine the result falls back to polylines", () => {
  const commands = commandsOf("union", [
    shape("a", "ellipse", 10, 10, 80, 80),
    shape("b", "ellipse", 50, 10, 80, 80),
  ]);
  assert.ok(commands?.length);
  // 兜底路径没有曲线段。
  assert.equal(commands.filter(command => command.command === "C").length, 0);
});

test("subtracting a rectangle from a circle keeps the arcs", () => {
  installPaperBooleanEngine();
  try {
    const commands = commandsOf("subtract", [
      shape("circle", "ellipse", 0, 0, 100, 100),
      shape("cut", "rectangle", 20, 20, 60, 60),
    ]);
    assert.ok(commands?.length);
    assert.ok(commands.filter(command => command.command === "C").length >= 2);
    // 挖掉的部分不再计入面积。
    const actual = areaOf(commands!);
    const circle = Math.PI * 50 * 50;
    assert.ok(actual < circle, `面积 ${actual.toFixed(2)} 应该小于整圆 ${circle.toFixed(2)}`);
    assert.ok(actual > circle * 0.5, `面积 ${actual.toFixed(2)} 太小了`);
  } finally {
    uninstallPaperBooleanEngine();
  }
});
