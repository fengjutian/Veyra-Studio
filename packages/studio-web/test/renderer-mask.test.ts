import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { hitTest } from "../src/renderer/hit-test";
import { buildScene } from "../src/renderer/scene";

function shape(id: string, type: DesignNode["type"], x: number, y: number, width: number, height: number, extra: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type,
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x, y, width, height },
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

function documentWith(nodes: DesignNode[]): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.pages["page:1"]!.childIds = nodes.map(node => node.id);
  for (const node of nodes) document.nodes[node.id] = node;
  return document;
}

const boxes = {
  circle: { x: 0, y: 0, width: 100, height: 100 },
  photo: { x: 0, y: 0, width: 200, height: 100 },
};

test("a mask clips the siblings above it, not itself", () => {
  const document = documentWith([
    shape("circle", "ellipse", 0, 0, 100, 100, { mask: true }),
    shape("photo", "rectangle", 0, 0, 200, 100),
  ]);
  const scene = buildScene(document, "page:1", boxes);
  assert.equal(scene[0]?.mask, true);
  assert.equal(scene[0]?.maskedBy, undefined, "蒙版自身不该被遮罩");
  assert.deepEqual(scene[1]?.maskedBy?.map(node => node.id), ["circle"]);
});

test("siblings below the mask are not clipped", () => {
  const document = documentWith([
    shape("bottom", "rectangle", 0, 0, 200, 100),
    shape("circle", "ellipse", 0, 0, 100, 100, { mask: true }),
    shape("top", "rectangle", 0, 0, 200, 100),
  ]);
  const scene = buildScene(document, "page:1", boxes);
  assert.equal(scene[0]?.maskedBy, undefined);
  assert.deepEqual(scene[2]?.maskedBy?.map(node => node.id), ["circle"]);
});

test("nested masks accumulate", () => {
  const document = documentWith([
    shape("outer", "rectangle", 0, 0, 200, 100, { mask: true }),
    shape("inner", "ellipse", 0, 0, 100, 100, { mask: true }),
    shape("photo", "rectangle", 0, 0, 200, 100),
  ]);
  const scene = buildScene(document, "page:1", boxes);
  assert.deepEqual(scene[2]?.maskedBy?.map(node => node.id), ["outer", "inner"]);
});

test("the masked-away part of a node cannot be clicked", () => {
  const document = documentWith([
    shape("circle", "ellipse", 0, 0, 100, 100, { mask: true }),
    shape("photo", "rectangle", 0, 0, 200, 100),
  ]);
  const scene = buildScene(document, "page:1", boxes);
  // 圆内命中照片。
  assert.equal(hitTest(scene, { x: 50, y: 50 }), "photo");
  // 圆外（照片右半边）视觉上被裁掉，不该再命中。
  assert.equal(hitTest(scene, { x: 180, y: 50 }), undefined);
});

test("the mask node itself is not clickable on canvas", () => {
  const document = documentWith([
    shape("circle", "ellipse", 0, 0, 100, 100, { mask: true }),
    shape("photo", "rectangle", 0, 0, 200, 100),
  ]);
  const scene = buildScene(document, "page:1", boxes);
  // 只有照片命中，蒙版不参与命中（它可以在图层树里选中）。
  assert.equal(hitTest(scene, { x: 50, y: 50 }), "photo");
});
