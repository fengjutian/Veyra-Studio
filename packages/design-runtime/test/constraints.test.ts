import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type Constraints, type DesignDocument, type DesignNode, type LayoutSpec } from "@ufira/design-schema";
import { applyConstraints } from "../src/constraints";
import { DesignRuntime } from "../src/index";

function parent(id: string, layout: Partial<LayoutSpec> = {}, childIds: string[] = []): DesignNode {
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

function documentWith(nodes: DesignNode[], root = "parent"): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.nodes = Object.fromEntries(nodes.map(node => [node.id, node]));
  document.pages["page:1"]!.childIds = [root];
  return document;
}

function changes(document: DesignDocument, from: Partial<LayoutSpec>, to: Partial<LayoutSpec>) {
  const p = document.nodes["parent"]!;
  const previous = { ...p.layout, ...from };
  const next = { ...p.layout, ...to };
  return applyConstraints(document, p, previous, next);
}

const END: Constraints = { horizontal: "end", vertical: "start" };

test("end keeps the right margin", () => {
  const document = documentWith([parent("parent", {}, ["c"]), child("c", 60, 10, 30, 20, END)]);
  const result = changes(document, { width: 100 }, { width: 200 });
  assert.deepEqual(result, [{ id: "c", layout: { ...document.nodes["c"]!.layout, x: 160 } }]);
});

test("stretch keeps both margins", () => {
  const document = documentWith([parent("parent", {}, ["c"]), child("c", 10, 10, 30, 20, { horizontal: "stretch", vertical: "start" })]);
  const result = changes(document, { width: 100 }, { width: 200 });
  assert.equal(result[0]?.layout.width, 130);
  assert.equal(result[0]?.layout.x, 10);
});

test("center keeps the child centred", () => {
  const document = documentWith([parent("parent", {}, ["c"]), child("c", 40, 10, 20, 20, { horizontal: "center", vertical: "start" })]);
  const result = changes(document, { width: 100 }, { width: 200 });
  assert.equal(result[0]?.layout.x, 90);
  assert.equal(result[0]?.layout.width, 20);
});

test("scale moves and resizes proportionally", () => {
  const document = documentWith([parent("parent", {}, ["c"]), child("c", 10, 10, 20, 20, { horizontal: "scale", vertical: "scale" })]);
  const result = changes(document, { width: 100, height: 100 }, { width: 200, height: 50 });
  assert.equal(result[0]?.layout.x, 20);
  assert.equal(result[0]?.layout.width, 40);
  assert.equal(result[0]?.layout.y, 5);
  assert.equal(result[0]?.layout.height, 10);
});

test("a child without constraints never moves", () => {
  const document = documentWith([parent("parent", {}, ["c"]), child("c", 60, 10, 30, 20)]);
  assert.deepEqual(changes(document, { width: 100 }, { width: 300 }), []);
});

test("stack and hug parents do not constrain their children", () => {
  const stack = documentWith([parent("parent", { mode: "stack", direction: "vertical" }, ["c"]), child("c", 0, 0, 30, 20, END)]);
  assert.deepEqual(changes(stack, { width: 100 }, { width: 200 }), []);

  const hug = documentWith([parent("parent", { widthMode: "hug" }, ["c"]), child("c", 60, 0, 30, 20, END)]);
  assert.deepEqual(changes(hug, { width: 100 }, { width: 200 }), []);
});

test("changes propagate into a resized child's own children", () => {
  const parentNode = parent("parent", {}, ["c"]);
  const middle = child("c", 0, 0, 100, 100, { horizontal: "stretch", vertical: "start" });
  middle.childIds = ["g"];
  const grandchild: DesignNode = { ...child("g", 10, 10, 10, 10, { horizontal: "scale", vertical: "start" }), parentId: "c" };
  const document = documentWith([parentNode, middle, grandchild]);
  const result = changes(document, { width: 100 }, { width: 200 });
  // 中间层被 stretch 拉到 200 宽，它的子节点按 100 → 200 缩放。
  assert.deepEqual(result.map(change => change.id), ["c", "g"]);
  assert.equal(result[0]?.layout.width, 200);
  assert.equal(result[1]?.layout.x, 20);
  assert.equal(result[1]?.layout.width, 20);
});

test("applying a parent resize through the runtime moves children in one revision", () => {
  const document = documentWith([parent("parent", {}, ["c"]), child("c", 60, 10, 30, 20, END)]);
  const runtime = new DesignRuntime(document);
  const result = runtime.execute({
    commandId: "cmd:1",
    documentId: "doc:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands: [{ type: "node.patch", payload: { id: "parent", patch: { layout: { ...document.nodes["parent"]!.layout, width: 200 } } } }],
  });
  assert.equal(result.revision, 1);
  assert.equal(runtime.snapshot().nodes["c"]!.layout.x, 160);
  // 撤销（inverse）要把父子一起还原：inverse.after 就是命令执行前的状态。
  assert.equal(result.inverse.after.nodes["c"]!.layout.x, 60);
  assert.equal(result.inverse.after.nodes["parent"]!.layout.width, 100);
});
