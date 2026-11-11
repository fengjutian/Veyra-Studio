import assert from "node:assert/strict";
import test from "node:test";
import { componentDependencies, componentReachability, createDocument, exposedOverrideTargets, findOwningComponentId, overridableFields, wouldCreateComponentCycle, type DesignDocument, type DesignNode } from "../src/index";

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
  assert.deepEqual(overridableFields(text), ["text", "name", "visible", "appearance", "constraints"]);
  assert.deepEqual(overridableFields(frame("f", "page:1")), ["name", "visible", "appearance", "constraints"]);
  assert.deepEqual(overridableFields(instance("i", "page:1", "component:x")), ["name", "visible", "appearance", "constraints"]);
});

test("lists the override targets exposed by an instance", () => {
  const document = createDocument("doc:1", "Demo", "page:1");
  const instanceNode = instance("instance:1", "page:1", "component:card");
  const labelCopy = { ...frame("instance:1--label", "instance:1"), type: "text", text: "副本", fontFamily: "Inter", fontSize: 16, lineHeight: 24 } as DesignNode;
  const boxCopy = frame("instance:1--box", "instance:1");
  const slotCopy = { ...frame("instance:1--slot--x", "instance:1"), type: "text", text: "插槽", fontFamily: "Inter", fontSize: 16, lineHeight: 24 } as DesignNode;
  (instanceNode as { childIds: string[] }).childIds = [labelCopy.id, boxCopy.id, slotCopy.id];
  const labelSource = { ...frame("label", "card"), type: "text", text: "标题", fontFamily: "Inter", fontSize: 16, lineHeight: 24 } as DesignNode;
  const boxSource = frame("box", "card");
  const card = componentRoot("card");
  card.childIds = ["label", "box"];
  document.nodes = { "card": card, "label": labelSource, "box": boxSource, "instance:1": instanceNode, "instance:1--label": labelCopy, "instance:1--box": boxCopy, "instance:1--slot--x": slotCopy } as never;
  document.pages["page:1"].childIds = ["card", "instance:1"];
  document.components = { "component:card": { id: "component:card", name: "Card", rootNodeId: "card" } };

  const targets = exposedOverrideTargets(document, "instance:1");
  assert.deepEqual(targets.map(target => target.sourceNodeId), ["box", "label"]);
  assert.deepEqual(targets.find(target => target.sourceNodeId === "label")?.fields, ["text", "name", "visible", "appearance", "constraints"]);
  assert.equal(targets.find(target => target.sourceNodeId === "label")?.defaultText, "标题");
  assert.deepEqual(targets.find(target => target.sourceNodeId === "box")?.fields, ["name", "visible", "appearance", "constraints"]);
  // 插槽内容不是组件参数。
  assert.equal(targets.some(target => target.sourceNodeId.includes("slot")), false);
});

test("exposed targets are empty for non-instances", () => {
  const document = documentWithNesting();
  assert.deepEqual(exposedOverrideTargets(document, "a-root"), []);
  assert.deepEqual(exposedOverrideTargets(document, "missing"), []);
});