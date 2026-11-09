import assert from "node:assert/strict";
import test from "node:test";
import {
  auditA11y,
  buildA11yBaseline,
  compareA11yBaseline,
  formatIssue,
  summarizeIssues,
  type A11yAuditInput,
  type A11yDomItem,
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
    // 内容键：跨采集时刻的关联依据（重渲染后不变）。
    key: auditId,
    // 默认「同名即同节点」，需要区分时单独传 nodeKey。
    nodeKey: auditId,
    // 祖先链（内容键）：用来认「焦点被重定向进了某个复合控件」。
    ancestorKeys: [],
    tabIndex: 0,
    focusIndicator: true,
    ...overrides,
  };
}

function ax(auditId: string, overrides: Partial<AxNode> = {}): AxNode {
  return {
    role: "button",
    name: auditId,
    auditId,
    key: auditId,
    nodeKey: auditId,
    ancestorKeys: [],
    tag: "button",
    focusable: true,
    ...overrides,
  };
}

function domItem(key: string, overrides: Partial<A11yDomItem> = {}): A11yDomItem {
  return { nodeKey: key, key, role: "", ancestorKeys: [], ...overrides };
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
    domItems: [domItem("tool.select"), domItem("canvas.option"), domItem("inspector.name")],
    domFocusableAfter: ["tool.select", "canvas.option", "inspector.name"],
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
  input.domItems.push(domItem("hidden.by.keyboard"));
  input.domFocusableOrder.push("hidden.by.keyboard");
  input.domFocusableAfter!.push("hidden.by.keyboard");
  assert.ok(codes(input).includes("unreachable-by-keyboard"));
});

test("瞬时出现的控件不算「键盘到不了」（遍历前后都在才算数）", () => {
  const input = cleanInput();
  // 只在遍历前存在、遍历后消失（界面在遍历途中变了）→ 瞬时状态，不是缺陷。
  input.domItems.push(domItem("transient"));
  input.domFocusableOrder.push("transient");
  assert.ok(!codes(input).includes("unreachable-by-keyboard"));
});

test("复合控件是焦点代理时不报「键盘到不了」", () => {
  const input = cleanInput();
  // Radix 的分段栏自己 tabindex=0，Tab 落上去后焦点转给了内部的标签页。
  input.domItems.push(domItem("右侧面板分段", { nodeKey: "n-tablist", role: "tablist" }));
  input.domFocusableOrder.push("右侧面板分段");
  input.domFocusableAfter!.push("右侧面板分段");
  input.focusSequence.push(visit(4, "tab:属性", { nodeKey: "n-trigger", ancestorKeys: ["右侧面板分段"] }));
  assert.ok(!codes(input).includes("unreachable-by-keyboard"));
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

test("AX 里可聚焦的同名节点比键盘能到的多，会被抓出来（两边交叉验证）", () => {
  const input = cleanInput();
  // 两个同名（都是「固定」的单选）在 AX 树里可聚焦，但键盘只到得了一个。
  input.axNodes.push(ax("radio:固定", { name: "固定", role: "radio" }));
  input.axNodes.push(ax("radio:固定", { name: "固定", role: "radio" }));
  input.domItems.push(domItem("radio:固定", { nodeKey: "n-radio" }));
  input.domFocusableOrder.push("radio:固定");
  input.domFocusableAfter!.push("radio:固定");
  input.focusSequence.push(visit(4, "radio:固定", { nodeKey: "n-radio" }));
  assert.ok(codes(input).includes("ax-keyboard-mismatch"));
});

test("没有可见焦点指示会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence[0]!.focusIndicator = false;
  assert.ok(codes(input).includes("no-focus-indicator"));
});

test("焦点指示「未知」时不算缺陷（拿不到基准 ≠ 没有指示）", () => {
  const input = cleanInput();
  // 元素是遍历途中才出现的，采集不到「聚焦前」的样式基准——这是未知，不是缺陷。
  input.focusSequence[0]!.focusIndicator = undefined;
  assert.ok(!codes(input).includes("no-focus-indicator"));
});

test("焦点在同一个元素上反复打转会被抓出来", () => {
  const input = cleanInput();
  input.focusSequence = [input.focusSequence[0]!, input.focusSequence[0]!, input.focusSequence[1]!];
  assert.ok(codes(input).includes("focus-trap"));
});

test("同名但不同的元素不算焦点陷阱", () => {
  const input = cleanInput();
  // 真实界面里几十个图标按钮同名是常态：它们是不同节点，不是被困住。
  input.focusSequence = [
    visit(1, "button:删除", { nodeKey: "n1" }),
    visit(2, "button:删除", { nodeKey: "n2" }),
    visit(3, "button:删除", { nodeKey: "n3" }),
  ];
  input.domFocusableOrder = ["button:删除", "button:删除", "button:删除"];
  input.domItems = [domItem("button:删除", { nodeKey: "n1" }), domItem("button:删除", { nodeKey: "n2" }), domItem("button:删除", { nodeKey: "n3" })];
  input.domFocusableAfter = input.domFocusableOrder;
  input.axNodes = [];
  assert.ok(!codes(input).includes("focus-trap"));
});

test("同名控件数量对不上才算键盘到不了", () => {
  const input = cleanInput();
  input.domItems.push(domItem("button:删除", { nodeKey: "n1" }), domItem("button:删除", { nodeKey: "n2" }));
  input.domFocusableOrder.push("button:删除", "button:删除");
  input.domFocusableAfter!.push("button:删除", "button:删除");
  input.focusSequence = [visit(1, "tool.select"), visit(2, "button:删除", { nodeKey: "n1" })];
  input.axNodes = [];
  assert.ok(codes(input).includes("unreachable-by-keyboard"));
});

test("落点比 DOM 可聚焦元素多、但都是不同元素时不算焦点陷阱", () => {
  const input = cleanInput();
  input.focusSequence = [
    ...input.focusSequence,
    visit(4, "extra.one", { nodeKey: "x1" }),
    visit(5, "extra.two", { nodeKey: "x2" }),
  ];
  assert.ok(!codes(input).includes("focus-trap"));
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
