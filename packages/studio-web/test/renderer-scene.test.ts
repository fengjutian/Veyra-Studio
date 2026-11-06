import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type DesignNode } from "@ufira/design-schema";
import { buildScene } from "../src/renderer/scene";
import { wrapText } from "../src/renderer/canvas-renderer";

function node(id: string, parentId: string, type: DesignNode["type"], extra: Record<string, unknown> = {}): DesignNode {
  return {
    id,
    type,
    name: id,
    parentId,
    childIds: [],
    visible: true,
    locked: false,
    layout: { ...defaultLayout(), x: 10, y: 20, width: 100, height: 40 },
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

function documentWith(nodes: DesignNode[], tokens: DesignDocument["tokens"] = {}): DesignDocument {
  const document = createDocument("doc:1", "Demo", "page:1");
  document.nodes = Object.fromEntries(nodes.map(item => [item.id, item]));
  document.pages["page:1"]!.childIds = nodes.filter(item => item.parentId === "page:1").map(item => item.id);
  document.tokens = tokens;
  return document;
}

const boxes = {
  card: { x: 0, y: 0, width: 300, height: 200 },
  title: { x: 12, y: 12, width: 200, height: 20 },
};

test("builds a depth-first scene and skips hidden subtrees", () => {
  const card = node("card", "page:1", "frame");
  const title = node("title", "card", "text", { text: "标题", fontFamily: "Inter", fontSize: 16, lineHeight: 24 });
  const hidden = node("hidden", "card", "rectangle", { visible: false });
  card.childIds = ["title", "hidden"];
  const document = documentWith([card, title, hidden]);

  const scene = buildScene(document, "page:1", boxes);
  assert.equal(scene.length, 1);
  assert.equal(scene[0]?.id, "card");
  assert.equal(scene[0]?.clip, true);
  assert.deepEqual(scene[0]?.children.map(child => child.id), ["title"]);
});

test("resolves token fills and radii before handing them to the renderer", () => {
  const card = node("card", "page:1", "frame", { bindings: { fill: "color.surface", radius: "radius.card" } });
  const document = documentWith([card], {
    "color.surface": { type: "color", value: "#f8fafc" },
    "radius.card": { type: "number", value: 16 },
  });
  const scene = buildScene(document, "page:1", boxes);
  assert.equal(scene[0]?.fill, "#f8fafc");
  assert.equal(scene[0]?.radius, 16);
});

test("text nodes carry wrapping and alignment information", () => {
  const label = node("label", "page:1", "text", {
    text: "设计系统文本",
    fontFamily: "Inter",
    fontSize: 18,
    lineHeight: 26,
    fontWeight: 700,
    textAlign: "center",
    appearance: { ...defaultAppearance(), fill: "#334155", opacity: 0.8 },
  });
  const scene = buildScene(documentWith([label]), "page:1", {});
  assert.deepEqual(scene[0]?.box, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(scene[0]?.text?.color, "#334155");
  assert.equal(scene[0]?.text?.align, "center");
  assert.equal(scene[0]?.text?.fontWeight, 700);
  assert.equal(scene[0]?.opacity, 0.8);
  // 文本节点没有背景填充，避免把整块矩形涂黑。
  assert.equal(scene[0]?.fill, "#334155");
});

test("image nodes normalise fit and keep the asset id", () => {
  const image = node("image", "page:1", "image", { assetId: "asset:1", fit: "contain" });
  const scene = buildScene(documentWith([image]), "page:1", {});
  assert.deepEqual(scene[0]?.image, { assetId: "asset:1", fit: "contain" });
  const badFit = node("image2", "page:1", "image", { assetId: "asset:2", fit: "stretch" });
  const scene2 = buildScene(documentWith([badFit]), "page:1", {});
  assert.deepEqual(scene2[0]?.image, { assetId: "asset:2", fit: "cover" });
});

test("rectangles are leaves that do not clip", () => {
  const rect = node("rect", "page:1", "rectangle");
  const scene = buildScene(documentWith([rect]), "page:1", {});
  assert.equal(scene[0]?.clip, false);
  assert.deepEqual(scene[0]?.children, []);
});

test("wrapText breaks on explicit newlines and measures per character", () => {
  const context = { measureText: (value: string) => ({ width: value.length * 10 }) } as unknown as CanvasRenderingContext2D;
  assert.deepEqual(wrapText(context, "ab\ncd", 100), ["ab", "cd"]);
  assert.deepEqual(wrapText(context, "abcdef", 30), ["abc", "def"]);
  // 单个字符就超宽时仍然输出，避免死循环。
  assert.deepEqual(wrapText(context, "ab", 5), ["a", "b"]);
});
