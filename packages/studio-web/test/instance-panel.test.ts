import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { collectTextCopies } from "../src/instance-panel";

function node(id: string, parentId: string, type: DesignNode["type"] = "frame", extra: Record<string, unknown> = {}): DesignNode {
  return {
    id,
    type,
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

function documentWithInstance(): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  const instance = node("instance:1", "page:1", "instance", { componentId: "component:card", overrides: {} });
  const label = node("instance:1--label", "instance:1", "text", { text: "标题", fontFamily: "Inter", fontSize: 16, lineHeight: 24 });
  const box = node("instance:1--box", "instance:1");
  const slotText = node("instance:1--slot--instance:1--slot--content", "instance:1", "text", { text: "插槽内容", fontFamily: "Inter", fontSize: 16, lineHeight: 24 });
  instance.childIds = [label.id, box.id, slotText.id];
  document.nodes = { [instance.id]: instance, [label.id]: label, [box.id]: box, [slotText.id]: slotText };
  document.pages["page:1"]!.childIds = [instance.id];
  return document;
}

test("collects only the materialized text nodes defined by the component", () => {
  const copies = collectTextCopies(documentWithInstance(), "instance:1");
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0], { id: "instance:1--label", sourceNodeId: "label", name: "instance:1--label", text: "标题" });
});

test("slot content and non-text copies are not treated as overridable", () => {
  const copies = collectTextCopies(documentWithInstance(), "instance:1");
  assert.equal(copies.some(copy => copy.text === "插槽内容"), false);
  assert.equal(copies.some(copy => copy.id.endsWith("--box")), false);
});
