import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Hook 顺序静态检查。
 *
 * 背景：`App` 里曾经把 `useRef` 写在「项目加载完成」的早退之后。首帧还没文档、走的
 * 是加载分支，加载完成后才多调一个 hook —— React 直接抛 #310 并把整棵树卸载，
 * 表现是浏览器里白屏（`<div id="root">` 空）。这类 bug 单测测不出来：纯函数测试
 * 根本不挂 React，而视觉探针只会报一句「工作台没有渲染出来」。
 *
 * 规则：一个函数体内，如果某个 hook 调用在源码位置上排在某个「本函数作用域内的
 * return」之后，就是违规 —— 说明存在一条执行路径会先 return 掉、后少调 hook。
 * 嵌套函数（子组件、useEffect 回调）内部的 return 不算。
 */

const HOOK_NAMES = new Set([
  "useState",
  "useRef",
  "useEffect",
  "useLayoutEffect",
  "useMemo",
  "useCallback",
  "useReducer",
  "useId",
  "useSyncExternalStore",
  "useImperativeHandle",
  "useDebugValue",
  "useTransition",
  "useDeferredValue",
  "useContext",
]);

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

type Violation = {
  file: string;
  line: number;
  hook: string;
  returnLine: number;
  functionName: string;
};

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") || full.endsWith(".tsx")) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** 判断一个调用是不是 hook 调用：既认 `useState(...)`，也认 `React.useState(...)`。 */
function hookNameOf(call: ts.CallExpression): string | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression) && HOOK_NAMES.has(expression.text)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && HOOK_NAMES.has(expression.name.text)) return expression.name.text;
  return undefined;
}

function functionNameOf(node: ts.FunctionLikeDeclaration): string {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<匿名>";
}

/**
 * 收集一个函数体内「本作用域」的 hook 调用与 return。
 *
 * 嵌套的函数（子组件、回调）会另起作用域，它们的 hook 与 return 都不算在这个函数头上，
 * 所以遍历时遇到嵌套函数就整个跳过。
 */
function collectScopeEvents(body: ts.Node): { hooks: { name: string; pos: number }[]; returns: number[] } {
  const hooks: { name: string; pos: number }[] = [];
  const returns: { pos: number; end: number }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const name = hookNameOf(node);
      if (name) hooks.push({ name, pos: node.getStart() });
    }
    if (ts.isReturnStatement(node)) returns.push({ pos: node.getStart(), end: node.end });
    node.forEachChild(visit);
  };

  body.forEachChild(visit);
  return { hooks, returns };
}

function scanFile(file: string): Violation[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: Violation[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const { hooks, returns } = collectScopeEvents(node.body);
      for (const hook of hooks) {
        // `return useMemo(...)` 这种「return 表达式里就带着 hook」不算违规——hook 依然
        // 每次渲染都调，顺序不变。只有「先 return 掉、hook 在后面」的写法才会少调。
        const blocking = returns.filter(item => item.pos < hook.pos && item.end <= hook.pos);
        if (!blocking.length) continue;
        const { line } = source.getLineAndCharacterOfPosition(hook.pos);
        const returnLine = source.getLineAndCharacterOfPosition(Math.max(...blocking.map(item => item.pos))).line + 1;
        violations.push({
          file: relative(SRC_ROOT, file).replace(/\\/g, "/"),
          line: line + 1,
          hook: hook.name,
          returnLine,
          functionName: functionNameOf(node),
        });
      }
    }
    node.forEachChild(visit);
  };

  source.forEachChild(visit);
  return violations;
}

test("源码里没有「早退之后才调用 hook」的写法", () => {
  const violations = sourceFiles(SRC_ROOT).flatMap(scanFile);
  assert.deepEqual(
    violations,
    [],
    violations
      .map(v => `${v.file}:${v.line} —— 函数 ${v.functionName}() 在第 ${v.returnLine} 行 return 之后才调用 ${v.hook}()`)
      .join("\n"),
  );
});

test("main.tsx 的 App 里没有落在加载早退之后的 hook", () => {
  const file = join(SRC_ROOT, "main.tsx");
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let app: ts.FunctionLikeDeclaration | undefined;
  source.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "App") app = node;
  });
  assert.ok(app?.body, "main.tsx 里应能定位到 App 组件");

  const { hooks, returns } = collectScopeEvents(app!.body!);
  for (const hook of hooks) {
    const blocking = returns.filter(item => item.pos < hook.pos && item.end <= hook.pos);
    assert.deepEqual(
      blocking.map(item => source.getLineAndCharacterOfPosition(item.pos).line + 1),
      [],
      `App() 里第 ${source.getLineAndCharacterOfPosition(hook.pos).line + 1} 行的 ${hook.name}() 排在早退之后`,
    );
  }
});
