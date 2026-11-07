import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { JSDOM } from "jsdom";

/**
 * 应用内弹窗的回归测试。
 *
 * 覆盖三件事：确认框在点「确定」时必须 resolve true（而不是被 Radix 的关闭动作
 * 覆盖成 false）、三选一弹窗要返回被选项的值、取消要 resolve null / false。
 */

let dom: JSDOM;
let react: typeof import("react");
let dialogs: typeof import("../src/ui/dialogs");
let paint: (element: unknown) => void;
let teardown: () => void;

interface DialogApi {
  confirm(request: { title: string; description?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean>;
  choice(request: { title: string; description?: string; options: { value: string; label: string; destructive?: boolean }[]; cancelLabel?: string }): Promise<string | null>;
  form(request: { title: string; description?: string; fields: { key: string; label: string; defaultValue?: string }[]; validate?: (values: Record<string, string>) => string | undefined }): Promise<Record<string, string> | null>;
}

let api: DialogApi;

before(async () => {
  dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, { pretendToBeVisual: true, url: "http://localhost/" });
  const { window } = dom;
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.window = window;
  scope.document = window.document;
  scope.HTMLElement = window.HTMLElement;
  scope.Element = window.Element;
  scope.Node = window.Node;
  scope.Event = window.Event;
  scope.MouseEvent = window.MouseEvent;
  scope.KeyboardEvent = window.KeyboardEvent;
  scope.CustomEvent = window.CustomEvent;
  scope.DOMRect = window.DOMRect;
  scope.DOMRectReadOnly = window.DOMRectReadOnly;
  scope.MutationObserver = window.MutationObserver;
  scope.IntersectionObserver = window.IntersectionObserver;
  scope.getComputedStyle = window.getComputedStyle.bind(window);
  scope.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  scope.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true, writable: true });
  scope.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  if (!window.Element.prototype.setPointerCapture) {
    window.Element.prototype.setPointerCapture = () => undefined;
    window.Element.prototype.releasePointerCapture = () => undefined;
    window.Element.prototype.hasPointerCapture = () => false;
  }
  if (!window.Element.prototype.scrollIntoView) window.Element.prototype.scrollIntoView = () => undefined;

  react = await import("react");
  const { createRoot } = await import("react-dom/client");
  dialogs = await import("../src/ui/dialogs");
  const container = window.document.getElementById("root")!;
  const client = createRoot(container);
  paint = (element: unknown) => { react.act(() => { client.render(element); }); };
  teardown = () => { react.act(() => { client.unmount(); }); window.close(); };
});

after(() => teardown?.());

function Harness() {
  api = {
    confirm: dialogs.useConfirm(),
    choice: dialogs.useChoice?.(),
    form: dialogs.useForm?.(),
  } as DialogApi;
  return null;
}

function mount(): void {
  paint(react.createElement(dialogs.DialogProvider, null, react.createElement(Harness)));
}

const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

function buttonByText(text: string): HTMLElement {
  const buttons = [...dom.window.document.querySelectorAll<HTMLElement>("button")];
  const found = buttons.find(button => button.textContent?.trim() === text);
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found;
}

function click(text: string): void {
  react.act(() => {
    buttonByText(text).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** 弹窗的 promise 可能永远不 resolve，加个超时让失败更快暴露。 */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时未返回`)), 2000)),
  ]);
}

test("确认框点「确定」返回 true", async () => {
  mount();
  let pending!: Promise<boolean>;
  react.act(() => { pending = api.confirm({ title: "删除项目", description: "不可撤销" }); });
  await tick();
  click("确定");
  assert.equal(await withTimeout(pending, "确认框"), true);
});

test("确认框点「取消」返回 false", async () => {
  mount();
  let pending!: Promise<boolean>;
  react.act(() => { pending = api.confirm({ title: "删除项目", cancelLabel: "算了" }); });
  await tick();
  click("算了");
  assert.equal(await withTimeout(pending, "确认框"), false);
});

test("三选一弹窗返回被选项的值", async () => {
  mount();
  let pending!: Promise<string | null>;
  react.act(() => {
    pending = api.choice({
      title: "已存在同名项目",
      description: "本地已有同名项目",
      options: [
        { value: "replace", label: "覆盖原项目", destructive: true },
        { value: "copy", label: "作为新项目导入" },
      ],
    });
  });
  await tick();
  click("作为新项目导入");
  assert.equal(await withTimeout(pending, "三选一弹窗"), "copy");
});

test("三选一弹窗点「取消」返回 null", async () => {
  mount();
  let pending!: Promise<string | null>;
  react.act(() => {
    pending = api.choice({
      title: "已存在同名项目",
      options: [{ value: "replace", label: "覆盖原项目" }],
    });
  });
  await tick();
  click("取消");
  assert.equal(await withTimeout(pending, "三选一弹窗"), null);
});

test("表单弹窗返回各字段的值", async () => {
  mount();
  let pending!: Promise<Record<string, string> | null>;
  react.act(() => {
    pending = api.form({
      title: "导入 2 个项目",
      fields: [
        { key: "name:0", label: "a.json", defaultValue: "首页" },
        { key: "name:1", label: "b.json", defaultValue: "详情页" },
      ],
    });
  });
  await tick();
  click("确定");
  const values = await withTimeout(pending, "表单弹窗");
  assert.deepEqual(values, { "name:0": "首页", "name:1": "详情页" });
});

test("表单弹窗校验不通过时不提交", async () => {
  mount();
  let pending!: Promise<Record<string, string> | null>;
  let settled = false;
  react.act(() => {
    pending = api.form({
      title: "导入 1 个项目",
      fields: [{ key: "name:0", label: "a.json", defaultValue: "首页" }],
      validate: values => (values["name:0"] === "首页" ? "已经有同名项目了" : undefined),
    }).then(value => { settled = true; return value; });
  });
  await tick();
  click("确定");
  await tick();
  assert.equal(settled, false, "校验不通过时弹窗不应关闭");
  assert.ok(dom.window.document.querySelector(".dialog-error"), "应该显示错误文案");
  click("取消");
  assert.equal(await withTimeout(pending, "表单弹窗"), null);
});
