import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBooleanGeometry,
  computeBooleanPath,
  createDocument,
  defaultAppearance,
  defaultLayout,
  hitTestVectorPath,
  pathBounds,
  type BooleanOperation,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

function shape(id: string, x: number, y: number, width: number, height: number, overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "rectangle",
    name: id,
    parentId: "bool",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

/** 建一个只含一个布尔节点的文档；操作数的盒子直接取 layout（都是绝对定位）。 */
function booleanDocument(operation: BooleanOperation, operands: DesignNode[], id = "bool"): { document: DesignDocument; boxes: Record<string, { x: number; y: number; width: number; height: number }> } {
  const document = createDocument("doc:bool", "Bool", "page:1");
  const map = Object.fromEntries(operands.map(operand => [operand.id, { x: operand.layout.x, y: operand.layout.y, width: operand.layout.width, height: operand.layout.height }]));
  const bool: DesignNode = {
    id,
    type: "boolean",
    name: id,
    parentId: "page:1",
    childIds: operands.map(operand => operand.id),
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 1, height: 1 },
    appearance: defaultAppearance(),
    operation,
  } as DesignNode;
  document.nodes[id] = bool;
  for (const operand of operands) document.nodes[operand.id] = operand;
  document.pages["page:1"]!.childIds = [id];
  return { document, boxes: map };
}

function pathOf(operation: BooleanOperation, operands: DesignNode[]) {
  const { document, boxes } = booleanDocument(operation, operands);
  const commands = computeBooleanPath(document, document.nodes["bool"]!, boxes);
  return { document, boxes, commands };
}

test("union of two shapes sharing an edge has no seam", () => {
  const { commands } = pathOf("union", [shape("a", 0, 0, 100, 100), shape("b", 100, 0, 100, 100)]);
  assert.ok(commands?.length);
  assert.equal(commands.filter(command => command.command === "M").length, 1);
  const bounds = pathBounds(commands)!;
  assert.deepEqual(bounds, { x: 0, y: 0, width: 200, height: 100 });
  assert.equal(hitTestVectorPath(commands, bounds, { x: 100, y: 50 }), true);
});

test("subtract produces a hole the hit test respects", () => {
  const absolute = pathOf("subtract", [shape("base", 0, 0, 200, 200), shape("hole", 50, 50, 100, 100)]);
  assert.ok(absolute.commands?.length);
  assert.equal(absolute.commands.filter(command => command.command === "M").length, 2);
  // 命中测试吃的是「归一化路径 + 盒子」，所以这里先把绝对几何归一化到自己的包围盒。
  const box = pathBounds(absolute.commands)!;
  const commands = computeBooleanGeometry(absolute.document, absolute.document.nodes["bool"]!, absolute.boxes, box)!;
  assert.equal(hitTestVectorPath(commands, box, { x: 100, y: 100 }), false);
  assert.equal(hitTestVectorPath(commands, box, { x: 10, y: 10 }), true);
});

test("intersection keeps only the overlap", () => {
  const { commands } = pathOf("intersect", [shape("a", 0, 0, 100, 100), shape("b", 50, 50, 100, 100)]);
  assert.deepEqual(pathBounds(commands!), { x: 50, y: 50, width: 50, height: 50 });
});

test("exclude splits the shapes into disjoint pieces", () => {
  const absolute = pathOf("exclude", [shape("a", 0, 0, 100, 100), shape("b", 50, 50, 100, 100)]);
  assert.ok(absolute.commands!.filter(command => command.command === "M").length >= 2);
  const box = pathBounds(absolute.commands)!;
  const commands = computeBooleanGeometry(absolute.document, absolute.document.nodes["bool"]!, absolute.boxes, box)!;
  assert.equal(hitTestVectorPath(commands, box, { x: 75, y: 75 }), false);
  assert.equal(hitTestVectorPath(commands, box, { x: 10, y: 10 }), true);
});

test("an empty result is undefined instead of an empty path", () => {
  const { commands } = pathOf("intersect", [shape("a", 0, 0, 10, 10), shape("b", 100, 100, 10, 10)]);
  assert.equal(commands, undefined);
});

test("ellipses and vector paths participate as polygons", () => {
  const ellipse = shape("e", 0, 0, 100, 100, { type: "ellipse" } as Partial<DesignNode>);
  const withEllipse = pathOf("union", [ellipse, shape("r", 50, 0, 100, 100)]);
  const bounds = pathBounds(withEllipse.commands!)!;
  assert.ok(bounds.width > 100);
  assert.equal(Math.round(bounds.height), 100);

  const vector = shape("v", 0, 0, 100, 100, {
    type: "vector",
    geometry: { kind: "path", d: "M 0 0 L 1 0 L 1 1 L 0 1 Z" },
  } as Partial<DesignNode>);
  const withVector = pathOf("union", [vector, shape("r2", 50, 50, 100, 100)]);
  assert.deepEqual(pathBounds(withVector.commands!), { x: 0, y: 0, width: 150, height: 150 });
});

test("a nested boolean group can be an operand", () => {
  // 内层：两个矩形合并；外层：内层再与右侧矩形合并。
  const inner = shape("inner", 0, 0, 100, 100);
  const innerSecond = shape("inner2", 100, 0, 50, 100);
  const innerGroup: DesignNode = {
    id: "group", type: "boolean", name: "group", parentId: "bool", childIds: ["inner", "inner2"],
    visible: true, locked: false, layout: { ...defaultLayout(), width: 1, height: 1 }, appearance: defaultAppearance(), operation: "union",
  } as DesignNode;
  const outer = shape("outer", 140, 0, 60, 100);
  const document = createDocument("doc:nested", "Nested", "page:1");
  document.nodes["bool"] = {
    id: "bool", type: "boolean", name: "bool", parentId: "page:1", childIds: ["group", "outer"],
    visible: true, locked: false, layout: { ...defaultLayout(), width: 1, height: 1 }, appearance: defaultAppearance(), operation: "union",
  } as DesignNode;
  document.nodes["group"] = innerGroup;
  document.nodes["inner"] = inner;
  document.nodes["inner2"] = innerSecond;
  document.nodes["outer"] = outer;
  document.pages["page:1"]!.childIds = ["bool"];

  const boxes = {
    inner: { x: 0, y: 0, width: 100, height: 100 },
    inner2: { x: 100, y: 0, width: 50, height: 100 },
    group: { x: 0, y: 0, width: 150, height: 100 },
    outer: { x: 140, y: 0, width: 60, height: 100 },
  };
  const bounds = pathBounds(computeBooleanPath(document, document.nodes["bool"]!, boxes)!)!;
  assert.deepEqual(bounds, { x: 0, y: 0, width: 200, height: 100 });
});

test("invisible operands are ignored", () => {
  const hidden = shape("hidden", 100, 0, 100, 100, { visible: false } as Partial<DesignNode>);
  const { commands } = pathOf("union", [shape("a", 0, 0, 100, 100), hidden]);
  assert.equal(commands, undefined);
});

test("normalized geometry lands inside [0,1] for the group box", () => {
  const { document, boxes } = booleanDocument("union", [shape("a", 0, 0, 100, 100), shape("b", 0, 100, 100, 100)]);
  const normalized = computeBooleanGeometry(document, document.nodes["bool"]!, boxes, { x: 0, y: 0, width: 100, height: 200 })!;
  for (const command of normalized) {
    if (command.command === "Z") continue;
    assert.ok(command.point.x >= -0.001 && command.point.x <= 1.001, `x ${command.point.x}`);
    assert.ok(command.point.y >= -0.001 && command.point.y <= 1.001, `y ${command.point.y}`);
  }
});
