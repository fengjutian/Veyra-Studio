import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type Constraints, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { constrainedBoxes } from "../src/constraint-preview";
import type { SceneBox } from "../src/renderer/scene";

const box = (x: number, y: number, width: number, height: number): SceneBox => ({ x, y, width, height });

function frame(id: string, layout: Partial<DesignNode["layout"]>, childIds: string[] = []): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds,
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 100, height: 100, ...layout },
    appearance: defaultAppearance(),
  };
}

function child(id: string, x: number, y: number, width: number, height: number, constraints?: Constraints): DesignNode {
  return {
    id,
    type: "rectangle",
    name: id,
    parentId: "parent",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: defaultAppearance(),
    ...(constraints ? { constraints } : {}),
  };
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.nodes = Object.fromEntries(nodes.map(node => [node.id, node]));
  document.pages["page:1"]!.childIds = ["parent"];
  return document;
}

const END: Constraints = { horizontal: "end", vertical: "start" };

test("an end-pinned child keeps its right margin in the preview", () => {
  const document = documentWith([frame("parent", {}, ["c"]), child("c", 60, 10, 30, 20, END)]);
  const result = constrainedBoxes(document, { parent: box(0, 0, 100, 100), c: box(60, 10, 30, 20) }, "parent", box(0, 0, 100, 100), box(0, 0, 200, 100));
  assert.deepEqual(result.c, { x: 160, y: 10, width: 30, height: 20 });
});

test("a stretching child grows with the parent", () => {
  const document = documentWith([frame("parent", {}, ["c"]), child("c", 10, 10, 30, 20, { horizontal: "stretch", vertical: "start" })]);
  const result = constrainedBoxes(document, { parent: box(0, 0, 100, 100), c: box(10, 10, 30, 20) }, "parent", box(0, 0, 100, 100), box(0, 0, 200, 100));
  assert.equal(result.c?.width, 130);
  assert.equal(result.c?.x, 10);
});

test("children follow the parent when its origin moves", () => {
  const document = documentWith([frame("parent", {}, ["c"]), child("c", 60, 10, 30, 20, END)]);
  // 从左上角手柄缩放：父级位置也变了，子节点要跟着平移。
  const result = constrainedBoxes(document, { parent: box(100, 100, 100, 100), c: box(160, 110, 30, 20) }, "parent", box(100, 100, 100, 100), box(50, 100, 150, 100));
  // 父级右边停在 200、子节点右间距 10 不变，所以子节点仍在 160；纵向不受影响。
  assert.equal(result.c?.x, 160);
  assert.equal(result.c?.y, 110);
});

test("nothing is previewed when the size does not change", () => {
  const document = documentWith([frame("parent", {}, ["c"]), child("c", 60, 10, 30, 20, END)]);
  assert.deepEqual(constrainedBoxes(document, { parent: box(0, 0, 100, 100), c: box(60, 10, 30, 20) }, "parent", box(100, 0, 100, 100), box(100, 0, 100, 100)), {});
});

test("stack parents and unconstrained children are skipped", () => {
  const stack = documentWith([frame("parent", { mode: "stack", direction: "vertical" }, ["c"]), child("c", 0, 0, 30, 20, END)]);
  assert.deepEqual(constrainedBoxes(stack, { parent: box(0, 0, 100, 100), c: box(0, 0, 30, 20) }, "parent", box(0, 0, 100, 100), box(0, 0, 200, 100)), {});

  const free = documentWith([frame("parent", {}, ["c"]), child("c", 10, 10, 30, 20)]);
  assert.deepEqual(constrainedBoxes(free, { parent: box(0, 0, 100, 100), c: box(10, 10, 30, 20) }, "parent", box(0, 0, 100, 100), box(0, 0, 200, 100)), {});
});

test("a resized child previews its own children too", () => {
  const parent = frame("parent", {}, ["c"]);
  const middle = child("c", 0, 0, 100, 100, { horizontal: "stretch", vertical: "start" });
  middle.childIds = ["g"];
  const grandchild: DesignNode = { ...child("g", 10, 10, 10, 10, { horizontal: "scale", vertical: "start" }), parentId: "c" };
  const document = documentWith([parent, middle, grandchild]);
  const result = constrainedBoxes(
    document,
    { parent: box(0, 0, 100, 100), c: box(0, 0, 100, 100), g: box(10, 10, 10, 10) },
    "parent",
    box(0, 0, 100, 100),
    box(0, 0, 200, 100),
  );
  assert.equal(result.c?.width, 200);
  // 中间层 100 → 200，孙节点按 scale 翻倍。
  assert.equal(result.g?.x, 20);
  assert.equal(result.g?.width, 20);
});
