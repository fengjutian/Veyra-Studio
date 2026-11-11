import assert from "node:assert/strict";
import test from "node:test";
import {
  colorAlpha,
  createDocument,
  defaultAppearance,
  defaultLayout,
  maskOpacity,
  roundedRectPath,
  textFillColor,
  validateDocument,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

/**
 * 外观相关的新能力：阴影的扩散半径与内阴影、文本上色规则、蒙版不透明度。
 *
 * 这些规则都要三端一致，所以规则本身放在 schema 层（唯一来源），
 * 渲染与导出只负责按规则实现。
 */

function textNode(id: string, fills?: DesignNode["appearance"]["fills"]): DesignNode {
  return {
    id,
    type: "text",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 20 },
    appearance: { ...defaultAppearance(), ...(fills ? { fills } : {}) },
    text: "文字",
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 20,
  } as DesignNode;
}

function documentWith(node: DesignNode): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

test("阴影可以带扩散半径与类型，且都是可选字段", () => {
  const node = textNode("t");
  node.appearance.shadow = { x: 0, y: 4, blur: 12, color: "#00000040", spread: 6, type: "inner" };
  assert.doesNotThrow(() => validateDocument(documentWith(node)));
});

test("没有扩散半径的旧阴影仍然合法（格式版本不变）", () => {
  const node = textNode("t");
  node.appearance.shadow = { x: 0, y: 4, blur: 12, color: "#00000040" };
  assert.doesNotThrow(() => validateDocument(documentWith(node)));
});

test("蒙版羽化半径是可选字段", () => {
  const node = {
    id: "m",
    type: "rectangle",
    name: "m",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 10, height: 10 },
    appearance: defaultAppearance(),
    mask: true,
    maskFeather: 8,
  } as DesignNode;
  assert.doesNotThrow(() => validateDocument(documentWith(node)));
});

test("文本颜色：单层填充取该层颜色", () => {
  const node = textNode("t", [{ type: "solid", color: "#ff0000" }]);
  assert.equal(textFillColor(documentWith(node), node), "#ff0000");
});

test("文本颜色：多层填充只按第一层上色", () => {
  const node = textNode("t", [{ type: "solid", color: "#ff0000" }, { type: "solid", color: "#00ff00" }]);
  assert.equal(textFillColor(documentWith(node), node), "#ff0000");
});

test("文本颜色：渐变取第一个色标", () => {
  const node = textNode("t", [{ type: "linear", angle: 0, stops: [{ offset: 0, color: "#123456" }, { offset: 1, color: "#654321" }] }]);
  assert.equal(textFillColor(documentWith(node), node), "#123456");
});

test("文本颜色：没有填充时用默认文字色", () => {
  const node = textNode("t");
  assert.equal(textFillColor(documentWith(node), node), "#111111");
});

test("颜色 alpha：八位十六进制与 rgba 都认，其它写法按不透明处理", () => {
  assert.equal(colorAlpha("#000000"), 1);
  assert.equal(colorAlpha("#00000080"), 128 / 255);
  assert.equal(colorAlpha("#000"), 1);
  assert.equal(colorAlpha("rgba(0, 0, 0, 0.5)"), 0.5);
  assert.equal(colorAlpha("rgb(0, 0, 0)"), 1);
  assert.equal(colorAlpha("transparent"), 1);
});

test("蒙版不透明度 = 节点透明度 × 填充色的 alpha", () => {
  const node = textNode("m", [{ type: "solid", color: "#00000080" }]);
  node.appearance.opacity = 0.5;
  assert.ok(Math.abs(maskOpacity(documentWith(node), node) - 0.5 * (128 / 255)) < 1e-9);
  const opaque = textNode("m2");
  assert.equal(maskOpacity(documentWith(opaque), opaque), 1);
});

test("圆角矩形路径带圆角，并且半径被钳到短边一半", () => {
  const commands = roundedRectPath({ x: 0, y: 0, width: 100, height: 50 }, [10, 100, 100, 10]);
  const points = commands.flatMap(command => {
    if (command.command === "Z") return [];
    if (command.command === "C") return [command.point];
    return [command.point];
  });
  assert.ok(points.length > 4);
  // 起点在左上角圆角之后：x = 半径。
  assert.deepEqual(points[0], { x: 10, y: 0 });
  // 半径被钳到 25（短边的一半），所以右上角的 x 不超过 100。
  assert.ok(points.every(point => point.x <= 100 && point.y <= 50));
});
