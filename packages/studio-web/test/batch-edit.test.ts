import assert from "node:assert/strict";
import test from "node:test";
import { defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { mergedAppearance, mergedLayout, planAppearancePatches, planLayoutPatches, selectAllIds, sharedField } from "../src/batch-edit";

test("reports the shared value when every node agrees", () => {
  const field = sharedField([frame("a"), frame("b")], node => node.appearance.fill ?? "");
  assert.equal(field.value, "#111111");
  assert.equal(field.mixed, false);
});

test("marks the field as mixed when the nodes disagree", () => {
  const nodes = [frame("a"), { ...frame("b"), appearance: { ...defaultAppearance(), fill: "#222222" } }];
  const field = sharedField(nodes, node => node.appearance.fill ?? "");
  assert.equal(field.mixed, true);
});

test("keeps the fields the user did not touch", () => {
  const node = { ...frame("a"), appearance: { ...defaultAppearance(), fill: "#111111", stroke: "#333333", opacity: 0.5 } };
  const appearance = mergedAppearance(node, { fill: "#444444" });
  assert.equal(appearance.fill, "#444444");
  assert.equal(appearance.stroke, "#333333");
  assert.equal(appearance.opacity, 0.5);
});

test("clears the fill when an empty value is committed", () => {
  const node = { ...frame("a"), appearance: { ...defaultAppearance(), fill: "#111111" } };
  assert.equal(mergedAppearance(node, { fill: "" }).fill, undefined);
});

test("keeps the layout fields the user did not touch", () => {
  const node = { ...frame("a"), layout: { ...defaultLayout(), x: 12, y: 34, mode: "stack" as const, direction: "horizontal" as const, gap: 8 } };
  const layout = mergedLayout(node, { widthMode: "fill" });
  assert.equal(layout.widthMode, "fill");
  assert.equal(layout.x, 12);
  assert.equal(layout.gap, 8);
  assert.equal(layout.direction, "horizontal");
});

test("switches the size mode to fixed when a size is committed", () => {
  const node = { ...frame("a"), layout: { ...defaultLayout(), widthMode: "hug" as const, heightMode: "hug" as const } };
  const layout = mergedLayout(node, { width: 240 });
  assert.equal(layout.width, 240);
  assert.equal(layout.widthMode, "fixed");
  assert.equal(layout.heightMode, "hug");
});

test("skips the nodes whose appearance would not change", () => {
  const nodes = [frame("a"), { ...frame("b"), appearance: { ...defaultAppearance(), fill: "#222222" } }];
  const patches = planAppearancePatches(nodes, { fill: "#111111" });
  assert.deepEqual(patches.map(patch => patch.id), ["b"]);
});

test("releases the fill token binding so the new fill shows up", () => {
  const node = { ...frame("a"), bindings: { fill: "color.primary", typography: "type.body" } };
  const patches = planAppearancePatches([node], { fill: "#111111" });
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.bindings?.fill, undefined);
  assert.equal(patches[0]!.bindings?.typography, "type.body");
});

test("releases the binding even when the fill value stays the same", () => {
  const node = { ...frame("a"), bindings: { fill: "color.primary" } };
  const patches = planAppearancePatches([node], { fill: "#111111" });
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.bindings?.fill, undefined);
});

test("plans one layout patch per node that changes", () => {
  const nodes = [frame("a"), { ...frame("b"), layout: { ...defaultLayout(), width: 300 } }];
  const patches = planLayoutPatches(nodes, { width: 200 });
  assert.deepEqual(patches.map(patch => patch.id), ["a", "b"]);
  assert.deepEqual(patches.map(patch => patch.layout.width), [200, 200]);
});

test("selects the top level objects of a page", () => {
  const document = buildDocument();
  assert.deepEqual(selectAllIds(document, "page:1"), ["frame:a"]);
  assert.deepEqual(selectAllIds(document, "page:missing"), []);
});

function frame(id: string): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 20, width: 100, height: 80 },
    appearance: { ...defaultAppearance(), fill: "#111111" },
  };
}

function buildDocument(): DesignDocument {
  const parent = frame("frame:a");
  const child = { ...frame("frame:b"), parentId: "frame:a" };
  return {
    schemaVersion: 1,
    id: "doc:1",
    revision: 1,
    meta: { name: "文档", createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z" },
    pageOrder: ["page:1"],
    pages: { "page:1": { id: "page:1", name: "Page 1", childIds: ["frame:a"] } },
    nodes: { "frame:a": { ...parent, childIds: ["frame:b"] }, "frame:b": child },
    components: {},
    tokens: {},
    assets: {},
  };
}
