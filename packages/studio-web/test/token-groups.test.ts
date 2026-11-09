import assert from "node:assert/strict";
import test from "node:test";
import type { TokenValue } from "@ufira/design-schema";
import { effectiveTokenType, groupTokens, tokenGroupOf, UNGROUPED_LABEL } from "../src/token-groups";

/** Token 分组（名字前缀的视图）与别名类型的解析。 */

const color: TokenValue = { type: "color", value: "#111111" };
const number: TokenValue = { type: "number", value: 16 };

test("分组：按最后一个点号切前缀", () => {
  assert.equal(tokenGroupOf("color.text.primary"), "color.text");
  assert.equal(tokenGroupOf("color"), "");
  assert.equal(tokenGroupOf(".leading"), "");
});

test("分组：组按名字排序，未分组排最后", () => {
  const groups = groupTokens({
    "z.group.one": color,
    primary: color,
    "a.group.two": number,
    "a.group.one": color,
  });
  assert.deepEqual(groups.map(group => group.label), ["a.group", "z.group", UNGROUPED_LABEL]);
  assert.deepEqual(groups[0]?.entries.map(([name]) => name), ["a.group.one", "a.group.two"]);
  assert.deepEqual(groups[2]?.entries.map(([name]) => name), ["primary"]);
});

test("分组：空 token 表返回空数组", () => {
  assert.deepEqual(groupTokens({}), []);
});

test("别名：最终类型沿链解析", () => {
  const tokens: Record<string, TokenValue> = {
    base: color,
    alias: { type: "alias", value: "base" },
    nested: { type: "alias", value: "alias" },
    broken: { type: "alias", value: "missing" },
  };
  assert.equal(effectiveTokenType(tokens, "base"), "color");
  assert.equal(effectiveTokenType(tokens, "nested"), "color");
  assert.equal(effectiveTokenType(tokens, "broken"), undefined);
  assert.equal(effectiveTokenType(tokens, "unknown"), undefined);
});

test("别名：环不会让解析卡死", () => {
  const tokens: Record<string, TokenValue> = {
    a: { type: "alias", value: "b" },
    b: { type: "alias", value: "a" },
  };
  assert.equal(effectiveTokenType(tokens, "a"), undefined);
});
