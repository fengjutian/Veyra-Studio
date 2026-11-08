import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  hitTestVectorPath,
  parseVectorPath,
  type DesignDocument,
  type DesignNode,
} from "@ufira/design-schema";
import { applyBoolean, booleanOperands, type BooleanOperand } from "../src/boolean";

function rectangle(id: string, x: number, y: number, width: number, height: number, parentId = "page:1"): DesignNode {
  return {
    id,
    type: "rectangle",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: { ...defaultAppearance(), fill: "#8b5cf6" },
  };
}

function operand(node: DesignNode): BooleanOperand {
  const { x, y, width, height } = node.layout;
  return { node, box: { x, y, width, height } };
}

/** 结果的路径命令 + 命中判定，测试里反复用。 */
function resultOf(nodes: DesignNode[], operation: Parameters<typeof applyBoolean>[1]) {
  const result = applyBoolean(nodes.map(operand), operation);
  assert.ok(result, `${operation} 应该产出结果`);
  const commands = parseVectorPath(result.geometry.d);
  assert.ok(commands, `${operation} 的结果必须能通过路径校验`);
  return { result, commands };
}

test("union of two shapes sharing an edge has no seam", () => {
  const { result, commands } = resultOf([rectangle("a", 0, 0, 100, 100), rectangle("b", 100, 0, 100, 100)], "union");
  // 共线边缘是最容易出错的退化情形：不该留下零宽度的接缝。
  assert.equal(commands.filter(command => command.command === "M").length, 1);
  assert.deepEqual(result.box, { x: 0, y: 0, width: 200, height: 100 });
  assert.equal(hitTestVectorPath(commands, result.box, { x: 100, y: 50 }), true);
});

test("subtract produces a hole that the hit test respects", () => {
  const { result, commands } = resultOf([rectangle("base", 0, 0, 200, 200), rectangle("hole", 50, 50, 100, 100)], "subtract");
  // 外轮廓 + 洞 = 两个子路径。
  assert.equal(commands.filter(command => command.command === "M").length, 2);
  // 洞里的点不能命中，否则用户永远点不到洞下面的东西。
  assert.equal(hitTestVectorPath(commands, result.box, { x: 100, y: 100 }), false);
  assert.equal(hitTestVectorPath(commands, result.box, { x: 10, y: 10 }), true);
});

test("intersection keeps only the overlap", () => {
  const { result } = resultOf([rectangle("a", 0, 0, 100, 100), rectangle("b", 50, 50, 100, 100)], "intersect");
  assert.deepEqual(result.box, { x: 50, y: 50, width: 50, height: 50 });
});

test("exclude splits the shapes into disjoint pieces", () => {
  const { result, commands } = resultOf([rectangle("a", 0, 0, 100, 100), rectangle("b", 50, 50, 100, 100)], "exclude");
  assert.ok(commands.filter(command => command.command === "M").length >= 2);
  // 重叠区在排除结果里是空的。
  assert.equal(hitTestVectorPath(commands, result.box, { x: 75, y: 75 }), false);
  assert.equal(hitTestVectorPath(commands, result.box, { x: 10, y: 10 }), true);
});

test("an empty result is reported instead of committed", () => {
  assert.equal(applyBoolean([operand(rectangle("a", 0, 0, 10, 10)), operand(rectangle("b", 100, 100, 10, 10))], "intersect"), undefined);
});

test("an ellipse participates through a polygonal approximation", () => {
  const ellipse: DesignNode = {
    id: "e",
    type: "ellipse",
    name: "e",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    appearance: defaultAppearance(),
  };
  const { result } = resultOf([ellipse, rectangle("r", 50, 0, 100, 100)], "union");
  // 椭圆 + 右侧矩形：并集包围盒必须覆盖两者。
  assert.ok(result.box.width > 100, `width ${result.box.width}`);
  assert.equal(Math.round(result.box.height), 100);
});

test("a vector path participates with its subpaths", () => {
  const vector: DesignNode = {
    id: "v",
    type: "vector",
    name: "v",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100 },
    appearance: defaultAppearance(),
    geometry: { kind: "path", d: "M 0 0 L 1 0 L 1 1 L 0 1 Z" },
  };
  const { result } = resultOf([vector, rectangle("r", 50, 50, 100, 100)], "union");
  assert.deepEqual(result.box, { x: 0, y: 0, width: 150, height: 150 });
});

test("only same-parent unlocked shapes can be combined", () => {
  const document: DesignDocument = createDocument("doc:1", "Demo");
  const a = rectangle("a", 0, 0, 10, 10);
  const b = rectangle("b", 0, 0, 10, 10);
  const frame: DesignNode = { ...rectangle("frame", 0, 0, 100, 100), type: "frame" };
  const inner = rectangle("inner", 0, 0, 10, 10, "frame");
  document.nodes = { a, b, frame, inner };
  document.pages["page:1"]!.childIds = ["a", "b", "frame"];
  document.nodes["frame"]!.childIds = ["inner"];
  const boxes = { a: { x: 0, y: 0, width: 10, height: 10 }, b: { x: 0, y: 0, width: 10, height: 10 }, inner: { x: 0, y: 0, width: 10, height: 10 } };
  assert.equal(booleanOperands(["a", "b"], document, boxes)?.length, 2);
  // 跨父级（页面 vs Frame）不行。
  assert.equal(booleanOperands(["a", "inner"], document, boxes), undefined);
  // 单个节点不行。
  assert.equal(booleanOperands(["a"], document, boxes), undefined);
  // 锁定节点不行。
  document.nodes["b"] = { ...b, locked: true };
  assert.equal(booleanOperands(["a", "b"], document, boxes), undefined);
});

test("operands are ordered bottom-up by z-index, not selection order", () => {
  const document = createDocument("doc:1", "Demo");
  const document2 = document;
  const top = rectangle("top", 50, 0, 50, 50);
  const bottom = rectangle("bottom", 0, 0, 100, 100);
  document2.nodes = { top, bottom };
  document2.pages["page:1"]!.childIds = ["bottom", "top"];
  const boxes = { top: { x: 50, y: 0, width: 50, height: 50 }, bottom: { x: 0, y: 0, width: 100, height: 100 } };
  // 选中顺序是 top → bottom，但基准层必须是 z 序更低的 bottom。
  const operands = booleanOperands(["top", "bottom"], document2, boxes)!;
  assert.deepEqual(operands.map(item => item.node.id), ["bottom", "top"]);
});
