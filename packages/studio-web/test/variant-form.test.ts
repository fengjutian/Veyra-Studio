import assert from "node:assert/strict";
import test from "node:test";
import {
  currentValuesFromForm,
  nextValuesFromForm,
  parseVariantProperties,
  validateVariantForm,
  variantCurrentFields,
  variantNextFields,
} from "../src/variant-form";

test("parses comma separated properties, including full-width commas", () => {
  assert.deepEqual(parseVariantProperties("state"), { properties: ["state"] });
  assert.deepEqual(parseVariantProperties(" state, size "), { properties: ["state", "size"] });
  assert.deepEqual(parseVariantProperties("state，size"), { properties: ["state", "size"] });
  assert.match(parseVariantProperties("  ").error ?? "", /至少/);
  assert.match(parseVariantProperties("state,state").error ?? "", /重复/);
  assert.match(parseVariantProperties("1state").error ?? "", /字母/);
});

test("builds one next-value field per property and shows the current value", () => {
  const fields = variantNextFields(["state", "size"], { state: "default", size: "md" });
  assert.deepEqual(fields.map(field => field.key), ["next:state", "next:size"]);
  assert.match(fields[0]!.label, /state 的新值（当前 default）/);
  assert.match(fields[1]!.label, /size 的新值（当前 md）/);

  const current = variantCurrentFields(["state", "size"]);
  assert.deepEqual(current.map(field => [field.key, field.defaultValue]), [["current:state", "default"], ["current:size", "default"]]);
});

test("collects current and next values back out of the form", () => {
  const values = { "current:state": "default", "current:size": "md", "next:state": "hover", "next:size": "lg" };
  assert.deepEqual(currentValuesFromForm(["state", "size"], values), { state: "default", size: "md" });
  assert.deepEqual(nextValuesFromForm(["state", "size"], values), { state: "hover", size: "lg" });
});

test("validates empty, illegal and unchanged values", () => {
  const properties = ["state", "size"];
  const base = { "current:state": "default", "current:size": "md", "next:state": "hover", "next:size": "lg" };
  assert.equal(validateVariantForm(properties, base, { includeCurrent: true }), undefined);

  assert.match(validateVariantForm(properties, { ...base, "next:size": " " }, { includeCurrent: true }) ?? "", /size 的新值不能为空/);
  assert.match(validateVariantForm(properties, { ...base, "next:size": "a b" }, { includeCurrent: true }) ?? "", /字符|只能/);
  assert.match(validateVariantForm(properties, { ...base, "next:state": "default", "next:size": "md" }, { includeCurrent: true }) ?? "", /完全相同/);
  // 已有变体集时没有 current 字段，不会误判"和当前相同"。
  assert.equal(validateVariantForm(properties, { "next:state": "default", "next:size": "md" }, { includeCurrent: false }), undefined);
});

test("chinese state names are allowed", () => {
  assert.equal(validateVariantForm(["state"], { "next:state": "悬停" }, { includeCurrent: false }), undefined);
});
