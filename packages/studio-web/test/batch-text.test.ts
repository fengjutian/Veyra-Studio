import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignNode, type TextNode } from "@ufira/design-schema";
import { planTextPatches } from "../src/batch-edit";

test("plans one text patch per text node that changes", () => {
  const nodes = [text("text:a"), { ...text("text:b"), fontWeight: 700 }];
  const patches = planTextPatches(nodes, { fontWeight: 700 });
  assert.deepEqual(patches.map(patch => patch.id), ["text:a"]);
  assert.deepEqual(patches[0]!.patch, { fontWeight: 700 });
});

test("skips nodes that are not text nodes", () => {
  const patches = planTextPatches([frame("frame:a")], { fontWeight: 700 });
  assert.deepEqual(patches, []);
});

test("treats missing text styles as the defaults", () => {
  const patches = planTextPatches([text("text:a")], { fontWeight: 400, fontStyle: "normal", textAlign: "left", letterSpacing: 0 });
  assert.deepEqual(patches, []);
});

test("keeps the text fields the user did not touch", () => {
  const patches = planTextPatches([text("text:a")], { textAlign: "center" });
  assert.deepEqual(patches[0]!.patch, { textAlign: "center" });
});

test("plans several text styles at once", () => {
  const patches = planTextPatches([text("text:a")], { fontWeight: 600, fontStyle: "italic", textAlign: "right", letterSpacing: 4 });
  assert.deepEqual(patches[0]!.patch, { fontWeight: 600, fontStyle: "italic", textAlign: "right", letterSpacing: 4 });
});

function text(id: string): TextNode {
  return {
    id,
    type: "text",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), width: 160, height: 48 },
    appearance: { ...defaultAppearance() },
    text: "文本",
    fontFamily: "Inter",
    fontSize: 20,
    lineHeight: 28,
  };
}

function frame(id: string): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout() },
    appearance: { ...defaultAppearance() },
  };
}
