import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import { PAGE_HELPERS } from "../visual/a11y-page";

/**
 * 页面侧采集脚本的单测。
 *
 * 这段脚本会注入浏览器执行，负责三件事：给元素一个**节点身份**、算出**可访问名**、
 * 判断**能不能 Tab 到**。三处采集（DOM 扫描、焦点落点、AX 节点回查）共用它，
 * 所以规则本身要单测，而不是只靠端到端跑一遍。
 *
 * 节点身份尤其关键：真实界面里几十个图标按钮的文字都是空串，按文字拼标识会
 * 全部塌缩成同一个 id，交叉验证就成了拿苹果比橘子。
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
    <label id="select-label">对齐<select id="by-select"><option>左对齐</option><option>居中</option></select></label>
    <button id="early" tabindex="3">提前</button>
    <button id="disabled-one" disabled>禁用</button>
    <button id="hidden-one" style="display:none">隐藏</button>
    <div id="inert-host" inert><button id="inert-one">惰性</button></div>
  </body></html>`,
  { runScripts: "outside-only" },
);

const win = dom.window as unknown as Record<string, any>;
// jsdom 没有排版引擎，getClientRects 永远是空的——那会让所有元素都被判成
// 「不可见」。这里补一个假的矩形，等价于「页面已经排好版」。
win.Element.prototype.getClientRects = function () {
  return [{ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }];
};
win.eval(
  `${PAGE_HELPERS}\nwindow.__nodeKeyOf = nodeKeyOf; window.__accessibleNameOf = accessibleNameOf; window.__isTabbable = isTabbable; window.__domTextOf = domTextOf; window.__firstInTabOrder = firstInTabOrder; window.__ancestorKeysOf = ancestorKeysOf;`,
);

// 不关窗口的话 jsdom 会把事件循环吊住，整个测试文件要等十几秒才退出。
after(() => dom.window.close());

function nodeKeyOf(id: string): string {
  return win.__nodeKeyOf(win.document.getElementById(id));
}

function accessibleNameOf(id: string): string {
  return win.__accessibleNameOf(win.document.getElementById(id));
}

function isTabbable(id: string): boolean {
  return win.__isTabbable(win.document.getElementById(id));
}

test("同一个元素永远拿到同一个节点身份", () => {
  const key = nodeKeyOf("by-text");
  assert.ok(key);
  assert.equal(nodeKeyOf("by-text"), key);
});

test("不同元素拿到不同节点身份", () => {
  assert.notEqual(nodeKeyOf("by-text"), nodeKeyOf("by-title"));
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

test("label 的文本不含被标注控件自己的内容", () => {
  // HTML-AAM：<label>对齐<select><option>左对齐</option>…</select></label>
  // 的可访问名是「对齐」，不是「对齐左对齐居中右对齐」。
  assert.equal(accessibleNameOf("by-select"), "对齐");
});

test("Tab 顺序的第一个元素是正 tabindex 的那个", () => {
  // HTML 规定正 tabindex 排在所有 tabindex=0 的元素**前面**。
  // 用 DOM 顺序当遍历起点会直接跳过它们。
  const first = win.__firstInTabOrder();
  assert.equal(first?.id, "early");
});

test("祖先链给的是内容键（重渲染后仍然稳定）", () => {
  const label = win.document.getElementById("select-label");
  const keys = win.__ancestorKeysOf(win.document.getElementById("by-select"));
  assert.ok(Array.isArray(keys));
  // 最近一层祖先的键由它自己的可访问名派生，而不是节点身份。
  assert.equal(keys[0], win.__domTextOf(label));
});

test("什么都没有时可访问名是空串（这正是缺陷信号）", () => {
  const button = win.document.createElement("button");
  win.document.body.appendChild(button);
  assert.equal(win.__accessibleNameOf(button), "");
});

test("文字里的连续空白会被压成一个空格", () => {
  const block = win.document.createElement("div");
  block.textContent = "  多个   空白  ";
  win.document.body.appendChild(block);
  assert.equal(win.__domTextOf(block), "多个 空白");
});

test("禁用、隐藏与 inert 里的元素不可 Tab", () => {
  assert.equal(isTabbable("by-text"), true);
  assert.equal(isTabbable("disabled-one"), false);
  assert.equal(isTabbable("hidden-one"), false);
  assert.equal(isTabbable("inert-one"), false);
});

test("普通 div 不可 Tab（没有 tabindex 就不在 Tab 序列里）", () => {
  const block = win.document.createElement("div");
  win.document.body.appendChild(block);
  assert.equal(win.__isTabbable(block), false);
});
