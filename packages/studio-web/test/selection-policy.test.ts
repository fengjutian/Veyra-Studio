import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignNode } from "@ufira/design-schema";
import { allLocked, canvasSelectable, deletableRoots, editableNodes } from "../src/selection-policy";

function node(id: string, options: { visible?: boolean; locked?: boolean } = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
}

test("画布只用鼠标选中看得见且没锁定的节点", () => {
  assert.equal(canvasSelectable(node("a")), true);
  assert.equal(canvasSelectable(node("hidden", { visible: false })), false);
  assert.equal(canvasSelectable(node("locked", { locked: true })), false);
  assert.equal(canvasSelectable(node("both", { visible: false, locked: true })), false);
});

test("批量移动/对齐跳过锁定节点，隐藏节点照常参与", () => {
  const nodes = [node("a"), node("locked", { locked: true }), node("hidden", { visible: false })];
  assert.deepEqual(editableNodes(nodes).map(item => item.id), ["a", "hidden"]);
});

test("只有整个选区都锁定时才提示先解锁", () => {
  assert.equal(allLocked([]), false);
  assert.equal(allLocked([node("a")]), false);
  assert.equal(allLocked([node("a", { locked: true })]), true);
  assert.equal(allLocked([node("a", { locked: true }), node("b")]), false);
});

test("删除只删未锁定的根节点", () => {
  assert.deepEqual(deletableRoots([
    { id: "a", locked: false },
    { id: "locked", locked: true },
    { id: "b", locked: false },
  ]), ["a", "b"]);
});
