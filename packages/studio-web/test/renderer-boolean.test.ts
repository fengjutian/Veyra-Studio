import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { buildNode } from "../src/renderer/scene";

function rect(id: string, parentId: string, x: number, y: number, width: number, height: number): DesignNode {
  return {
    id, type: "rectangle", name: id, parentId, childIds: [], visible: true, locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#8b5cf6" }] },
  };
}

function booleanScene(operation: "union" | "subtract", b = { x: 50, y: 50, width: 100, height: 100 }): ReturnType<typeof buildNode> {
  const document = createDocument("doc:bool", "Boolean");
  document.nodes["bool"] = {
    id: "bool", type: "boolean", name: "bool", parentId: "page:1", childIds: ["a", "b"],
    visible: true, locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 150, height: 150 },
    appearance: { ...defaultAppearance(), fills: [{ type: "solid", color: "#8b5cf6" }] },
    operation,
  } as DesignNode;
  document.nodes["a"] = rect("a", "bool", 0, 0, 100, 100);
  document.nodes["b"] = rect("b", "bool", b.x, b.y, b.width, b.height);
  document.pages["page:1"]!.childIds = ["bool"];
  const boxes = {
    bool: { x: 0, y: 0, width: 150, height: 150 },
    a: { x: 0, y: 0, width: 100, height: 100 },
    b,
  };
  return buildNode(document, document.nodes["bool"], boxes);
}

test("a boolean group becomes one scene node with a normalized path and no children", () => {
  const scene = booleanScene("union");
  assert.ok(scene);
  assert.equal(scene.type, "boolean");
  assert.equal(scene.children.length, 0);
  assert.ok(scene.path?.length);
  // 归一化坐标：全部落在 [0,1]，画布与命中因此复用 vector 的路径管线。
  for (const command of scene.path ?? []) {
    if (command.command === "Z") continue;
    assert.ok(command.point.x >= -0.001 && command.point.x <= 1.001, `x ${command.point.x}`);
    assert.ok(command.point.y >= -0.001 && command.point.y <= 1.001, `y ${command.point.y}`);
  }
  // 合并后是一个闭合外轮廓。
  assert.equal((scene.path ?? []).filter(command => command.command === "M").length, 1);
});

test("subtract yields two subpaths so the hole stays a hole", () => {
  // 洞完全落在基准层里面，结果才是「外轮廓 + 洞」两个子路径。
  const scene = booleanScene("subtract", { x: 25, y: 25, width: 50, height: 50 });
  assert.equal((scene.path ?? []).filter(command => command.command === "M").length, 2);
});
