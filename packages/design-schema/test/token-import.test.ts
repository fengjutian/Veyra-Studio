import assert from "node:assert/strict";
import test from "node:test";
import {
  inferTokenType,
  looksLikeColor,
  parseStyleTokens,
  proposalToToken,
  stripStyleComments,
} from "../src/token-import";

/**
 * 从样式表导入 token。
 *
 * 规格见 `docs/token-system.md`。要证明的是**判定纪律**：不猜单位换算、
 * 不猜颜色关键字、别名照搬、插值跳过、注释不误读。
 */

test("去掉注释：块注释与 SCSS 行注释都不算声明", () => {
  const css = `
    /* --ghost: #fff; */
    :root {
      --real: #111; // --inline: #222;
    }
  `;
  const result = parseStyleTokens(css);
  assert.deepEqual(result.tokens.map(token => token.name), ["real"]);
  assert.equal(stripStyleComments(css).includes("--ghost"), false);
});

test("解析 CSS 自定义属性：颜色、数字与普通字符串", () => {
  const result = parseStyleTokens(`
    :root {
      --color-brand: #6366f1;
      --color-muted: rgb(148 163 184);
      --space-md: 16px;
      --line-height: 1.5;
      --font-family: Inter, sans-serif;
    }
  `);
  assert.equal(result.tokens.length, 5);
  const byName = new Map(result.tokens.map(token => [token.name, token]));
  assert.deepEqual(byName.get("color-brand"), { name: "color-brand", type: "color", value: "#6366f1", source: "--color-brand", conflicts: undefined });
  assert.equal(byName.get("color-muted")?.type, "color");
  assert.equal(byName.get("space-md")?.type, "number");
  assert.equal(byName.get("space-md")?.value, 16);
  assert.equal(byName.get("line-height")?.value, 1.5);
  assert.equal(byName.get("font-family")?.type, "string");
  assert.equal(byName.get("font-family")?.value, "Inter, sans-serif");
});

test("解析 SCSS 变量，名字去掉 $", () => {
  const result = parseStyleTokens("$space-md: 16px;\n$color-brand: #fff;");
  assert.deepEqual(result.tokens.map(token => token.name), ["space-md", "color-brand"]);
  assert.equal(result.tokens[0]?.source, "$space-md");
  assert.equal(result.tokens[0]?.value, 16);
});

test("不猜单位：rem / em / % 保留成字符串并给出警告", () => {
  const result = parseStyleTokens(":root { --space-lg: 1.5rem; --ratio: 50%; }");
  assert.equal(result.tokens[0]?.type, "string");
  assert.equal(result.tokens[0]?.value, "1.5rem");
  assert.equal(result.tokens[1]?.type, "string");
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0]!, /带单位/);
});

test("别名照搬：var(--x) 变成指向 x 的 alias", () => {
  const result = parseStyleTokens(":root { --text-primary: var(--gray-900); }");
  assert.equal(result.tokens[0]?.type, "alias");
  assert.equal(result.tokens[0]?.value, "gray-900");
  assert.deepEqual(proposalToToken(result.tokens[0]!), { type: "alias", value: "gray-900" });
});

test("SCSS 插值跳过并说明原因", () => {
  const result = parseStyleTokens("$color-brand: #{$brand};");
  assert.equal(result.tokens.length, 0);
  assert.match(result.warnings[0]!, /插值/);
});

test("同名变量只保留第一次，并提示重复", () => {
  const result = parseStyleTokens(":root { --x: #fff; --x: #000; }");
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0]?.value, "#fff");
  assert.match(result.warnings[0]!, /重复/);
});

test("标出会覆盖的同名 token", () => {
  const result = parseStyleTokens(":root { --color-brand: #6366f1; }", {
    existing: { "color-brand": { type: "color", value: "#ff0000" } },
  });
  assert.equal(result.tokens[0]?.conflicts, true);
});

test("没有变量时给出提示而不是静默返回空", () => {
  const result = parseStyleTokens(".foo { color: red; }");
  assert.equal(result.tokens.length, 0);
  assert.match(result.warnings[0]!, /没有解析出任何变量/);
});

test("颜色判定只认基础色名、十六进制与颜色函数", () => {
  assert.equal(looksLikeColor("#fff"), true);
  assert.equal(looksLikeColor("#6366f1"), true);
  assert.equal(looksLikeColor("rgb(1 2 3)"), true);
  assert.equal(looksLikeColor("hsl(210 40% 50%)"), true);
  assert.equal(looksLikeColor("red"), true);
  assert.equal(looksLikeColor("transparent"), true);
  // 不是颜色：关键字猜错会让 token 绑不上任何东西。
  assert.equal(looksLikeColor("bold"), false);
  assert.equal(looksLikeColor("background"), false);
  assert.equal(looksLikeColor("#ff"), false);
});

test("类型推断", () => {
  assert.equal(inferTokenType("#6366f1"), "color");
  assert.equal(inferTokenType("16"), "number");
  assert.equal(inferTokenType("16px"), "number");
  assert.equal(inferTokenType("var(--other)"), "alias");
  assert.equal(inferTokenType("1.5rem"), "string");
});

test("提案转成文档里的 token 值", () => {
  assert.deepEqual(proposalToToken({ name: "a", type: "number", value: 16, source: "--a" }), { type: "number", value: 16 });
  assert.deepEqual(proposalToToken({ name: "b", type: "color", value: "#fff", source: "--b" }), { type: "color", value: "#fff" });
  assert.deepEqual(proposalToToken({ name: "c", type: "string", value: "Inter", source: "--c" }), { type: "string", value: "Inter" });
});
