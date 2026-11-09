import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, type DesignDocument, type TextNode } from "@ufira/design-schema";
import { computePageLayout } from "../src/index";

/**
 * 字体 token 对布局的影响。
 *
 * 文本测量读的是节点字段；token 必须在测量**之前**生效，否则 hug 宽高会按
 * 节点自身的字号算，画布上的字和布局盒对不上。
 */

function documentWith(bindToken: boolean): DesignDocument {
  const document = createDocument("doc:typo", "Typography");
  document.tokens = {
    "text.display": { type: "typography", value: { fontFamily: "Inter", fontSize: 40, lineHeight: 48 } },
  };
  const node: TextNode = {
    id: "text:1",
    type: "text",
    name: "Display",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: {
      ...defaultLayout(),
      widthMode: "hug",
      heightMode: "hug",
    },
    appearance: defaultAppearance(),
    text: "Hello world",
    fontFamily: "Inter",
    fontSize: 12,
    lineHeight: 16,
    ...(bindToken ? { bindings: { typography: "text.display" } } : {}),
  };
  document.nodes[node.id] = node;
  document.pages["page:1"]!.childIds = [node.id];
  return document;
}

test("typography token: hug 宽高按 token 的字号测量", () => {
  const plain = computePageLayout(documentWith(false), "page:1", { viewport: { width: 800, height: 600 } });
  const bound = computePageLayout(documentWith(true), "page:1", { viewport: { width: 800, height: 600 } });

  const plainBox = plain.boxes["text:1"]!;
  const boundBox = bound.boxes["text:1"]!;
  // 40px 的字明显比 12px 占更宽、更高。
  assert.ok(boundBox.width > plainBox.width, `${boundBox.width} 应大于 ${plainBox.width}`);
  assert.ok(boundBox.height > plainBox.height, `${boundBox.height} 应大于 ${plainBox.height}`);
  // 行高来自 token（48），单行文本的 hug 高度就是行高。
  assert.equal(boundBox.height, 48);
});

test("typography token: 固定尺寸的文本节点只有字号影响测量，不影响盒子", () => {
  const document = documentWith(true);
  document.nodes["text:1"]!.layout = { ...defaultLayout(), width: 200, height: 30 };
  const result = computePageLayout(document, "page:1", { viewport: { width: 800, height: 600 } });
  assert.deepEqual(result.boxes["text:1"], { x: 0, y: 0, width: 200, height: 30 });
});
