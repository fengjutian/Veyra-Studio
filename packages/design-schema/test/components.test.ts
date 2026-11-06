import assert from "node:assert/strict";
import test from "node:test";
import { componentDependencies, componentReachability, createDocument, findOwningComponentId, overridableFields, wouldCreateComponentCycle, type DesignDocument, type DesignNode } from "../src/index";

function frame(id: string, parentId: string): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { mode: "absolute", x: 0, y: 0, width: 10, height: 10, widthMode: "fixed", heightMode: "fixed" },
    appearance: { opacity: 1 },
  };
}

function instance(id: string, parentId: string, componentId: string): DesignNode {
  return {
    ...frame(id, parentId),
    type: "instance",
    componentId,
    overrides: {},
  } as DesignNode;
}

function componentRoot(id: string): DesignNode {
  return { ...frame(id, "page:1"), type: "component" };
}

/** A 根含一个文本；B 根是空的，但把 A 的实例放进去（B → A）。 */
function documentWithNesting(): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  const a = componentRoot("a-root");
  const b = componentRoot("b-root");
  const aInstanceInB = instance("in-b", "b-root", "component:a");
  b.childIds = ["in-b"];
  document.nodes = { "a-root": a, "b-root": b, "in-b": aInstanceInB };
  document.pages["page:1"].childIds = ["a-root", "b-root"];
  document.components = {
    "component:a": { id: "component:a", name: "A", rootNodeId: "a-root" },
    "component:b": { id: "component:b", name: "B", rootNodeId: "b-root" },
  };
  return document;
}

test("collects direct component references from a subtree", () => {
  const document = documentWithNesting();
  assert.deepEqual(componentDependencies(document, "b-root"), ["component:a"]);
  assert.deepEqual(componentDependencies(document, "a-root"), []);
  assert.deepEqual(componentDependencies(document, "missing"), []);
});

test("resolves transitive component reachability", () => {
  const document = documentWithNesting();
  assert.deepEqual([...componentReachability(document, "component:b")], ["component:a"]);
  assert.deepEqual([...componentReachability(document, "component:a")], []);
});

test("detects self and indirect cycles", () => {
  const document = documentWithNesting();
  // 把 A 的实例放进 A 的根：自引用。
  assert.equal(wouldCreateComponentCycle(document, "component:a", "in-b"), true);
  // A 的根提升为组件时引用 B，而 B 又依赖 A：间接环。
  const withAInstance = structuredClone(document);
  withAInstance.nodes["in-a"] = instance("in-a", "a-root", "component:b");
  withAInstance.nodes["a-root"]!.childIds = ["in-a"];
  assert.equal(wouldCreateComponentCycle(withAInstance, "component:a", "a-root"), true);
  // 全新组件、子树里没有任何组件引用：不成环。
  assert.equal(wouldCreateComponentCycle(document, "component:c", "a-root"), false);
});

test("finds the innermost owning component", () => {
  const document = documentWithNesting();
  assert.equal(findOwningComponentId(document, "in-b"), "component:b");
  assert.equal(findOwningComponentId(document, "b-root"), "component:b");
  assert.equal(findOwningComponentId(document, "page:1"), undefined);
});

test("override field contract depends on the node type", () => {
  const text: DesignNode = { ...frame("t", "page:1"), type: "text", text: "x", fontFamily: "Inter", fontSize: 16, lineHeight: 24 } as DesignNode;
  assert.deepEqual(overridableFields(text), ["text", "name", "visible", "appearance"]);
  assert.deepEqual(overridableFields(frame("f", "page:1")), ["name", "visible", "appearance"]);
  assert.deepEqual(overridableFields(instance("i", "page:1", "component:x")), ["name", "visible", "appearance"]);
});