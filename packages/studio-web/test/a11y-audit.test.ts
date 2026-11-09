import assert from "node:assert/strict";
import test from "node:test";
import {
  auditA11y,
  buildA11yBaseline,
  compareA11yBaseline,
  formatIssue,
  summarizeIssues,
  type A11yAuditInput,
  type AxNode,
  type FocusVisit,
} from "../src/renderer/a11y-audit";

/**
 * 可访问性规则层的单测。
 *
 * 重点是**阴性对照**：每条规则都要有一条「页面真的坏了」的输入，并断言规则
 * 真的会报出来。只有正例（干净页面不报）的话，规则可能压根没生效，检查脚本
 * 就会一路绿灯——这正是这套规则本身要防的事。
 */

function visit(order: number, auditId: string, overrides: Partial<FocusVisit> = {}): FocusVisit {
  return {
    order,
    tag: "button",
    role: "button",
    name: auditId,
    auditId,
    tabIndex: 0,
    focusIndicator: true,
    ...overrides,
  };
}

function ax(auditId: string, overrides: Partial<AxNode> = {}): AxNode {
  return { role: "button", name: auditId, auditId, tag: "button", focusable: true, ...overrides };
}

/** 一个干净页面：工具栏按钮 + 画布 listbox + 属性面板输入框。 */
function cleanInput(): A11yAuditInput {
  return {
    focusSequence: [
      visit(1, "tool.select", { role: "button", name: "选择" }),
      visit(2, "canvas.option", { role: "option", name: "card" }),
      visit(3, "inspector.name", { tag: "input", role: "textbox", name: "名称" }),
    ],
    axNodes: [
      ax("tool.select", { name: "选择" }),
      ax("canvas.option", { role: "option", name: "card", tag: "li" }),
      ax("inspector.name", { role: "textbox", name: "名称", tag: "input" }),
      ax("page.static", { role: "StaticText", name: "画布节点", focusable: false }),
    ],
    domFocusableOrder: ["tool.select", "canvas.option", "inspector.name"],
  };
}

function codes(input: A11yAuditInput): string[] {
  return auditA11y(input).map(issue => issue.code);
}

test("干净的页面不报任何问题", () => {
  const issues = auditA11y(cleanInput());
  assert.deepEqual(issues, []);
  assert.deepEqual(summarizeIssues(issues), { errors: 0, warnings: 0, ok: true });
});

test("可聚焦元素没有可访问名会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence[1]!.name = "   ";
  assert.ok(codes(input).includes("missing-accessible-name"));
});

test("正 tabindex 会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence[0]!.tabIndex = 3;
  assert.ok(codes(input).includes("positive-tabindex"));
});

test("DOM 里可聚焦但 Tab 到不了的元素会被抓出来", () => {
  const input = cleanInput();
  input.domFocusableOrder.push("hidden.by.keyboard");
  assert.ok(codes(input).includes("unreachable-by-keyboard"));
});

test("Tab 顺序与 DOM 顺序颠倒会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence = [input.focusSequence[0]!, input.focusSequence[2]!, input.focusSequence[1]!];
  assert.ok(codes(input).includes("focus-order-mismatch"));
});

test("AX 树里交互角色没有名字会被抓出来", () => {
  const input = cleanInput();
  input.axNodes[0]!.name = "";
  assert.ok(codes(input).includes("ax-name-missing"));
});

test("AX 说可聚焦、键盘到不了的元素会被抓出来（两边交叉验证）", () => {
  const input = cleanInput();
  input.axNodes.push(ax("ax.only", { name: "只有读屏看得见" }));
  assert.ok(codes(input).includes("ax-keyboard-mismatch"));
});

test("没有可见焦点指示会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence[0]!.focusIndicator = false;
  assert.ok(codes(input).includes("no-focus-indicator"));
});

test("焦点在同一个元素上反复打转会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence = [input.focusSequence[0]!, input.focusSequence[0]!, input.focusSequence[1]!];
  assert.ok(codes(input).includes("focus-trap"));
});

test("落点数量超过 DOM 可聚焦元素数量会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence = [...input.focusSequence, visit(4, "extra.one"), visit(5, "extra.two")];
  input.domFocusableOrder = ["tool.select", "canvas.option", "inspector.name"];
  assert.ok(codes(input).includes("focus-trap"));
});

test("复合控件内方向键没走完会被抓出来", () => {
  const input = cleanInput();
  input.arrowTraversal = { visited: ["canvas.option"], expected: ["canvas.option", "canvas.option2"] };
  assert.ok(codes(input).includes("arrow-traversal-incomplete"));
});

test("方向键把焦点带出控件会被抓出来", () => {
  const input = cleanInput();
  input.arrowTraversal = { visited: ["canvas.option", "tool.select"], expected: ["canvas.option"] };
  assert.ok(codes(input).includes("arrow-traversal-escape"));
});

test("错误排在警告前面", () => {
  const input = cleanInput();
  input.focusSequence[0]!.focusIndicator = false;
  input.focusSequence[1]!.name = "";
  const issues = auditA11y(input);
  assert.equal(issues[0]?.severity, "error");
  assert.equal(issues[issues.length - 1]?.severity, "warning");
});

test("issue 能读成一行人话", () => {
  const input = cleanInput();
  input.focusSequence[1]!.name = "";
  const text = formatIssue(auditA11y(input)[0]!);
  assert.match(text, /错误 missing-accessible-name/);
  assert.match(text, /canvas\.option/);
});

test("基线比对能看出焦点顺序与语义变化", () => {
  const baseline = buildA11yBaseline(
    { os: "win32", browser: "Chrome 156", generatedAt: "2026-11-09T00:00:00.000Z" },
    [visit(1, "tool.select", { role: "button", name: "选择" })],
    [ax("tool.select", { name: "选择" })],
  );
  const current = buildA11yBaseline(
    { os: "win32", browser: "Chrome 156", generatedAt: "2026-11-09T01:00:00.000Z" },
    [visit(1, "tool.select", { role: "button", name: "选取" })],
    [ax("tool.select", { name: "选取" })],
  );
  const diff = compareA11yBaseline(baseline, current);
  assert.equal(diff.focusChanges.length, 1);
  assert.match(diff.focusChanges[0]!, /选择/);
  assert.match(diff.focusChanges[0]!, /选取/);
  assert.equal(diff.announcementChanges.length, 1);
});

test("基线比对在语义没变时是空的", () => {
  const baseline = buildA11yBaseline({ os: "win32", generatedAt: "x" }, cleanInput().focusSequence, cleanInput().axNodes);
  const current = buildA11yBaseline({ os: "linux", generatedAt: "y" }, cleanInput().focusSequence, cleanInput().axNodes);
  const diff = compareA11yBaseline(baseline, current);
  assert.deepEqual(diff.focusChanges, []);
  assert.deepEqual(diff.announcementChanges, []);
});
