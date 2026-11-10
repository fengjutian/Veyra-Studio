import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, validateDocument, type DesignDocument } from "../src/index";

/**
 * 分组元数据：只影响面板显示，不影响解析与导出。
 *
 * 关键在于它必须能**活着通过 schema**：zod 会剥掉未声明的字段，一旦漏登记，
 * 这份元数据会在校验时被悄悄丢掉（面板上改了名，保存回来就没了）。
 */

function documentWithGroups(): DesignDocument {
  const document = createDocument("doc:groups", "Groups");
  document.tokenGroups = [
    { id: "color.text", label: "文字色", description: "正文与标题", order: 1 },
    { id: "space" },
  ];
  return document;
}

test("分组元数据：能通过文档校验，且字段不会被剥掉", () => {
  const document = documentWithGroups();
  const parsed = validateDocument(document);
  assert.deepEqual(parsed.tokenGroups, document.tokenGroups);
});

test("分组元数据：没有 label / description / order 也是合法的", () => {
  const document = createDocument("doc:groups", "Groups");
  document.tokenGroups = [{ id: "space" }];
  assert.deepEqual(validateDocument(document).tokenGroups, [{ id: "space" }]);
});

test("分组元数据：顺序不是有限数字时校验不通过", () => {
  const document = documentWithGroups();
  document.tokenGroups = [{ id: "space", order: Number.POSITIVE_INFINITY }];
  assert.throws(() => validateDocument(document));
});
