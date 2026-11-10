import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * 浏览器入口的护栏：`src/index.ts` 的依赖图里不能出现 node 内置模块。
 *
 * 回归背景：`mcp-store.ts` 顶层 `import ... from "node:fs"`，被根入口 `export *` 之后，
 * tsup 打包出的 `dist/index.js` 保留了 `import ... from "fs"`。Vite 会把 `fs` 外部化成
 * 空壳（__vite-browser-external），studio-web 一加载就抛
 * "Module \"fs\" has been externalized for browser compatibility"，整页白屏。
 *
 * 这里直接从源码走一遍相对导入图（不依赖 dist），任何一层出现 node 内置模块就失败。
 * node 专用模块必须从 `src/node.ts`（`@ufira/studio-application/node`）导出。
 */

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, "..", "src");

// `import ... from "./x"` / `export ... from "./x"` 整条语句（导入列表里可能有逗号但不是分号）。
const STATEMENT = /(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']/g;
const DYNAMIC = /import\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * 列出一条语句里真正会生成运行时代码的模块说明符。
 *
 * `import type` / `export type` 只存在于编译期，编译后整条语句被删掉，不会把模块
 * 拉进浏览器依赖图——`mcp-auth-state`、`mcp-events` 就是这样只引用 `McpStateStore`。
 */
function runtimeSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    if (/^\s*(?:import|export)\s+type\b/.test(match[0])) continue;
    specifiers.push(match[1]);
  }
  for (const match of text.matchAll(DYNAMIC)) specifiers.push(match[1]);
  return specifiers;
}

/** 把一个相对导入解析成 src 下的 .ts 文件。 */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 走完入口的运行时导入图，返回每个文件里出现的 node 内置模块。 */
function nodeBuiltinsReachableFrom(entry: string): Array<{ file: string; specifier: string }> {
  const found: Array<{ file: string; specifier: string }> = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const specifier of runtimeSpecifiers(text)) {
      if (specifier.startsWith("node:")) found.push({ file: file.slice(sourceRoot.length + 1), specifier });
      const relative = resolveRelative(file, specifier);
      if (relative) queue.push(relative);
    }
  }
  return found;
}

test("浏览器入口不引入 node 内置模块", () => {
  const builtins = nodeBuiltinsReachableFrom(join(sourceRoot, "index.ts"));
  assert.deepEqual(builtins, [], `根入口依赖了 node 内置模块：\n${builtins.map((b) => `  ${b.file} -> ${b.specifier}`).join("\n")}`);
});

test("node 专用入口提供共享状态存储", () => {
  const nodeEntry = readFileSync(join(sourceRoot, "node.ts"), "utf8");
  assert.match(nodeEntry, /\.\/mcp-store/);
  const builtins = nodeBuiltinsReachableFrom(join(sourceRoot, "node.ts"));
  assert.ok(builtins.length > 0, "node 入口应当能解析到 mcp-store 的 node:fs");
});
