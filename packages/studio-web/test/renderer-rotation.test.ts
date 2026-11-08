import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { hitTest } from "../src/renderer/hit-test";
import { buildScene } from "../src/renderer/scene";

function rectangle(id: string, rotation?: number): DesignNode {
  return {
    id,
    type: "rectangle",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 50, rotation },
    appearance: defaultAppearance(),
  };
}

function documentWith(node: DesignNode): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

const boxes = { node: { x: 0, y: 0, width: 100, height: 50 } };

test("rotation is carried into the scene", () => {
  const scene = buildScene(documentWith(rectangle("node", 30)), "page:1", boxes);
  assert.equal(scene[0]?.rotation, 30);
  assert.equal(buildScene(documentWith(rectangle("node")), "page:1", boxes)[0]?.rotation, undefined);
});

test("hit testing follows the rotated shape", () => {
  const scene = buildScene(documentWith(rectangle("node", 90)), "page:1", boxes);
  // 转 90° 后盒子占 x∈[25,75]、y∈[-25,75]：中心仍在，原来的左下角已经不在图形上。
  assert.equal(hitTest(scene, { x: 50, y: 25 }), "node");
  assert.equal(hitTest(scene, { x: 10, y: 10 }), undefined);
  assert.equal(hitTest(scene, { x: 50, y: 70 }), "node");
});

test("a rotated parent carries its children in the same frame", () => {
  const parent: DesignNode = {
    ...rectangle("parent", 90),
    layout: { ...defaultLayout(), x: 0, y: 0, width: 100, height: 100, rotation: 90 },
    childIds: ["child"],
  };
  const child: DesignNode = {
    ...rectangle("child"),
    parentId: "parent",
    layout: { ...defaultLayout(), x: 0, y: 0, width: 20, height: 20 },
  };
  const document = createDocument("doc:1", "Demo");
  document.nodes = { parent, child };
  document.pages["page:1"]!.childIds = ["parent"];
  const scene = buildScene(document, "page:1", { parent: { x: 0, y: 0, width: 100, height: 100 }, child: { x: 0, y: 0, width: 20, height: 20 } });
  // 子节点在父的本地坐标系左上角；转 90° 后跑到右上角（x≈80..100）。
  assert.equal(hitTest(scene, { x: 90, y: 10 }), "child");
  // 同一个点在父的本地坐标里是 (10, 90)，落在父身上、但不在子节点上。
  assert.equal(hitTest(scene, { x: 10, y: 10 }), "parent");
});
