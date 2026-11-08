import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument } from "@ufira/design-schema";
import { formatVariant, listComponents, variantOptions } from "../src/components";

function componentRoot(document: DesignDocument, id: string): void {
  document.nodes[id] = {
    id,
    type: "component",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
  };
  document.pages["page:1"]!.childIds.push(id);
}

function variantDocument(): DesignDocument {
  const document = createDocument("doc:variants", "Variants", "page:1");
  componentRoot(document, "root:default");
  componentRoot(document, "root:hover");
  document.componentSets = { "set:button": { id: "set:button", name: "Button", properties: ["state", "size"] } };
  document.components["component:default"] = {
    id: "component:default", name: "Button", rootNodeId: "root:default",
    variantSetId: "set:button", variant: { state: "default", size: "md" },
  };
  document.components["component:hover"] = {
    id: "component:hover", name: "Button hover", rootNodeId: "root:hover",
    variantSetId: "set:button", variant: { state: "hover", size: "md" },
  };
  return document;
}

test("formats variant values in the order the set declares", () => {
  assert.equal(formatVariant(["state", "size"], { size: "md", state: "hover" }), "state=hover · size=md");
});

test("lists every sibling of the same variant set and marks the active one", () => {
  const options = variantOptions(variantDocument(), "component:default");
  assert.deepEqual(options, [
    { componentId: "component:default", label: "state=default · size=md", active: true },
    { componentId: "component:hover", label: "state=hover · size=md", active: false },
  ]);
});

test("returns no options for plain components or single-member sets", () => {
  const document = variantDocument();
  document.components["component:solo"] = { id: "component:solo", name: "Solo", rootNodeId: "root:default" };
  assert.deepEqual(variantOptions(document, "component:solo"), []);

  delete document.components["component:hover"];
  assert.deepEqual(variantOptions(document, "component:default"), []);
});

test("component summaries carry the variant label for the panel", () => {
  const summaries = listComponents(variantDocument());
  const hover = summaries.find(summary => summary.id === "component:hover");
  assert.equal(hover?.variantSetId, "set:button");
  assert.equal(hover?.variantLabel, "state=hover · size=md");
});
