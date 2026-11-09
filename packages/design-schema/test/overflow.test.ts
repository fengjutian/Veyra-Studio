import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, defaultAppearance, defaultLayout, validateDocument, type DesignDocument, type DesignNode } from "../src/index";

/**
 * 溢出模式（`overflow`）的用例。
 *
 * 语义见 `docs/prototype-runtime.md` §8：
 * - `hidden` 裁切不滚动（**缺省**，旧文档行为不变）；
 * - `scroll` 内容超出盒子时可滚；
 * - `visible` 不裁切。
 *
 * 字段是可选的，所以**不升 schema 版本**；只有容器型节点能带这个字段。
 */

/** 造一份只有一个节点的文档。 */
function documentWith(node: DesignNode): DesignDocument {
  const document = createDocument("doc:1", "Demo");
  document.nodes[node.id] = node;
  document.pages["page:1"].childIds.push(node.id);
  return document;
}

function frame(id: string, extra: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...extra,
  } as DesignNode;
}

test("缺省不写 overflow 的 frame 仍然合法（旧文档不迁移）", () => {
  const document = documentWith(frame("node:1"));
  assert.deepEqual(validateDocument(document), document);
  assert.equal(document.nodes["node:1"].overflow, undefined);
});

test("容器可以带三种溢出模式", () => {
  for (const overflow of ["visible", "hidden", "scroll"] as const) {
    const document = documentWith(frame("node:1", { overflow }));
    assert.deepEqual(validateDocument(document), document);
    assert.equal(document.nodes["node:1"].overflow, overflow);
  }
});

test("非容器节点不能带溢出模式", () => {
  const document = documentWith(
    frame("node:1", { type: "rectangle", overflow: "scroll" } as Partial<DesignNode>),
  );
  assert.throws(() => validateDocument(document), /cannot have an overflow mode/);
});

test("非法取值被 schema 拒绝", () => {
  const document = documentWith(frame("node:1", { overflow: "auto" } as unknown as Partial<DesignNode>));
  assert.throws(() => validateDocument(document));
});

test("overflow 不会被 zod 剥掉（可选字段要真的存得住）", () => {
  const document = documentWith(frame("node:1", { overflow: "scroll" }));
  const parsed = validateDocument(document);
  assert.equal(parsed.nodes["node:1"].overflow, "scroll");
});
