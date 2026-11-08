import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument } from "@ufira/design-schema";
import { buildTranslatedScene, translateScene } from "../src/prototype/scene-build";
import type { SceneNode } from "../src/renderer/scene";

function documentWithScreen(): DesignDocument {
  const document = createDocument("doc:preview", "Preview", "page:1");
  document.nodes["screen"] = {
    id: "screen", type: "frame", name: "screen", parentId: "page:1", childIds: ["child"],
    visible: true, locked: false, layout: { ...defaultLayout(), x: 100, y: 50, width: 300, height: 200 }, appearance: defaultAppearance(),
  };
  document.nodes["child"] = {
    id: "child", type: "frame", name: "child", parentId: "screen", childIds: [],
    visible: true, locked: false, layout: { ...defaultLayout(), x: 110, y: 60, width: 50, height: 20 }, appearance: defaultAppearance(),
  };
  document.pages["page:1"]!.childIds = ["screen"];
  return document;
}

const boxes = {
  screen: { x: 100, y: 50, width: 300, height: 200 },
  child: { x: 110, y: 60, width: 50, height: 20 },
};

test("translation puts an arbitrary subtree at the origin without touching layout", () => {
  const scene = buildTranslatedScene(documentWithScreen(), "screen", boxes, -100, -50);
  assert.ok(scene);
  assert.deepEqual(scene.box, { x: 0, y: 0, width: 300, height: 200 });
  assert.deepEqual(scene.children[0]!.box, { x: 10, y: 10, width: 50, height: 20 });
});

test("translation carries mask boxes so masked regions stay in sync", () => {
  const mask: SceneNode = {
    id: "mask", type: "vector", box: { x: 5, y: 5, width: 40, height: 40 },
    clip: false, opacity: 1, strokeWidth: 0, radius: 0, children: [],
  };
  const node: SceneNode = {
    id: "node", type: "frame", box: { x: 10, y: 10, width: 100, height: 100 },
    clip: false, opacity: 1, strokeWidth: 0, radius: 0, children: [], maskedBy: [mask],
  };
  const moved = translateScene(node, 7, -3);
  assert.deepEqual(moved.box, { x: 17, y: 7, width: 100, height: 100 });
  assert.deepEqual(moved.maskedBy?.[0]?.box, { x: 12, y: 2, width: 40, height: 40 });
});

test("a missing root returns undefined; a missing box falls back to the declared layout", () => {
  assert.equal(buildTranslatedScene(documentWithScreen(), "missing", boxes, 0, 0), undefined);
  const fallback = buildTranslatedScene(documentWithScreen(), "screen", {}, -100, -50);
  assert.deepEqual(fallback?.box, { x: 0, y: 0, width: 300, height: 200 });
});
