import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  defaultAppearance,
  defaultLayout,
  lintDocument,
  lintSummary,
  type DesignDocument,
  type DesignNode,
} from "../src/index";

/**
 * 设计 lint。
 *
 * 与 `validateDocument()` 不同：lint 不阻止保存，只提示「会让设计系统腐坏」的问题；
 * 规则只在文档确实有对应 token 体系时才报告，避免给没有 token 的文档制造噪声。
 */

function node(id: string, overrides: Partial<DesignNode> = {}): DesignNode {
  return {
    id,
    type: "frame",
    name: id,
    parentId: "page:1",
    childIds: [],
    visible: true,
    locked: false,
    layout: defaultLayout(),
    appearance: defaultAppearance(),
    ...overrides,
  } as DesignNode;
}

function documentWith(nodes: DesignNode[], tokens: DesignDocument["tokens"] = {}): DesignDocument {
  const document = createDocument("doc:lint", "Lint");
  document.tokens = tokens;
  for (const item of nodes) document.nodes[item.id] = item;
  const roots = nodes.filter(item => item.parentId === "page:1");
  document.pages["page:1"]!.childIds = roots.map(item => item.id);
  for (const item of nodes) {
    if (item.parentId === "page:1") continue;
    const parent = document.nodes[item.parentId];
    if (parent) parent.childIds = [...parent.childIds, item.id];
  }
  return document;
}

const colorToken = { "gray.900": { type: "color" as const, value: "#111111" } };
const numberToken = { "space.md": { type: "number" as const, value: 16 } };

test("lint: 没有颜色 token 的文档不报硬编码填充", () => {
  const document = documentWith([node("frame:1", { appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] } })]);
  assert.deepEqual(lintDocument(document).filter(issue => issue.code === "hardcoded-fill"), []);
});

test("lint: 有颜色 token 时硬编码填充给提示，绑定后消失", () => {
  const hardcoded = node("frame:1", { appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] } });
  const bound = node("frame:2", {
    appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] },
    bindings: { fill: "gray.900" },
  });

  const loose = lintDocument(documentWith([hardcoded], colorToken));
  const issue = loose.find(item => item.code === "hardcoded-fill");
  assert.equal(issue?.nodeId, "frame:1");
  assert.equal(issue?.detail, "#ff0000");

  const bound_ = lintDocument(documentWith([bound], colorToken));
  assert.equal(bound_.some(item => item.code === "hardcoded-fill"), false);
});

test("lint: 通过别名绑定填充不算硬编码", () => {
  const document = documentWith(
    [node("frame:1", {
      appearance: { opacity: 1, fills: [{ type: "solid", color: "#ff0000" }] },
      bindings: { fill: "text.primary" },
    })],
    { ...colorToken, "text.primary": { type: "alias", value: "gray.900" } },
  );
  assert.equal(lintDocument(document).some(item => item.code === "hardcoded-fill"), false);
});

test("lint: 自动布局间距没绑数值 token 时提示", () => {
  const container = node("frame:1", { layout: { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 12 } });
  const bound = node("frame:2", { layout: { ...defaultLayout(), mode: "stack", direction: "vertical", gap: 12 }, bindings: { spacing: "space.md" } });

  const issues = lintDocument(documentWith([container], numberToken));
  assert.equal(issues.find(item => item.code === "unbound-spacing")?.detail, "12px");

  assert.equal(lintDocument(documentWith([bound], numberToken)).some(item => item.code === "unbound-spacing"), false);
  // 没有数值 token 时不报。
  assert.equal(lintDocument(documentWith([container])).some(item => item.code === "unbound-spacing"), false);
});

test("lint: 位置不在栅格上会警告，布局托管的子节点不检查", () => {
  const off = node("frame:1", { layout: { ...defaultLayout(), x: 13, y: 8 } });
  const issue = lintDocument(documentWith([off])).find(item => item.code === "off-grid");
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.detail, "x=13");

  // stack 子节点的位置由布局引擎决定，报它没有意义。
  const container = node("frame:stack", { layout: { ...defaultLayout(), mode: "stack", direction: "vertical" } });
  const child = node("frame:child", { parentId: "frame:stack", layout: { ...defaultLayout(), x: 13, y: 8 } });
  const document = documentWith([container, child]);
  assert.equal(lintDocument(document).some(item => item.code === "off-grid"), false);
});

test("lint: grid 选项为 1 时关闭栅格规则，也可以按规则关闭", () => {
  const off = node("frame:1", { layout: { ...defaultLayout(), x: 13 } });
  assert.equal(lintDocument(documentWith([off]), { grid: 1 }).some(item => item.code === "off-grid"), false);
  assert.equal(lintDocument(documentWith([off]), { rules: { "off-grid": false } }).some(item => item.code === "off-grid"), false);
});

test("lint: 同级重名只报一条，跨页不算同级", () => {
  const first = node("frame:1", { name: "Card" });
  const second = node("frame:2", { name: "Card" });
  const issues = lintDocument(documentWith([first, second])).filter(item => item.code === "duplicate-name");
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.nodeId, "frame:1");
  assert.match(issues[0]?.detail ?? "", /frame:1, frame:2/);

  const document = createDocument("doc:lint", "Lint");
  document.pages["page:1"]!.childIds = ["a"];
  document.nodes.a = node("a", { name: "Card" });
  document.pages["page:2"] = { id: "page:2", name: "Second", childIds: ["b"] } as never;
  document.pageOrder.push("page:2");
  document.nodes.b = node("b", { name: "Card", parentId: "page:2" });
  assert.equal(lintDocument(document).some(item => item.code === "duplicate-name"), false);
});

test("lint: 汇总按严重程度计数", () => {
  const summary = lintSummary([
    { code: "off-grid", severity: "warning", message: "" },
    { code: "duplicate-name", severity: "info", message: "" },
  ]);
  assert.deepEqual(summary, { warnings: 1, infos: 1, total: 2 });
});

test("lint: 空文档没有结论", () => {
  assert.deepEqual(lintDocument(createDocument("doc:empty", "Empty")), []);
});
