import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { exportPageToHtml, exportPageToSvg } from "../src/index";

/** 带一个文本子节点的组件，以及一个覆盖了该文本的实例。 */
function documentWithOverriddenInstance(): DesignDocument {
  const document = createDocument("doc:1", "Components", "page:1");
  const card: DesignNode = { ...base("card", "page:1"), type: "component" };
  const label: DesignNode = { ...base("label", "card"), type: "text", text: "默认", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  const copy: DesignNode = { ...base("instance:1--label", "instance:1"), type: "text", text: "覆盖", fontFamily: "Inter", fontSize: 16, lineHeight: 24 };
  const instance: DesignNode = {
    ...base("instance:1", "page:1"),
    type: "instance",
    componentId: "component:card",
    overrides: { label: { text: "覆盖" } },
    childIds: [copy.id],
  };
  card.childIds = [label.id];
  document.nodes = { [card.id]: card, [label.id]: label, [instance.id]: instance, [copy.id]: copy };
  document.pages["page:1"]!.childIds = [card.id, instance.id];
  document.components = { "component:card": { id: "component:card", name: "Card", rootNodeId: "card" } };
  return document;
}

function base(id: string, parentId: string): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 120, height: 40 },
    appearance: defaultAppearance(),
  };
}

test("HTML reports overridden instances and exports the overridden text", () => {
  const result = exportPageToHtml(documentWithOverriddenInstance(), { pageId: "page:1", viewport: { width: 400, height: 300 } });
  const diagnostic = result.diagnostics.find(item => item.feature === "component-override");
  assert.equal(diagnostic?.support, "exact");
  assert.equal(diagnostic?.nodeId, "instance:1");
  assert.match(diagnostic?.message ?? "", /1 overridden node/);
  assert.match(result.document, /覆盖/);
});

test("SVG reports overridden instances and exports the overridden text", () => {
  const result = exportPageToSvg(documentWithOverriddenInstance(), { pageId: "page:1", viewport: { width: 400, height: 300 } });
  const diagnostic = result.diagnostics.find(item => item.feature === "component-override");
  assert.equal(diagnostic?.nodeId, "instance:1");
  assert.match(result.svg, /覆盖/);
});

test("instances without overrides do not emit an override diagnostic", () => {
  const document = documentWithOverriddenInstance();
  const instance = document.nodes["instance:1"] as { overrides: Record<string, unknown> };
  instance.overrides = {};
  const result = exportPageToSvg(document, { pageId: "page:1", viewport: { width: 400, height: 300 } });
  assert.equal(result.diagnostics.some(item => item.feature === "component-override"), false);
  // 组件实例本身的近似诊断仍然保留。
  assert.equal(result.diagnostics.some(item => item.feature === "component-instance"), true);
});
