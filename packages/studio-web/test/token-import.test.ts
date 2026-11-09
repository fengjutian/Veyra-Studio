import assert from "node:assert/strict";
import test from "node:test";
import { createDocument, resolveTokenTarget, tokenColor, tokenNumber, type TokenValue } from "@ufira/design-schema";
import { DesignRuntime } from "@ufira/design-runtime";
import { parseStyleTokens, proposalToToken } from "@ufira/design-schema";

/**
 * 从样式表导入 token 的端到端路径。
 *
 * 解析器在 `design-schema` 里已经单测过；这里要证明的是**拼起来能用**：
 * 样式表文本 → 提案 → `token.upsert` 命令 → 文档 → 绑定解析（含别名链）。
 */

function importFrom(css: string, existing: Record<string, TokenValue> = {}): { runtime: DesignRuntime; imported: number } {
  const parsed = parseStyleTokens(css, { existing });
  const commands = parsed.tokens.map(token => ({
    type: "token.upsert" as const,
    payload: { name: token.name, token: proposalToToken(token) },
  }));
  const runtime = new DesignRuntime(createDocument("doc:1", "导入"));
  runtime.execute({
    commandId: "cmd:1",
    documentId: "doc:1",
    baseRevision: 0,
    actor: { type: "human", id: "user:1" },
    commands,
  });
  return { runtime, imported: parsed.tokens.length };
}

test("导入的 token 进文档并能被绑定解析", () => {
  const { runtime } = importFrom(`
    :root {
      --color-brand: #6366f1;
      --space-md: 16px;
    }
  `);
  const document = runtime.snapshot();
  assert.equal(document.tokens["color-brand"]?.type, "color");
  assert.equal(tokenColor(document, "color-brand"), "#6366f1");
  assert.equal(tokenNumber(document, "space-md"), 16);
});

test("导入的别名能沿链解析到最终值", () => {
  const { runtime } = importFrom(`
    :root {
      --gray-900: #111111;
      --text-primary: var(--gray-900);
    }
  `);
  const document = runtime.snapshot();
  assert.equal(document.tokens["text-primary"]?.type, "alias");
  // 别名指向的 token 也在同一批导入里，因此能解析到最终颜色。
  assert.equal(tokenColor(document, "text-primary"), "#111111");
  assert.equal(resolveTokenTarget(document, "text-primary")?.name, "gray-900");
});

test("导入可以覆盖同名 token（确认表会先标出来）", () => {
  const parsed = parseStyleTokens(":root { --color-brand: #00ff00; }", {
    existing: { "color-brand": { type: "color", value: "#ff0000" } },
  });
  assert.equal(parsed.tokens[0]?.conflicts, true);
  const { runtime } = importFrom(":root { --color-brand: #00ff00; }", { "color-brand": { type: "color", value: "#ff0000" } });
  assert.equal(tokenColor(runtime.snapshot(), "color-brand"), "#00ff00");
});
