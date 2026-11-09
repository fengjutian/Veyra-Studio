import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { PAGE_HELPERS } from "../visual/a11y-page";

/**
 * 页面侧标识与可访问名规则的单测。
 *
 * 这段脚本会注入浏览器执行，三处采集（DOM 扫描、焦点落点、AX 节点回查）**共用**
 * 同一份规则——一旦它们对同一个元素算出不同的标识，交叉验证就全废了。所以规则
 * 本身要单测，而不是只靠端到端跑一遍。
 */
const dom = new JSDOM(
  `<!doctype html><html><body>
    <button id="by-aria" data-audit-id="audit.first" data-node-id="node.first" aria-label="带 aria-label"></button>
    <button id="by-node" data-node-id="node.second"></button>
    <span id="label-text">标签文字</span>
    <button id="by-labelledby" aria-labelledby="label-text"></button>
    <button id="by-text">可见文字</button>
    <button id="by-title" title="标题文字"></button>
    <input id="by-placeholder" placeholder="占位文字" />
    <label for="by-label">包裹标签</label><input id="by-label" />
  </body></html>`,
  { runScripts: "outside-only" },
);

const win = dom.window as unknown as Record<string, any>;
win.eval(`${PAGE_HELPERS}\nwindow.__auditIdOf = auditIdOf; window.__accessibleNameOf = accessibleNameOf;`);

// 不关窗口的话 jsdom 会把事件循环吊住，整个测试文件要等十几秒才退出。
after(() => dom.window.close());

function auditIdOf(id: string): string {
  return win.__auditIdOf(win.document.getElementById(id));
}

function accessibleNameOf(id: string): string {
  return win.__accessibleNameOf(win.document.getElementById(id));
}

test("标识优先级：data-audit-id > data-node-id > id", () => {
  assert.equal(auditIdOf("by-aria"), "audit.first");
  assert.equal(auditIdOf("by-node"), "node.second");
  assert.equal(auditIdOf("by-text"), "#by-text");
});

test("没有稳定标识时退回「角色:文字」", () => {
  const button = win.document.createElement("button");
  button.setAttribute("role", "option");
  button.textContent = "卡片";
  win.document.body.appendChild(button);
  assert.equal(win.__auditIdOf(button), "option:卡片");
});

test("可访问名优先取 aria-label", () => {
  assert.equal(accessibleNameOf("by-aria"), "带 aria-label");
});

test("可访问名其次取 aria-labelledby", () => {
  assert.equal(accessibleNameOf("by-labelledby"), "标签文字");
});

test("可访问名再取可见文字、标题、占位符", () => {
  assert.equal(accessibleNameOf("by-text"), "可见文字");
  assert.equal(accessibleNameOf("by-title"), "标题文字");
  assert.equal(accessibleNameOf("by-placeholder"), "占位文字");
});

test("可访问名可以来自包裹它的 label", () => {
  assert.equal(accessibleNameOf("by-label"), "包裹标签");
});

test("什么都没有时可访问名是空串（这正是缺陷信号）", () => {
  const button = win.document.createElement("button");
  win.document.body.appendChild(button);
  assert.equal(win.__accessibleNameOf(button), "");
});
