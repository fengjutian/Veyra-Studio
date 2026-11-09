import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  validateDocument,
  type GridTrack,
} from "../src/index";

/**
 * 自动重复轨道（`repeat(auto-fill|auto-fit, minmax(min, 1fr))`）的文档校验。
 *
 * 展开规则在 `design-layout` 里测（`grid.test.ts`），这里只守 schema 边界：
 * 最小值必须为正、模式必须是两个合法值、旧文档不受影响。
 */

function documentWithColumns(columns: GridTrack[]) {
  const document = createDocument("doc:repeat", "Repeat");
  document.nodes.root = {
    id: "root",
    type: "frame",
    name: "root",
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: {
      ...defaultLayout(),
      mode: "grid",
      grid: { columns, rows: [{ type: "fixed", size: 50 }], columnGap: 0, rowGap: 0 },
    },
    appearance: defaultAppearance(),
  };
  document.pages["page:1"]!.childIds = ["root"];
  return document;
}

test("repeat: 合法声明通过文档校验", () => {
  const document = documentWithColumns([{ type: "repeat", mode: "auto-fill", min: 120, grow: true }]);
  assert.deepEqual(validateDocument(document), document);
});

test("repeat: 最小宽度必须为正（0 会让条数发散）", () => {
  const document = documentWithColumns([{ type: "repeat", mode: "auto-fill", min: 0 }]);
  assert.throws(() => validateDocument(document), /layout\.grid\.columns\.0\.min/);
});

test("repeat: 模式只能是 auto-fill / auto-fit", () => {
  const document = documentWithColumns([
    { type: "repeat", mode: "auto" as unknown as "auto-fill", min: 80 },
  ]);
  assert.throws(() => validateDocument(document), /layout\.grid\.columns\.0\.mode/);
});

test("repeat: grow 可省略，缺省表示固定最小宽度", () => {
  const document = documentWithColumns([{ type: "repeat", mode: "auto-fit", min: 80 }]);
  assert.deepEqual(validateDocument(document), document);
});

test("repeat: 旧文档（五种轨道）校验结果不变", () => {
  const document = documentWithColumns([
    { type: "fixed", size: 100 },
    { type: "fraction", weight: 1 },
    { type: "auto" },
    { type: "min-content" },
    { type: "max-content" },
  ]);
  assert.deepEqual(validateDocument(document), document);
});
