import assert from "node:assert/strict";
import test from "node:test";
import { computeBooleanPath, createDocument, defaultAppearance, defaultLayout, pathBounds, validateDocument, type DesignNode } from "@ufira/design-schema";
import { DesignRuntime } from "../src/index";

function shape(id: string, type: DesignNode["type"], x: number, y: number, width: number, height: number): DesignNode {
  const base = {
    id,
    type,
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: defaultAppearance(),
  };
  if (type === "text") return { ...base, type: "text", text: "Hi", fontFamily: "Inter", fontSize: 16, lineHeight: 24 } as DesignNode;
  return base as DesignNode;
}

const envelope = (revision: number, commands: any[]) => ({
  commandId: `cmd:${revision}`,
  documentId: "doc:bool",
  baseRevision: revision,
  actor: { type: "human" as const, id: "user:1" },
  commands,
});

function runtimeWithShapes(): DesignRuntime {
  const runtime = new DesignRuntime(createDocument("doc:bool", "Boolean", "page:1"));
  runtime.execute(envelope(0, [
    { type: "node.create", payload: { node: shape("a", "rectangle", 0, 0, 100, 100) } },
    { type: "node.create", payload: { node: shape("b", "rectangle", 50, 50, 100, 100) } },
    { type: "node.create", payload: { node: shape("label", "text", 0, 0, 40, 20) } },
  ]));
  return runtime;
}

function boxesOf(document: ReturnType<DesignRuntime["snapshot"]>) {
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const [id, node] of Object.entries(document.nodes)) boxes[id] = { x: node.layout.x, y: node.layout.y, width: node.layout.width, height: node.layout.height };
  return boxes;
}

test("combines sibling shapes into a boolean group that keeps the operands", () => {
  const runtime = runtimeWithShapes();
  runtime.execute(envelope(1, [{ type: "boolean.create", payload: { id: "bool:1", operation: "union", nodeIds: ["a", "b"] } }]));

  const document = runtime.snapshot();
  const bool = document.nodes["bool:1"]!;
  assert.equal(bool.type, "boolean");
  assert.deepEqual(bool.childIds, ["a", "b"]);
  assert.deepEqual({ x: bool.layout.x, y: bool.layout.y, width: bool.layout.width, height: bool.layout.height }, { x: 0, y: 0, width: 150, height: 150 });
  // 操作数坐标换算成相对布尔组，并挂到它下面。
  assert.deepEqual(document.nodes["a"]!.parentId, "bool:1");
  assert.deepEqual({ x: document.nodes["a"]!.layout.x, y: document.nodes["a"]!.layout.y }, { x: 0, y: 0 });
  assert.deepEqual({ x: document.nodes["b"]!.layout.x, y: document.nodes["b"]!.layout.y }, { x: 50, y: 50 });
  // 布尔组替换掉了两个操作数在页面上的位置。
  assert.deepEqual(document.pages["page:1"]!.childIds, ["bool:1", "label"]);
  // 文档仍然合法，且几何能算出来。
  assert.deepEqual(validateDocument(document), document);
  const bounds = pathBounds(computeBooleanPath(document, bool, boxesOf(document))!)!;
  assert.deepEqual(bounds, { x: 0, y: 0, width: 150, height: 150 });
});

test("changing the operation updates the computed geometry without rebaking", () => {
  const runtime = runtimeWithShapes();
  runtime.execute(envelope(1, [{ type: "boolean.create", payload: { id: "bool:1", operation: "union", nodeIds: ["a", "b"] } }]));
  runtime.execute(envelope(2, [{ type: "boolean.setOperation", payload: { id: "bool:1", operation: "intersect" } }]));

  const document = runtime.snapshot();
  const bool = document.nodes["bool:1"]!;
  assert.equal(bool.type === "boolean" ? bool.operation : "", "intersect");
  const bounds = pathBounds(computeBooleanPath(document, bool, boxesOf(document))!)!;
  assert.deepEqual(bounds, { x: 50, y: 50, width: 50, height: 50 });
});

test("releasing a boolean group restores the operands in place", () => {
  const runtime = runtimeWithShapes();
  runtime.execute(envelope(1, [{ type: "boolean.create", payload: { id: "bool:1", operation: "union", nodeIds: ["a", "b"] } }]));
  runtime.execute(envelope(2, [{ type: "boolean.release", payload: { id: "bool:1" } }]));

  const document = runtime.snapshot();
  assert.equal(document.nodes["bool:1"], undefined);
  assert.deepEqual(document.pages["page:1"]!.childIds, ["a", "b", "label"]);
  assert.deepEqual(document.nodes["a"]!.parentId, "page:1");
  assert.deepEqual({ x: document.nodes["a"]!.layout.x, y: document.nodes["a"]!.layout.y }, { x: 0, y: 0 });
  assert.deepEqual({ x: document.nodes["b"]!.layout.x, y: document.nodes["b"]!.layout.y }, { x: 50, y: 50 });
  assert.deepEqual(validateDocument(document), document);
});

test("rejects operands that cannot form a boolean group", () => {
  const runtime = runtimeWithShapes();
  const boom = (payload: any) => assert.throws(() => runtime.execute(envelope(runtime.snapshot().revision, [{ type: "boolean.create", payload }])), /operand|Boolean|shape|Locked|Rotated|same parent|does not exist|Unknown boolean/i);

  boom({ id: "bool:x", operation: "union", nodeIds: ["a"] });
  boom({ id: "bool:x", operation: "union", nodeIds: ["a", "label"] });
  boom({ id: "bool:x", operation: "union", nodeIds: ["a", "missing"] });
  boom({ id: "bool:x", operation: "nope", nodeIds: ["a", "b"] });

  runtime.execute(envelope(1, [{ type: "node.patch", payload: { id: "b", patch: { layout: { ...runtime.snapshot().nodes["b"]!.layout, rotation: 15 } } } }]));
  boom({ id: "bool:x", operation: "union", nodeIds: ["a", "b"] });
});

test("a boolean child cannot be deleted down to one operand", () => {
  const runtime = runtimeWithShapes();
  runtime.execute(envelope(1, [{ type: "boolean.create", payload: { id: "bool:1", operation: "union", nodeIds: ["a", "b"] } }]));
  assert.throws(
    () => runtime.execute(envelope(2, [{ type: "node.delete", payload: { id: "b" } }])),
    /at least two operands/,
  );
});

test("operands keep their z-order so the base layer stays the bottom one", () => {
  const runtime = runtimeWithShapes();
  // 选中顺序反过来，基准层仍然按页面 z 序（a 在下）。
  runtime.execute(envelope(1, [{ type: "boolean.create", payload: { id: "bool:1", operation: "subtract", nodeIds: ["b", "a"] } }]));
  const bool = runtime.snapshot().nodes["bool:1"]!;
  assert.deepEqual(bool.childIds, ["a", "b"]);
});
