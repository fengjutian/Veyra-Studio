import assert from "node:assert/strict";
import test from "node:test";
import { parseTypographyForm } from "../src/typography-form";

/** 字体 token 表单的解析与校验（规则与 schema 保持一致）。 */

test("typography-form: 完整表单解析成字体值", () => {
  const result = parseTypographyForm({
    fontFamily: "Source Serif",
    fontSize: "32",
    lineHeight: "40",
    fontWeight: "700",
    letterSpacing: "-0.5",
    fontStyle: "italic",
  });
  assert.deepEqual(result, {
    ok: true,
    value: { fontFamily: "Source Serif", fontSize: 32, lineHeight: 40, fontWeight: 700, letterSpacing: -0.5, fontStyle: "italic" },
  });
});

test("typography-form: 省略的字段不写进值（不覆盖节点）", () => {
  const result = parseTypographyForm({ fontFamily: "Inter", fontSize: "14" });
  assert.deepEqual(result, { ok: true, value: { fontFamily: "Inter", fontSize: 14 } });
});

test("typography-form: 族名为空、字号非正、字重越界都报错", () => {
  assert.deepEqual(parseTypographyForm({ fontFamily: "  ", fontSize: "14" }), { ok: false, error: "字体族名不能为空" });
  assert.deepEqual(parseTypographyForm({ fontFamily: "Inter", fontSize: "0" }), { ok: false, error: "字号必须是正数" });
  assert.deepEqual(parseTypographyForm({ fontFamily: "Inter", fontSize: "abc" }), { ok: false, error: "字号必须是正数" });
  assert.deepEqual(parseTypographyForm({ fontFamily: "Inter", fontSize: "14", fontWeight: "50" }), { ok: false, error: "字重必须是 100–900 的整数" });
  assert.deepEqual(parseTypographyForm({ fontFamily: "Inter", fontSize: "14", fontWeight: "950" }), { ok: false, error: "字重必须是 100–900 的整数" });
  // 可变字体允许非整百字重（CSS `font-weight` 支持任意 1–1000），450 合法。
  assert.equal(parseTypographyForm({ fontFamily: "Inter", fontSize: "14", fontWeight: "450" }).ok, true);
});

test("typography-form: 行高为 0 合法，负数不合法；未知字形被忽略", () => {
  assert.deepEqual(parseTypographyForm({ fontFamily: "Inter", fontSize: "14", lineHeight: "0" }), { ok: true, value: { fontFamily: "Inter", fontSize: 14, lineHeight: 0 } });
  assert.equal(parseTypographyForm({ fontFamily: "Inter", fontSize: "14", lineHeight: "-1" }).ok, false);
  assert.deepEqual(parseTypographyForm({ fontFamily: "Inter", fontSize: "14", fontStyle: "slant" }), { ok: true, value: { fontFamily: "Inter", fontSize: 14 } });
});
