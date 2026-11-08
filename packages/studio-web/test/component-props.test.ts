import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { collectTextCopies } from "../src/instance-panel";
import { componentPropertyViews, instancePropertyViews, nodeBoundByProperty } from "../src/component-props";

/**
 * 组件属性（component props）的展示层数据。
 *
 * 规格见 `docs/component-properties.md`。
 */

function frame(id: string, parentId: string, extra: Record<string, unknown> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

function textNode(id: string, parentId: string, content: string): DesignNode {
  return {
    ...frame(id, parentId),
    type: "text",
    text: content,
    fontFamily: "Inter",
    fontSize: 16,
    lineHeight: 24,
  } as DesignNode;
}

/** 一个含组件与实例的文档。 */
function propertyDocument(): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  const root = frame("root", "page:1", { type: "component" });
  const label = textNode("label", "root", "Hello");
  const box = frame("box", "root");
  root.childIds = [label.id, box.id];
  document.nodes[root.id] = root;
  document.nodes[label.id] = label;
  document.nodes[box.id] = box;

  const instance = frame("instance:1", "page:1", { type: "instance", componentId: "component:button", overrides: {} });
  const labelCopy = textNode("instance:1--label", "instance:1", "Hello");
  const boxCopy = frame("instance:1--box", "instance:1");
  instance.childIds = [labelCopy.id, boxCopy.id];
  document.nodes[instance.id] = instance;
  document.nodes[labelCopy.id] = labelCopy;
  document.nodes[boxCopy.id] = boxCopy;

  document.pages["page:1"]!.childIds.push(root.id, instance.id);
  document.components["component:button"] = {
    id: "component:button",
    name: "Button",
    rootNodeId: "root",
    properties: [
      { id: "prop:title", name: "标题", type: "text", defaultValue: "确定" },
      { id: "prop:badge", name: "角标", type: "boolean", defaultValue: true },
    ],
  };
  document.nodes["label"]!.componentPropertyBindings = { text: "prop:title" };
  document.nodes["box"]!.componentPropertyBindings = { visible: "prop:badge" };
  return document;
}

test("instance property views resolve values, explicitness and binding targets", () => {
  const document = propertyDocument();
  const instance = document.nodes["instance:1"] as Extract<DesignNode, { type: "instance" }>;
  const views = instancePropertyViews(document, instance);
  assert.equal(views.length, 2);
  assert.equal(views[0]!.propertyId, "prop:title");
  assert.equal(views[0]!.value, "确定");
  assert.equal(views[0]!.explicit, false);
  assert.equal(views[0]!.targetName, "label");
  assert.equal(views[1]!.value, true);
  assert.equal(views[1]!.targetName, "box");
});

test("an explicit instance value is reported as explicit", () => {
  const document = propertyDocument();
  const instance = document.nodes["instance:1"] as Extract<DesignNode, { type: "instance" }>;
  instance.propValues = { "prop:title": "提交" };
  const views = instancePropertyViews(document, instance);
  assert.equal(views[0]!.value, "提交");
  assert.equal(views[0]!.explicit, true);
  assert.equal(views[1]!.explicit, false);
});

test("component property views carry the binding target and field", () => {
  const document = propertyDocument();
  const views = componentPropertyViews(document, "component:button");
  assert.equal(views[0]!.targetNodeId, "label");
  assert.equal(views[0]!.field, "text");
  assert.equal(views[1]!.field, "visible");
  assert.equal(views[0]!.defaultValue, "确定");
});

test("nodeBoundByProperty finds the property driving a field", () => {
  const document = propertyDocument();
  assert.equal(nodeBoundByProperty(document, "component:button", "label", "text"), "prop:title");
  assert.equal(nodeBoundByProperty(document, "component:button", "label", "visible"), undefined);
  assert.equal(nodeBoundByProperty(document, "component:button", "box", "visible"), "prop:badge");
});

test("a property-bound text node is not offered as an overridable copy", () => {
  const document = propertyDocument();
  const copies = collectTextCopies(document, "instance:1");
  assert.equal(copies.length, 0);
});

test("text nodes without a property binding stay in the override list", () => {
  const document = propertyDocument();
  delete document.nodes["label"]!.componentPropertyBindings;
  const copies = collectTextCopies(document, "instance:1");
  assert.equal(copies.length, 1);
  assert.equal(copies[0]!.sourceNodeId, "label");
});
