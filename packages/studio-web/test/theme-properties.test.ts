import assert from "node:assert/strict";
import test from "node:test";
import { describePropertyOverride, parsePropertyOverride } from "../src/theme-properties";

/** 主题属性覆盖的表单解析：空字段不覆盖，数值不合法要报错。 */

test("属性覆盖表单：空字段表示不覆盖，不是 0", () => {
  const parsed = parsePropertyOverride({ name: "Card", type: "", cornerRadius: "", gap: "", padding: "", fontSize: "", opacity: "" });
  assert.deepEqual(parsed.override, {});
  assert.equal(parsed.error, undefined);
});

test("属性覆盖表单：填了的字段进覆盖里", () => {
  const parsed = parsePropertyOverride({ name: "Card", type: "frame", cornerRadius: "16", gap: "8", padding: "", fontSize: "", opacity: "0.5" });
  assert.deepEqual(parsed.override, { type: "frame", cornerRadius: 16, gap: 8, opacity: 0.5 });
});

test("属性覆盖表单：opacity 为 0 是合法值（完全透明）", () => {
  const parsed = parsePropertyOverride({ name: "Card", type: "", cornerRadius: "", gap: "", padding: "", fontSize: "", opacity: "0" });
  assert.equal(parsed.override?.opacity, 0);
});

test("属性覆盖表单：不认识的节点类型报错", () => {
  const parsed = parsePropertyOverride({ name: "Card", type: "div", cornerRadius: "", gap: "", padding: "", fontSize: "", opacity: "" });
  assert.match(parsed.error ?? "", /节点类型/);
});

test("属性覆盖表单：数字字段填了非数字报错", () => {
  const parsed = parsePropertyOverride({ name: "Card", type: "", cornerRadius: "abc", gap: "", padding: "", fontSize: "", opacity: "" });
  assert.match(parsed.error ?? "", /数字/);
});

test("属性覆盖表单：圆角不能是负数，字号要大于 0", () => {
  assert.match(parsePropertyOverride({ name: "Card", type: "", cornerRadius: "-4", gap: "", padding: "", fontSize: "", opacity: "" }).error ?? "", /负数/);
  assert.match(parsePropertyOverride({ name: "Card", type: "", cornerRadius: "", gap: "", padding: "", fontSize: "0", opacity: "" }).error ?? "", /字号/);
});

test("属性覆盖表单：不透明度要落在 0–1 之间", () => {
  assert.match(parsePropertyOverride({ name: "Card", type: "", cornerRadius: "", gap: "", padding: "", fontSize: "", opacity: "1.5" }).error ?? "", /0–1/);
});

test("属性覆盖摘要：把覆盖的字段拼成一行可读文字", () => {
  assert.equal(describePropertyOverride({ type: "frame", cornerRadius: 16, gap: 8 }), "类型 frame · 圆角 16 · 间距 8");
  assert.equal(describePropertyOverride({}), "");
});
